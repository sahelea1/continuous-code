/**
 * Workflow engine — the load-bearing core (plan §A.0, §A.1, §B).
 *
 * Mirrors Claude Code's `agent()/parallel()/pipeline()/phase()/log()` API but
 * grounds every spawn/run/observe call in the VERIFIED OpenCode v1 SDK already
 * wired into the plugin (plan §A.0):
 *
 *   spawn child  = client.session.create({ body: { parentID, title } })
 *                    -> { data: Session }      (Session.id is the child id)
 *   run one turn = client.session.prompt({
 *                    path: { id },
 *                    body: { parts:[{type:"text",text}], agent, model:{providerID,modelID}, system },
 *                  }) -> { data: { info: AssistantMessage, parts: Part[] } }
 *   final text   = parts.filter(p=>p.type==="text").map(p=>p.text).join("")
 *
 * Parallelism is REAL fan-out: `Promise.allSettled` over N independent
 * `session.prompt` HTTP turns on N child sessions (plan §A.0). A small counting
 * semaphore caps in-flight turns at `config.concurrency || min(16,max(2,cores-2))`.
 *
 * Semantics (copied from web-analysis §3/§12, plan §A.1):
 *   - agent(prompt, opts): fresh child session per call; brief as `system`,
 *     context-store injection prepended to the prompt; returns final text, or a
 *     schema-validated object when `opts.schema` is given (retry ≤2). Stores the
 *     result as an artifact and emits agent.start/activity/done events.
 *   - parallel(thunks): hard barrier; rejections map to `null` (Promise.allSettled).
 *   - pipeline(items, ...stages): NO barrier — a streaming scheduler. Item N+1
 *     enters stage 1 the moment item N leaves it; per-item try/catch -> the item
 *     becomes `null` and stops flowing. Later stages receive (prev, originalItem,
 *     index).
 *
 * Never-throw discipline (matches src/watchdog/watchdog.ts): every SDK call and
 * every scheduler body is wrapped so a single failed turn degrades to `null`
 * rather than rejecting the whole run. A lifetime `maxAgents` cap stops runaway
 * fan-out. Registry register/deregister bracket every turn for the drift loop.
 */
import { cpus } from "os"
import type { PluginInput } from "@opencode-ai/plugin"
import {
  ContextStore,
  estimateTokens,
  headTailSummary,
  type WorkflowBrief,
} from "./context-store.js"
import { ModelResolver } from "./model-resolver.js"
import { workflowRegistry, WorkflowRegistry, type ActiveChild } from "./registry.js"
import { uiBus } from "./ui-bus.js"
import type { WorkflowConfig } from "./config.js"
import type { WorkflowEvent } from "./types.js"

type EngineClient = PluginInput["client"]

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Effort carried through the engine (never sent per-prompt; see model-resolver). */
export type Effort = "low" | "medium" | "high" | "max"

/** Options for a single `agent()` call. */
export interface AgentOptions {
  /** OpenCode agent type the turn runs as (e.g. "implementer"). Default "general". */
  agentType?: string
  /** CC-style shorthand or "{providerID}:{modelID}" or "inherit". */
  model?: string
  /** Effort hint — mapped to a variant agent by the resolver, never per-prompt. */
  effort?: Effort
  /** Human label: child session title + artifact key + dashboard row. */
  label?: string
  /** Phase index this agent belongs to (for events / artifact bucketing). */
  phase?: number
  /** Upstream artifact refs to inject ("label", "phase:N", "@full:label"). */
  contextRefs?: string[]
  /**
   * When present, the result is parsed + lightly validated against this minimal
   * JSON-schema (required keys / primitive types). On mismatch the turn is
   * retried up to `schemaRetries` times with a "return JSON matching schema" nudge.
   */
  schema?: JsonSchema
  /** Max schema-validation retries. Default 2. */
  schemaRetries?: number
}

/** Result of an `agent()` call. */
export interface AgentResult<T = unknown> {
  /** The agent's final text (always present, even when a schema was requested). */
  text: string
  /** Parsed + validated object when `opts.schema` was given and parsing succeeded. */
  value: T | null
  /** Artifact id stored in the context store. */
  artifactId: string
  /** The child session id used for this turn. */
  sessionId: string
  /** Whether the turn completed without throwing. */
  ok: boolean
  /** chars/4 token estimate of the final text. */
  tokensEst: number
  /** Wall-clock duration of the turn (ms). */
  durationMs: number
}

