/**
 * `ultracode` tool — the single entry point the LLM (ultra-orchestrator or any
 * agent via the `/ultracode` command) calls to run a dynamic multi-agent
 * workflow (plan §B "Tool", §A.1).
 *
 * The tool's `args` is a DECLARATIVE workflow spec (JSON): an ordered list of
 * `phases`, each `single` | `parallel` | `pipeline`, with per-agent
 * `agentType` / `model` / `effort` / `schema` / `label` / `contextRefs`, plus a
 * top-level `brief` (task + directory + constraints) and an optional planned-DAG
 * summary. `execute()`:
 *
 *   1. loads the workflow config (never throws);
 *   2. builds a {@link WorkflowContext} — fresh per-run context store, the
 *      singleton registry + ui-bus, an immutable {@link WorkflowBrief};
 *   3. LAZILY starts the Bun.serve dashboard + the drift-watcher loop;
 *   4. interprets the spec by driving `engine.ts`:
 *        single   -> engine.agent
 *        parallel -> engine.parallel( agents.map(a => () => engine.agent(...)) )
 *        pipeline -> engine.pipeline( items, ...stages )
 *   5. returns the synthesized final text + a per-phase/agent summary
 *      (label, model, tokensEst, tool count, duration) as the tool output.
 *
 * The engine's leaf calls are grounded entirely in the verified v1 SDK
 * (plan §A.0); this tool only orchestrates them. Per the hard never-throw
 * discipline, `execute()` catches everything and returns a readable error
 * string rather than rejecting.
 */
import { tool } from "@opencode-ai/plugin"
import type { PluginInput } from "@opencode-ai/plugin"
import { createEngine, type AgentOptions, type AgentResult, type Effort } from "../workflow/engine.js"
import { ContextStore, headTailSummary, type WorkflowBrief } from "../workflow/context-store.js"
import { ModelResolver } from "../workflow/model-resolver.js"
import { workflowRegistry, type ActiveChild } from "../workflow/registry.js"
import { uiBus } from "../workflow/ui-bus.js"
import { loadWorkflowConfig } from "../workflow/config.js"
import { startDashboard, getDashboardUrl, getDashboardLanUrl } from "../workflow/dashboard.js"
import { createDriftWatcher } from "../workflow/drift-watcher.js"

type UltraClient = PluginInput["client"]

// ---------------------------------------------------------------------------
// Spec arg types (mirror src/workflow/types.ts; carried structurally here so
// the tool validates / interprets the JSON the model submits).
// ---------------------------------------------------------------------------

interface AgentSpecArg {
  agentType?: string
  model?: string
  effort?: string
  schema?: Record<string, unknown>
  label?: string
  contextRefs?: string[]
  prompt: string
}

interface PhaseSpecArg {
  mode?: string
  title?: string
  agents?: AgentSpecArg[]
  items?: string[]
  stages?: AgentSpecArg[]
  contextRefs?: string[]
}

interface WorkflowSpecArg {
  title?: string
  task?: string
  directory?: string
  constraints?: string[]
  dag?: string
  phases?: PhaseSpecArg[]
}

// ---------------------------------------------------------------------------
// Per-run accumulators for the summary report
// ---------------------------------------------------------------------------

interface AgentRunSummary {
  phaseIdx: number
  phaseTitle: string
  label: string
  model: string
  agentType: string
  tokensEst: number
  toolCount: number
  durationMs: number
  ok: boolean
}

// ---------------------------------------------------------------------------
// Tool schema — the WorkflowSpec, expressed with tool.schema (Zod-like).
// ---------------------------------------------------------------------------

const agentSchema = tool.schema
  .object({
    agentType: tool.schema
      .string()
      .optional()
      .describe('OpenCode agent name to run the turn as (e.g. "implementer", "general"). Default "general".'),
    model: tool.schema
      .string()
      .optional()
      .describe('Model: "opus"|"sonnet"|"haiku"|"inherit" or a full "{providerID}:{modelID}". opus-class for logic/implement/verify, sonnet-class for read/gather/docs.'),
    effort: tool.schema
      .enum(["low", "medium", "high", "max"])
      .optional()
      .describe("Reasoning effort hint; mapped to a model/agent variant (never sent per-prompt)."),
    label: tool.schema
      .string()
      .optional()
      .describe("Human label: dashboard row + artifact ref key + child session title. Make it unique within the run."),
    contextRefs: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe('Upstream artifact refs to inject: "label" (summary), "phase:N" (all of phase N), or "@full:label" (verbatim).'),
    schema: tool.schema
      .record(tool.schema.string(), tool.schema.any())
      .optional()
      .describe('Optional minimal JSON-schema {type,required[],properties{}} — the engine validates the result and retries (≤2) to coerce structured JSON output.'),
    prompt: tool.schema
      .string()
      .describe("The instruction sent to this agent. Be specific and self-contained; upstream context is injected automatically via contextRefs."),
  })
  .describe("One agent node.")