/** A thunk returning a promise — the unit of `parallel()`. */
export type Thunk<T> = () => Promise<T>

/**
 * A pipeline stage: receives the previous stage's output (`prev`), the original
 * item, and its index; returns this stage's output (or throws to drop the item).
 */
export type Stage<P, N> = (prev: P, originalItem: string, index: number) => Promise<N>

/** Minimal JSON-schema subset the engine validates (no AJV dep; plan §E.5). */
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "boolean"
  /** For objects: required top-level keys. */
  required?: string[]
  /** For objects: per-key primitive type expectations. */
  properties?: Record<string, { type?: "string" | "number" | "boolean" | "object" | "array" }>
}

/** The context an engine instance binds its primitives to. */
export interface WorkflowContext {
  client: EngineClient
  /** Immutable shared brief (context-store flavor: task/directory/constraints/dag). */
  brief: WorkflowBrief
  store: ContextStore
  registry: WorkflowRegistry
  bus: typeof uiBus
  config: WorkflowConfig
  /** Stable id for this run (used by the registry + dashboard). */
  runId: string
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * A bound workflow engine. One instance per run. Construct it with a
 * {@link WorkflowContext}; call its primitives from the tool / spec interpreter.
 */
export class WorkflowEngine {
  private readonly ctx: WorkflowContext
  private readonly resolver: ModelResolver
  private readonly sem: Semaphore
  /** Lifetime agent counter, capped at config.maxAgents. */
  private agentsStarted = 0
  /** A monotonic per-run id source for child titles / artifact disambiguation. */
  private seq = 0

  constructor(ctx: WorkflowContext, resolver?: ModelResolver) {
    this.ctx = ctx
    this.resolver =
      resolver ??
      new ModelResolver(ctx.client, { directory: ctx.brief.directory })
    this.sem = new Semaphore(computeConcurrency(ctx.config.concurrency))
    this.ctx.registry.startRun(ctx.runId, ctx.brief.task || ctx.runId, ctx.brief.directory)
  }

  /** Effective concurrency limit (resolved at construction). */
  get concurrency(): number {
    return this.sem.capacity
  }

  /** How many agent turns have been started this run. */
  get started(): number {
    return this.agentsStarted
  }

  // -- log -------------------------------------------------------------------

  /**
   * Append a one-liner to the blackboard AND surface it to the OpenCode log.
   * Mirrors CC's `log()`; never throws.
   */
  log(message: string): void {
    if (!message) return
    try {
      this.ctx.store.addNote(message)
    } catch {
      /* note storage must never throw */
    }
    try {
      void this.ctx.client.app.log({
        body: { service: "workflow", level: "info", message },
      })
    } catch {
      /* logging must never throw */
    }
  }

  // -- phase -----------------------------------------------------------------

  /**
   * Announce a phase boundary on the UI bus. Returns the phase index it emitted
   * for (callers usually pass an explicit index). Pure signalling; no awaiting.
   */
  phase(
    phaseIdx: number,
    title: string,
    mode: "parallel" | "pipeline" | "single",
    agentCount: number,
  ): number {
    this.emit({
      type: "phase.start",
      phaseIdx,
      title,
      mode,
      agentCount,
      timestamp: new Date().toISOString(),
    })
    return phaseIdx
  }

  // -- agent -----------------------------------------------------------------

  /**
   * Run ONE agent turn end-to-end and return its result.
   *
   * Flow (every step grounded in the verified v1 SDK, plan §A.0):
   *   1. enforce the lifetime maxAgents cap;
   *   2. acquire a concurrency slot (semaphore);
   *   3. resolve model+agentType (modelID-vs-id quirk centralized in resolver);
   *   4. create a fresh child session under the run's parent;
   *   5. register the child for the drift loop; emit agent.start;
   *   6. build the prompt = context-store injection + the caller's prompt;
   *      build `system` = the immutable brief;
   *   7. session.prompt(...) -> extract final text; on schema, validate + retry ≤2;
   *   8. store an artifact; emit agent.activity (preview) + agent.done;
   *   9. ALWAYS deregister + release the slot.
   *
   * Never throws: any failure yields `{ ok:false, text:"", value:null }`.
   */
  async agent<T = unknown>(prompt: string, opts: AgentOptions = {}): Promise<AgentResult<T>> {
    const label = opts.label?.trim() || `agent-${++this.seq}`
    const phase = typeof opts.phase === "number" ? opts.phase : 0
    const agentTypeReq = opts.agentType?.trim() || "general"
    const started = Date.now()

    // Lifetime cap — refuse to start beyond maxAgents (plan §B).
    if (this.agentsStarted >= this.ctx.config.maxAgents) {
      this.log(`[engine] maxAgents (${this.ctx.config.maxAgents}) reached; skipping "${label}"`)
      return this.failedResult(label, started, "")
    }
    this.agentsStarted++

    return this.sem.run(async () => {
      let sessionId = ""
      try {
        // 3. resolve model + agentType (effort -> variant; modelID quirk here).
        const resolved = await this.resolver.resolve(agentTypeReq, opts.model, opts.effort)

        // 4. create a fresh child session under the run parent.
        sessionId = await this.createChild(label)
        if (!sessionId) {
          return this.failedResult(label, started, "")
        }

        // 5. register for the drift loop + announce.
        const active: ActiveChild = {
          sessionId,
          runId: this.ctx.runId,
          label,
          phase,
          model: resolved.display,
          agentType: resolved.agentType,
          startedAt: started,
        }
        this.ctx.registry.register(active)
        this.emit({
          type: "agent.start",
          phaseIdx: phase,
          agentLabel: label,
          agentType: resolved.agentType,
          model: resolved.display,
          sessionId,
          timestamp: new Date().toISOString(),
        })

        // 6. build system (brief) + prompt (injection + caller prompt).
        const injection = this.ctx.store.injectionFor({
          label,
          phase,
          contextRefs: opts.contextRefs,
        })
        const system = injection.system
        const composedPrompt = injection.context
          ? `${injection.context}\n\n---\n\n${prompt}`
          : prompt

        // 7. run the turn (with schema retry loop when requested).
        const { text, value, ok } = await this.runTurnWithSchema<T>(
          sessionId,
          composedPrompt,
          system,
          resolved.agentType,
          resolved.model,
          opts.schema,
          opts.schemaRetries ?? 2,
        )

        // 8. store artifact + emit activity preview + done.
        const artifact = this.ctx.store.putArtifact({ label, phase, full: text })
        const preview = lastLines(text, 3)
        if (preview) {
          this.emit({
            type: "agent.activity",
            phaseIdx: phase,
            agentLabel: label,
            sessionId,
            preview,
            timestamp: new Date().toISOString(),
          })
        }
        const durationMs = Date.now() - started
        const tokensEst = estimateTokens(text)
        this.emit({
          type: "agent.done",
          phaseIdx: phase,
          agentLabel: label,
          sessionId,
          artifactId: artifact.id,
          tokensEst,
          durationMs,
          ok,
          timestamp: new Date().toISOString(),
        })

        return { text, value, artifactId: artifact.id, sessionId, ok, tokensEst, durationMs }
      } catch {
        // Any uncaught failure -> a null result; the run continues.
        const durationMs = Date.now() - started
        this.emit({
          type: "agent.done",
          phaseIdx: phase,
          agentLabel: label,
          sessionId,
          artifactId: label,
          tokensEst: 0,
          durationMs,
          ok: false,
          timestamp: new Date().toISOString(),
        })
        return this.failedResult(label, started, sessionId)
      } finally {
        // 9. always release the drift-loop registration for this child.
        if (sessionId) this.ctx.registry.deregister(sessionId)
      }
    })
  }

  // -- parallel --------------------------------------------------------------

  /**
   * Hard-barrier fan-out: run all thunks concurrently and resolve once ALL have
   * settled. A rejected thunk becomes `null` (Promise.allSettled). The actual
   * concurrency ceiling is enforced inside each `agent()` via the semaphore, so
   * `parallel([...1000 thunks])` will not open 1000 sockets at once.
   */
  async parallel<T>(thunks: Array<Thunk<T>>): Promise<Array<T | null>> {
    if (!Array.isArray(thunks) || thunks.length === 0) return []
    const settled = await Promise.allSettled(
      thunks.map((t) => {
        try {
          return t()
        } catch (e) {
          return Promise.reject(e)
        }
      }),
    )
    return settled.map((r) => (r.status === "fulfilled" ? r.value : null))
  }