const phaseSchema = tool.schema
  .object({
    mode: tool.schema
      .enum(["single", "parallel", "pipeline"])
      .describe('"single" = one agent; "parallel" = all agents concurrently (hard barrier); "pipeline" = items streamed through stages with no inter-stage barrier.'),
    title: tool.schema.string().describe("Phase title shown in the dashboard."),
    agents: tool.schema
      .array(agentSchema)
      .optional()
      .describe("Agents for single/parallel modes. single uses agents[0]; parallel runs all concurrently."),
    items: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Pipeline mode only: the input items that flow through stages."),
    stages: tool.schema
      .array(agentSchema)
      .optional()
      .describe("Pipeline mode only: ordered stages each item passes through. {item} in a stage prompt is replaced with the current item."),
    contextRefs: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Phase-level refs inherited by every agent in the phase (unless the agent overrides with its own contextRefs)."),
  })
  .describe("One workflow phase.")

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

/**
 * Factory the plugin wires into the tool map:
 *   tool: { ultracode: createUltracode(client, directory), ... }
 *
 * `client` is the v1 OpenCode SDK client (PluginInput.client). `directory` is
 * the project root used for config loading and as the working directory for
 * spawned child sessions.
 */
export function createUltracode(client: UltraClient, directory: string) {
  return tool({
    description:
      "Run a dynamic multi-agent workflow. Submit a declarative spec: ordered phases (single/parallel/pipeline), each with per-agent agentType/model/effort/schema/label/contextRefs, plus a top-level task brief. The engine spawns real OpenCode child sessions, fans out in parallel, streams progress to a live web dashboard, and returns the synthesized result plus a per-phase/agent summary. Use parallel for independent work, pipeline for staged review, single for one step.",
    args: {
      task: tool.schema
        .string()
        .describe("The overall task / user request. Injected verbatim into every agent's shared brief."),
      phases: tool.schema
        .array(phaseSchema)
        .describe("Ordered list of phases. Later phases can reference earlier phases' artifacts via contextRefs."),
      title: tool.schema
        .string()
        .optional()
        .describe("Short workflow title for the dashboard header. Defaults to the task."),
      directory: tool.schema
        .string()
        .optional()
        .describe("Absolute project root. Defaults to the tool's bound directory."),
      constraints: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("Global constraints appended to every agent's system brief."),
      dag: tool.schema
        .string()
        .optional()
        .describe("Optional compact rendering of the planned DAG (phase titles + agent labels) for the shared brief."),
    },
    async execute(args, context) {
      // ── never-throw boundary ───────────────────────────────────────────
      try {
        return await runWorkflow(client, directory, args as WorkflowSpecArg, context)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          title: "ultracode failed",
          output: `Workflow could not run: ${message}`,
        }
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Core interpreter (separated so the never-throw wrapper stays tiny)
// ---------------------------------------------------------------------------

async function runWorkflow(
  client: UltraClient,
  boundDirectory: string,
  spec: WorkflowSpecArg,
  context: { metadata?: (m: { title?: string; metadata?: Record<string, unknown> }) => void; sessionID?: string },
): Promise<{ title: string; output: string }> {
  const startedAt = Date.now()

  // 1. Validate the spec shape up front (readable errors, no throws).
  const phases = Array.isArray(spec.phases) ? spec.phases : []
  const task = (spec.task ?? "").trim()
  if (!task) {
    return { title: "ultracode: missing task", output: "A non-empty `task` is required." }
  }
  if (phases.length === 0) {
    return { title: "ultracode: empty workflow", output: "At least one phase is required in `phases`." }
  }

  const directory = (spec.directory && spec.directory.trim()) || boundDirectory

  // 2. Load config (never throws; falls back to defaults).
  const config = loadWorkflowConfig(directory)
  if (!config.enabled) {
    return {
      title: "ultracode disabled",
      output:
        "The workflow engine is disabled (workflow.enabled=false or OPENCODE_CONTINUOUS_WORKFLOW=0). Enable it to run workflows.",
    }
  }

  // 3. Build the immutable shared brief + a fresh per-run context store.
  const brief: WorkflowBrief = {
    task,
    directory,
    constraints: Array.isArray(spec.constraints) ? spec.constraints : [],
    dag: spec.dag && spec.dag.trim().length > 0 ? spec.dag.trim() : renderDagSummary(spec.title || task, phases),
  }
  const store = new ContextStore(brief, {
    perAgentContextCapTokens: config.perAgentContextCapTokens,
  })
  const resolver = new ModelResolver(client, { directory })

  // 4. Build the bound engine (its own runId; shares singleton registry+bus).
  const bound = createEngine({ client, brief, config, store, registry: workflowRegistry, bus: uiBus }, resolver)
  const { engine, agent, parallel, pipeline, phase, log, finish } = bound

  // 5. Collect per-agent summaries by tapping the ui-bus for this run only.
  const summaries: AgentRunSummary[] = []
  const phaseTitleByIdx = new Map<number, string>()
  const lastTextByLabel = new Map<string, AgentResult<unknown>>()
  const busTap = makeBusTap(summaries, phaseTitleByIdx)
  uiBus.on(busTap)

  // 6. Lazily start the dashboard + drift loop (both best-effort, never throw).
  const dashboardUrl = await startDashboardSafely(config, client, directory)
  const drift = startDriftSafely(client, config, store, brief, context?.sessionID, async (drifted, clarified) => {
    // Respawn hook: re-run the drifted node as a fresh agent turn.
    const res = await agent(clarified, {
      agentType: drifted.agentType,
      model: drifted.model,
      label: `${drifted.label} (respawn)`,
      phase: drifted.phase,
    })
    return res.sessionId
  })

  // 7. Interpret the spec phase by phase. Phases run sequentially (later phases
  //    see earlier artifacts); within a phase, mode governs concurrency.
  let agentsCompleted = 0
  let agentsFailed = 0
  let phasesCompleted = 0

  try {
    for (let p = 0; p < phases.length; p++) {
      const ph = phases[p]
      const title = (ph.title && ph.title.trim()) || `Phase ${p + 1}`
      phaseTitleByIdx.set(p, title)
      const mode = normalizeMode(ph.mode)

      if (mode === "pipeline") {
        const items = Array.isArray(ph.items) ? ph.items : []
        const stages = Array.isArray(ph.stages) ? ph.stages : []
        phase(p, title, "pipeline", stages.length)
        if (items.length === 0 || stages.length === 0) {
          log(`[ultracode] phase ${p} "${title}" skipped: pipeline needs items[] and stages[]`)
        } else {
          const stageFns = stages.map((stage, si) =>
            (prev: unknown, originalItem: string, index: number) =>
              runStage(agent, stage, ph, p, prev, originalItem, index, si),
          )
          await pipeline<unknown>(items, ...stageFns)
        }
      } else if (mode === "parallel") {
        const agents = Array.isArray(ph.agents) ? ph.agents : []
        phase(p, title, "parallel", agents.length)
        if (agents.length === 0) {
          log(`[ultracode] phase ${p} "${title}" skipped: parallel needs agents[]`)
        } else {
          const thunks = agents.map((a, ai) => () => runAgentNode(agent, a, ph, p, ai))
          const results = await parallel(thunks)
          for (const r of results) {
            if (r && r.ok) {
              agentsCompleted++
              lastTextByLabel.set(r.artifactId, r)
            } else {
              agentsFailed++
            }
          }
        }
      } else {
        // single
        const agents = Array.isArray(ph.agents) ? ph.agents : []
        phase(p, title, "single", agents.length > 0 ? 1 : 0)
        if (agents.length === 0) {
          log(`[ultracode] phase ${p} "${title}" skipped: single needs agents[0]`)
        } else {
          const r = await runAgentNode(agent, agents[0], ph, p, 0)
          if (r && r.ok) {
            agentsCompleted++
            lastTextByLabel.set(r.artifactId, r)
          } else {
            agentsFailed++
          }
        }
      }

      phasesCompleted++
    }
  } finally {
    // Tear down the drift loop + stop tapping the bus regardless of outcome.
    try {
      drift?.dispose()
    } catch {
      /* never throw */
    }
    try {
      uiBus.off(busTap)
    } catch {
      /* never throw */
    }
  }

  // 8. Synthesize the final text: the last phase's artifacts are the result.
  const finalText = synthesizeResult(store, phases.length - 1, summaries)
  finish(finalText, { phasesCompleted, agentsCompleted, agentsFailed, startedAt })

  // 9. Build the tool output: synthesized text + per-phase/agent table.
  const durationMs = Date.now() - startedAt
  const report = renderReport({
    title: spec.title || task,
    summaries,
    phasesCompleted,
    agentsCompleted,
    agentsFailed,
    durationMs,
    dashboardUrl,
    concurrency: engine.concurrency,
  })

  const output = finalText ? `${finalText}\n\n---\n\n${report}` : report

  // 10. Tool row metadata (best-effort).
  try {
    context?.metadata?.({
      title: `ultracode: ${spec.title || task}`,
      metadata: {
        phases: phasesCompleted,
        agentsCompleted,
        agentsFailed,
        durationMs,
        dashboard: dashboardUrl || undefined,
      },
    })
  } catch {
    /* metadata is decorative; never throw */
  }

  return { title: `ultracode: ${truncate(spec.title || task, 60)}`, output }
}

// ---------------------------------------------------------------------------
// Node execution helpers
// ---------------------------------------------------------------------------

/** Run one agent node, merging phase-level contextRefs and mapping effort. */
async function runAgentNode(
  agent: (prompt: string, opts?: AgentOptions) => Promise<AgentResult<unknown>>,
  spec: AgentSpecArg,
  phaseSpec: PhaseSpecArg,
  phaseIdx: number,
  nodeIdx: number,
): Promise<AgentResult<unknown>> {
  const opts = buildAgentOptions(spec, phaseSpec, phaseIdx, nodeIdx)
  const prompt = (spec.prompt ?? "").toString()
  return agent(prompt, opts)
}

/**
 * A pipeline stage thunk: substitutes `{item}` and `{prev}` in the stage prompt,
 * runs the stage agent, and returns its text so the next stage receives it.
 * Throwing (or returning null) drops the item — but we never throw; a failed
 * stage returns null which the engine treats as a drop.
 */
async function runStage(
  agent: (prompt: string, opts?: AgentOptions) => Promise<AgentResult<unknown>>,
  spec: AgentSpecArg,
  phaseSpec: PhaseSpecArg,
  phaseIdx: number,
  prev: unknown,
  originalItem: string,
  index: number,
  stageIdx: number,
): Promise<string | null> {
  const opts = buildAgentOptions(spec, phaseSpec, phaseIdx, stageIdx)
  // Make each pipeline stage label unique per item so artifacts don't collide.
  opts.label = `${opts.label ?? `stage-${stageIdx}`} #${index + 1}`
  const prevText = typeof prev === "string" ? prev : prev == null ? "" : String(prev)
  const prompt = (spec.prompt ?? "")
    .toString()
    .replace(/\{item\}/g, originalItem)
    .replace(/\{prev\}/g, prevText)
  const res = await agent(prompt, opts)
  return res.ok ? res.text : null
}

/** Translate a spec node into engine AgentOptions (effort/contextRefs merge). */
function buildAgentOptions(
  spec: AgentSpecArg,
  phaseSpec: PhaseSpecArg,
  phaseIdx: number,
  nodeIdx: number,
): AgentOptions {
  // Agent-level refs override phase-level refs (plan §A.2); else inherit phase.
  const refs =
    Array.isArray(spec.contextRefs) && spec.contextRefs.length > 0
      ? spec.contextRefs
      : Array.isArray(phaseSpec.contextRefs)
        ? phaseSpec.contextRefs
        : undefined

  return {
    agentType: spec.agentType?.trim() || "general",
    model: spec.model?.trim() || undefined,
    effort: normalizeEffort(spec.effort),
    label: spec.label?.trim() || `p${phaseIdx}-n${nodeIdx}`,
    phase: phaseIdx,
    contextRefs: refs,
    schema: spec.schema as AgentOptions["schema"],
  }
}

// ---------------------------------------------------------------------------
// Bus tap — accumulate per-agent stats from the engine's own events.
// ---------------------------------------------------------------------------

/**
 * Build a ui-bus listener that records one {@link AgentRunSummary} per
 * `agent.done`, enriched with the model/agentType captured at `agent.start`.
 * Tool-call count is approximated from `agent.activity` previews (the engine
 * does not surface a structured tool counter), so it is a best-effort estimate.
 */
function makeBusTap(
  summaries: AgentRunSummary[],
  phaseTitleByIdx: Map<number, string>,
): (event: import("../workflow/types.js").WorkflowEvent) => void {
  const startInfo = new Map<string, { model: string; agentType: string }>()
  const toolCounts = new Map<string, number>()
  const key = (phaseIdx: number, label: string) => `${phaseIdx}::${label}`

  return (event) => {
    if (event.type === "agent.start") {
      startInfo.set(key(event.phaseIdx, event.agentLabel), {
        model: event.model,
        agentType: event.agentType,
      })
    } else if (event.type === "agent.activity") {
      const k = key(event.phaseIdx, event.agentLabel)
      // Heuristic: count activity previews that look like tool invocations.
      const hits = (event.preview.match(/\b(read|write|edit|bash|grep|glob|webfetch|task)\b/gi) || []).length
      toolCounts.set(k, (toolCounts.get(k) ?? 0) + (hits > 0 ? 1 : 0))
    } else if (event.type === "agent.done") {
      const k = key(event.phaseIdx, event.agentLabel)
      const info = startInfo.get(k)
      summaries.push({
        phaseIdx: event.phaseIdx,
        phaseTitle: phaseTitleByIdx.get(event.phaseIdx) ?? `Phase ${event.phaseIdx + 1}`,
        label: event.agentLabel,
        model: info?.model ?? "?",
        agentType: info?.agentType ?? "?",
        tokensEst: event.tokensEst,
        toolCount: toolCounts.get(k) ?? 0,
        durationMs: event.durationMs,
        ok: event.ok,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Lazy infra startup (best-effort, never throw)
// ---------------------------------------------------------------------------

/**
 * Whether this process has already surfaced the "dashboard live" notice.
 * The dashboard server itself is a process-wide singleton (src/workflow/
 * dashboard.ts), so this flag — also process-wide — keeps the notice to
 * exactly one `client.app.log` call per process, no matter how many
 * workflow runs lazily touch `startDashboardSafely`.
 */
let dashboardNoticeSent = false

async function startDashboardSafely(
  config: ReturnType<typeof loadWorkflowConfig>,
  client: UltraClient,
  directory: string,
): Promise<string> {
  if (!config.dashboardEnabled) return ""
  try {
    // getDashboardUrl() is "" until the module-level server singleton in
    // dashboard.ts has actually bound a port; capture that before calling
    // startDashboard so we can tell a real start apart from an idempotent
    // no-op (already running) without touching dashboard.ts's own logic.
    const wasAlreadyRunning = getDashboardUrl() !== ""
    const url = await startDashboard(
      config.dashboardPort,
      () => workflowRegistry.snapshot(),
      // The dashboard's optional client is structurally compatible with ours.
      client as never,
    )
    void directory
    const resolvedUrl = url || getDashboardUrl()

    if (resolvedUrl && !wasAlreadyRunning && !dashboardNoticeSent) {
      dashboardNoticeSent = true
      // Include the LAN URL (if the host has a routable IPv4) so the run is
      // discoverable from other devices on the local network.
      notifyDashboardLiveOnce(client, resolvedUrl, getDashboardLanUrl() || undefined)
    }

    return resolvedUrl
  } catch {
    return ""
  }
}

/**
 * Fire-and-forget, one-time-per-process notice that the dashboard just came
 * up. Never awaited (must not delay the workflow) and never throws.
 */
function notifyDashboardLiveOnce(
  client: UltraClient,
  url: string,
  lanUrl?: string,
): void {
  try {
    const where = lanUrl ? `${url} (LAN: ${lanUrl})` : url
    void client.app.log({
      body: {
        service: "ultracode",
        level: "info",
        message: `ultracode workflow dashboard live at ${where} — open it in a browser to watch this run`,
      },
    })
  } catch {
    /* notification is decorative; never throw */
  }
}

function startDriftSafely(
  client: UltraClient,
  config: ReturnType<typeof loadWorkflowConfig>,
  store: ContextStore,
  brief: WorkflowBrief,
  orchestratorID: string | undefined,
  respawnNode: (drifted: ActiveChild, clarified: string) => Promise<string>,
): ReturnType<typeof createDriftWatcher> | undefined {
  if (!config.driftEnabled) return undefined
  try {
    return createDriftWatcher({
      client,
      config,
      store,
      brief,
      registry: workflowRegistry,
      orchestratorID,
      respawnNode,
    })
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Result synthesis + reporting
// ---------------------------------------------------------------------------

/**
 * The workflow result = the final phase's artifacts (their full text). When the
 * last phase produced nothing (e.g. all failed), fall back to the newest
 * non-empty artifact, then to a status line.
 */
function synthesizeResult(store: ContextStore, lastPhaseIdx: number, summaries: AgentRunSummary[]): string {
  // Prefer artifacts from the last phase, in order.
  const lastPhase = summaries
    .filter((s) => s.phaseIdx === lastPhaseIdx && s.ok)
    .map((s) => store.getFull(s.label))
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)

  if (lastPhase.length === 1) return lastPhase[0]
  if (lastPhase.length > 1) {
    return lastPhase.map((t, i) => `## Result ${i + 1}\n\n${t}`).join("\n\n")
  }

  // Fallback: newest ok artifact anywhere.
  for (let i = summaries.length - 1; i >= 0; i--) {
    const s = summaries[i]
    if (!s.ok) continue
    const t = store.getFull(s.label)
    if (t && t.trim().length > 0) return t
  }
  return ""
}

interface ReportInput {
  title: string
  summaries: AgentRunSummary[]
  phasesCompleted: number
  agentsCompleted: number
  agentsFailed: number
  durationMs: number
  dashboardUrl: string
  concurrency: number
}

/** Render the human-readable per-phase/agent summary appended to the output. */
function renderReport(r: ReportInput): string {
  const lines: string[] = []
  lines.push(`# Workflow: ${r.title}`)
  lines.push("")
  lines.push(
    `${r.phasesCompleted} phase(s) · ${r.agentsCompleted} agent(s) ok · ` +
      `${r.agentsFailed} failed · ${formatDuration(r.durationMs)} · concurrency ${r.concurrency}` +
      (r.dashboardUrl ? ` · dashboard ${r.dashboardUrl}` : ""),
  )
  lines.push("")

  if (r.summaries.length === 0) {
    lines.push("(no agents ran)")
    return lines.join("\n")
  }

  // Group by phase.
  const byPhase = new Map<number, AgentRunSummary[]>()
  for (const s of r.summaries) {
    const arr = byPhase.get(s.phaseIdx) ?? []
    arr.push(s)
    byPhase.set(s.phaseIdx, arr)
  }
  const phaseIdxs = [...byPhase.keys()].sort((a, b) => a - b)
  for (const p of phaseIdxs) {
    const rows = byPhase.get(p)!
    lines.push(`## ${rows[0].phaseTitle}`)
    for (const s of rows) {
      const status = s.ok ? "✔" : "✗"
      lines.push(
        `- ${status} ${s.label} — ${s.model} · ` +
          `${s.tokensEst} tok · ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"} · ` +
          `${formatDuration(s.durationMs)}`,
      )
    }
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function normalizeMode(mode: string | undefined): "single" | "parallel" | "pipeline" {
  const m = (mode ?? "").trim().toLowerCase()
  if (m === "parallel") return "parallel"
  if (m === "pipeline") return "pipeline"
  return "single"
}

function normalizeEffort(effort: string | undefined): Effort | undefined {
  const e = (effort ?? "").trim().toLowerCase()
  if (e === "low" || e === "medium" || e === "high" || e === "max") return e
  return undefined
}

/** A compact one-line-per-phase DAG rendering for the shared brief. */
function renderDagSummary(title: string, phases: PhaseSpecArg[]): string {
  const lines: string[] = [title]
  phases.forEach((ph, i) => {
    const mode = normalizeMode(ph.mode)
    let labels: string[] = []
    if (mode === "pipeline") {
      labels = (ph.stages ?? []).map((s) => s.label || s.agentType || "stage")
    } else {
      labels = (ph.agents ?? []).map((s) => s.label || s.agentType || "agent")
    }
    lines.push(`  ${i + 1}. [${mode}] ${(ph.title || `Phase ${i + 1}`)}: ${labels.join(", ")}`)
  })
  return lines.join("\n")
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s"
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s - m * 60)
  return `${m}m${rem}s`
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return headTailSummary(text, 1).slice(0, max - 1) + "…"
}