  // -- pipeline --------------------------------------------------------------

  /**
   * Streaming, NO-BARRIER pipeline. Each item flows through `stages` in order;
   * item N+1 enters stage 1 the instant item N leaves stage 1 (governed by the
   * shared concurrency semaphore inside `agent()`, NOT by a per-stage barrier).
   *
   * Per-item failure isolation: if any stage for an item throws/rejects, that
   * item collapses to `null` and stops advancing — other items keep flowing.
   * Later stages receive `(prev, originalItem, index)`.
   *
   * Returns one entry per input item (final-stage output, or `null` if dropped),
   * in input order. Resolves only when every item has finished or been dropped.
   */
  async pipeline<T>(items: string[], ...stages: Array<Stage<unknown, unknown>>): Promise<Array<T | null>> {
    if (!Array.isArray(items) || items.length === 0) return []
    if (stages.length === 0) return items.map(() => null)

    // Each item gets an independent async chain. Because there is no awaited
    // barrier between items, item[i+1]'s chain is kicked off in the same tick as
    // item[i]'s — they interleave naturally, throttled only by the semaphore.
    const runItem = async (originalItem: string, index: number): Promise<T | null> => {
      let prev: unknown = originalItem
      for (let s = 0; s < stages.length; s++) {
        try {
          prev = await stages[s](prev, originalItem, index)
        } catch {
          // Drop this item; it stops flowing through later stages.
          return null
        }
        // A stage that deliberately returns null also drops the item.
        if (prev === null || prev === undefined) return null
      }
      return prev as T
    }

    const chains = items.map((it, i) => runItem(it, i))
    return Promise.all(chains)
  }

  // --- internal: per-turn execution ----------------------------------------

  /**
   * Create a child session under the run parent. Returns its id, or "" on
   * failure. Uses the verified v1 shape: `session.create({ body:{ parentID, title } })`.
   *
   * NOTE on parentID: the run's brief carries no explicit parent session id (the
   * tool may run outside any session). We pass `parentID` only when the context
   * supplies one via `config`/brief; otherwise we create a top-level session,
   * which is still a valid, abortable, promptable session. Tests assert the
   * parent id is threaded through when present.
   */
  private async createChild(label: string): Promise<string> {
    try {
      const parentID = getParentId(this.ctx)
      const body: { parentID?: string; title?: string } = { title: label }
      if (parentID) body.parentID = parentID
      const res = await this.ctx.client.session.create({
        body,
        ...(this.ctx.brief.directory
          ? { query: { directory: this.ctx.brief.directory } }
          : {}),
      })
      const data = res?.data as { id?: string } | undefined
      return data?.id ?? ""
    } catch {
      return ""
    }
  }

  /**
   * Run one prompt turn and extract the final assistant text. The verified v1
   * shape: `session.prompt({ path:{ id }, body:{ parts, agent, model, system } })`
   * returning `{ data:{ info, parts } }`; final text =
   * parts.filter(type==="text").map(.text).join("").
   *
   * When `schema` is given, parse the JSON and validate (required keys / types).
   * On failure, retry up to `retries` times appending a "return JSON matching
   * schema" instruction. Returns the last text + parsed value (null if never valid).
   */
  private async runTurnWithSchema<T>(
    sessionId: string,
    prompt: string,
    system: string,
    agentType: string,
    model: { providerID: string; modelID: string },
    schema: JsonSchema | undefined,
    retries: number,
  ): Promise<{ text: string; value: T | null; ok: boolean }> {
    let attempt = 0
    let lastText = ""
    const maxAttempts = schema ? Math.max(1, retries + 1) : 1

    while (attempt < maxAttempts) {
      const promptForAttempt =
        attempt === 0
          ? prompt
          : `${prompt}\n\n---\nYour previous response did not parse as valid JSON ` +
            `matching the required schema. Return ONLY a JSON value matching this schema ` +
            `(no prose, no code fences):\n${JSON.stringify(schema)}`

      const text = await this.promptOnce(sessionId, promptForAttempt, system, agentType, model)
      lastText = text

      if (!schema) {
        return { text, value: null, ok: text.length > 0 }
      }

      const parsed = tryParseJson(text)
      if (parsed !== undefined && validateSchema(parsed, schema)) {
        return { text, value: parsed as T, ok: true }
      }
      attempt++
    }

    // Schema never satisfied — return the last text, value null, ok=false.
    return { text: lastText, value: null, ok: false }
  }

  /**
   * A single `session.prompt` HTTP turn. Returns the joined final text, or ""
   * on any failure. This is THE leaf call (plan §A.0 #2); the only place the
   * v1 `{ providerID, modelID }` body is sent.
   */
  private async promptOnce(
    sessionId: string,
    prompt: string,
    system: string,
    agentType: string,
    model: { providerID: string; modelID: string },
  ): Promise<string> {
    try {
      const res = await this.ctx.client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: prompt }],
          agent: agentType,
          model: { providerID: model.providerID, modelID: model.modelID },
          system,
        },
        ...(this.ctx.brief.directory
          ? { query: { directory: this.ctx.brief.directory } }
          : {}),
      })
      const data = res?.data as { parts?: Array<{ type?: string; text?: string }> } | undefined
      const parts = data?.parts ?? []
      return parts
        .filter((p) => p && p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("")
    } catch {
      return ""
    }
  }

  // --- internal helpers -----------------------------------------------------

  private emit(event: WorkflowEvent): void {
    try {
      this.ctx.bus.emit(event)
    } catch {
      /* bus already swallows, but double-guard against an emit() throw */
    }
  }

  private failedResult<T>(label: string, started: number, sessionId: string): AgentResult<T> {
    return {
      text: "",
      value: null,
      artifactId: label,
      sessionId,
      ok: false,
      tokensEst: 0,
      durationMs: Date.now() - started,
    }
  }
}

// ---------------------------------------------------------------------------
// Factory: bind the CC-style primitives to a context (functional surface)
// ---------------------------------------------------------------------------

/**
 * Bound primitives mirroring CC's API. The spec interpreter / tool calls these
 * directly:
 *
 *   const { agent, parallel, pipeline, phase, log } = createEngine(ctx)
 *   await parallel([() => agent("do X", { label:"x" }), () => agent("do Y", {...})])
 */
export interface BoundEngine {
  engine: WorkflowEngine
  agent: WorkflowEngine["agent"]
  parallel: WorkflowEngine["parallel"]
  pipeline: WorkflowEngine["pipeline"]
  phase: WorkflowEngine["phase"]
  log: WorkflowEngine["log"]
  /** Emit workflow.done + close the run in the registry. */
  finish: (result: string, stats: FinishStats) => void
}

export interface FinishStats {
  phasesCompleted: number
  agentsCompleted: number
  agentsFailed: number
  startedAt: number
}

/**
 * Build a {@link BoundEngine} from a partial context: only `client` + `brief`
 * are required; `store`/`registry`/`bus`/`config`/`runId` default to the
 * singletons / a fresh store.
 */
export function createEngine(
  ctx: { client: EngineClient; brief: WorkflowBrief; config: WorkflowConfig } & Partial<WorkflowContext>,
  resolver?: ModelResolver,
): BoundEngine {
  const full: WorkflowContext = {
    client: ctx.client,
    brief: ctx.brief,
    config: ctx.config,
    store:
      ctx.store ??
      new ContextStore(ctx.brief, {
        perAgentContextCapTokens: ctx.config.perAgentContextCapTokens,
      }),
    registry: ctx.registry ?? workflowRegistry,
    bus: ctx.bus ?? uiBus,
    runId: ctx.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  }
  const engine = new WorkflowEngine(full, resolver)

  return {
    engine,
    agent: engine.agent.bind(engine),
    parallel: engine.parallel.bind(engine),
    pipeline: engine.pipeline.bind(engine),
    phase: engine.phase.bind(engine),
    log: engine.log.bind(engine),
    finish: (result: string, stats: FinishStats) => {
      try {
        full.bus.emit({
          type: "workflow.done",
          title: full.brief.task || full.runId,
          phasesCompleted: stats.phasesCompleted,
          agentsCompleted: stats.agentsCompleted,
          agentsFailed: stats.agentsFailed,
          durationMs: Date.now() - stats.startedAt,
          result: headTailSummary(result, 80),
          timestamp: new Date().toISOString(),
        })
      } catch {
        /* never throw */
      }
      try {
        full.registry.endRun(full.runId)
      } catch {
        /* never throw */
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Concurrency: a tiny counting semaphore
// ---------------------------------------------------------------------------

/**
 * A FIFO counting semaphore. `run(fn)` acquires a slot, runs `fn`, and releases
 * the slot in a finally — so a throwing `fn` never leaks capacity. Used to cap
 * concurrent `session.prompt` turns regardless of how many thunks `parallel`/
 * `pipeline` schedule at once.
 */
export class Semaphore {
  readonly capacity: number
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity))
  }

  private acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++
        resolve()
      })
    })
  }

  private release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }

  /** Acquire, run, release (release always runs, even on throw). */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  /** Number of slots currently in use. */
  get inFlight(): number {
    return this.active
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Resolve the effective concurrency: explicit config, else cores-based auto. */
export function computeConcurrency(configured: number | undefined): number {
  if (typeof configured === "number" && configured > 0) return Math.floor(configured)
  let cores = 4
  try {
    const n = cpus().length
    if (n > 0) cores = n
  } catch {
    /* fall back to 4 */
  }
  return Math.min(16, Math.max(2, cores - 2))
}

/** Last `n` non-empty lines of `text`, joined (for the activity preview). */
function lastLines(text: string, n: number): string {
  if (!text) return ""
  const lines = text.split("\n").filter((l) => l.trim().length > 0)
  return lines.slice(Math.max(0, lines.length - n)).join("\n")
}

/**
 * Best-effort parent session id for child creation. The context may thread a
 * parent through `runId`-adjacent fields; today we read an optional
 * `parentID` smuggled on the brief via a non-typed property. Returns undefined
 * when none is available (a top-level child is then created).
 */
function getParentId(ctx: WorkflowContext): string | undefined {
  const maybe = (ctx.brief as unknown as { parentID?: string }).parentID
  return typeof maybe === "string" && maybe.length > 0 ? maybe : undefined
}

/** Parse JSON, tolerating ```json fences and surrounding prose. undefined on failure. */
export function tryParseJson(text: string): unknown {
  if (!text) return undefined
  const trimmed = text.trim()
  // Strip a leading/trailing code fence if present.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const candidate = fenced ? fenced[1] : trimmed
  try {
    return JSON.parse(candidate)
  } catch {
    // Fall back: extract the first {...} or [...] balanced-ish span.
    const objStart = candidate.indexOf("{")
    const arrStart = candidate.indexOf("[")
    const start =
      objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart)
    if (start === -1) return undefined
    const open = candidate[start]
    const close = open === "{" ? "}" : "]"
    const end = candidate.lastIndexOf(close)
    if (end <= start) return undefined
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

/**
 * Minimal JSON-schema validation (plan §E.5): checks the top-level `type`,
 * `required` keys, and per-`properties` primitive types. Intentionally shallow —
 * enough to drive the retry loop without an AJV dependency.
 */
export function validateSchema(value: unknown, schema: JsonSchema): boolean {
  if (!schema) return true
  if (schema.type) {
    if (schema.type === "array") {
      if (!Array.isArray(value)) return false
    } else if (schema.type === "object") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false
    } else if (typeof value !== schema.type) {
      return false
    }
  }
  if (schema.required && schema.required.length > 0) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false
    const obj = value as Record<string, unknown>
    for (const key of schema.required) {
      if (!(key in obj)) return false
    }
  }
  if (schema.properties) {
    if (typeof value !== "object" || value === null) return false
    const obj = value as Record<string, unknown>
    for (const [key, spec] of Object.entries(schema.properties)) {
      if (!(key in obj)) continue // presence governed by `required`
      if (!spec.type) continue
      const v = obj[key]
      if (spec.type === "array") {
        if (!Array.isArray(v)) return false
      } else if (spec.type === "object") {
        if (typeof v !== "object" || v === null || Array.isArray(v)) return false
      } else if (typeof v !== spec.type) {
        return false
      }
    }
  }
  return true
}
