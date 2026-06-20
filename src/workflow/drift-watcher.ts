/**
 * Drift-watcher round-robin loop (plan §A.3, §B, §D.2).
 *
 * A `setInterval` loop (reusing the watchdog's `unref()` + try/catch never-throw
 * discipline, default `driftIntervalMs` 90s) that, on each tick, snapshots ONE
 * active child from the {@link WorkflowRegistry} (round-robin) and asks a FRESH
 * `drift-watcher` agent turn whether that child has diverged from the shared
 * brief. The watcher returns a {@link DriftVerdict}; the loop then either
 *
 *   - "report":  appends a blackboard note + nudges the orchestrator via
 *                `client.session.promptAsync` (the same nudge call the watchdog
 *                uses); NO abort, or
 *   - "respawn": `client.session.abort` the drifted child, then re-run that node
 *                through `engine.agent()` with the watcher's `clearerPrompt`
 *                appended to the original prompt (capped at `maxRespawns` per
 *                node, mirroring the watchdog's `maxWakes`).
 *
 * The ≤40k HARD cap is enforced HOST-SIDE and is the load-bearing guarantee
 * (plan §A.3 #1): the loop reads `client.session.messages` for the swept child,
 * keeps ONLY the last ~40 lines of the latest ASSISTANT text, builds the watcher
 * prompt itself, and HARD-TRUNCATES it to a 35k-token budget (chars/4) BEFORE
 * calling `session.prompt`. The watcher therefore can never receive more than
 * ~40k because the host never puts more than that into `parts`. A fresh watcher
 * turn each sweep (new child session, or abort+recreate) means context never
 * compounds across sweeps. The watcher agent itself has ALL tooling denied
 * (`agents/drift-watcher.md`) so it cannot pull more context on its own.
 *
 * Every SDK call + handler body is wrapped in try/catch so the loop can NEVER
 * throw into OpenCode's event loop. Log-and-continue, exactly like the watchdog.
 */
import type { PluginInput } from "@opencode-ai/plugin"
import { estimateTokens } from "./context-store.js"
import type { ContextStore, WorkflowBrief } from "./context-store.js"
import { workflowRegistry, type ActiveChild, type WorkflowRegistry } from "./registry.js"
import type { WorkflowConfig } from "./config.js"
import type { DriftVerdict } from "./types.js"

type DriftClient = PluginInput["client"]

/** How many trailing lines of the latest assistant text we snapshot per child. */
const SNAPSHOT_LINES = 40

/**
 * Headroom under the configured `driftCapTokens` (40k) reserved for the system
 * brief + the watcher's own response. The assembled snapshot prompt is hard
 * truncated to `driftCapTokens - CAP_HEADROOM_TOKENS` (i.e. ~35k for the
 * default 40k cap) BEFORE sending. This is the load-bearing ≤40k guarantee.
 */
const CAP_HEADROOM_TOKENS = 5_000

/** The OpenCode agent name the watcher turn runs as (agents/drift-watcher.md). */
const DRIFT_AGENT = "drift-watcher"

/** Default per-node respawn cap (mirrors the watchdog's maxWakes loop guard). */
const DEFAULT_MAX_RESPAWNS = 2

/**
 * Re-run callback the host supplies so the loop can respawn a drifted node
 * through `engine.agent()` WITHOUT this module importing the engine (keeps it
 * decoupled + testable). Given the drifted child's detail and the clarified
 * prompt, the host re-runs the node (typically `engine.agent(clarified, opts)`).
 * Returns the fresh child session id (or "" if the respawn could not start).
 *
 * The drift loop calls this AFTER it has aborted the drifted child.
 */
export type RespawnNode = (
  drifted: ActiveChild,
  clarifiedPrompt: string,
) => Promise<string> | string

/** Dependencies the drift loop binds to. Mirrors the watchdog's constructor. */
export interface DriftWatcherDeps {
  client: DriftClient
  config: WorkflowConfig
  /** The per-run context store — used for blackboard notes on "report". */
  store: ContextStore
  /**
   * The immutable shared brief, injected into every watcher prompt so it can
   * compare each agent's output against the original intent. Passed explicitly
   * (the store keeps its own brief private) so the loop stays decoupled.
   */
  brief: WorkflowBrief
  /** Active-child registry (defaults to the singleton). */
  registry?: WorkflowRegistry
  /** Re-run a drifted node (engine.agent) — supplied by the ultracode tool. */
  respawnNode?: RespawnNode
  /**
   * Session id of the orchestrator to nudge on "report". When absent the loop
   * still records the blackboard note but skips the promptAsync nudge.
   */
  orchestratorID?: string
  /** Per-node respawn cap. Default {@link DEFAULT_MAX_RESPAWNS}. */
  maxRespawns?: number
}

/** Public handle: lifecycle controls mirroring the watchdog's surface. */
export interface DriftWatcher {
  /** Run a single sweep immediately (also called by the interval). Exposed for tests. */
  sweep: () => Promise<void>
  /** Stop the interval + release state. Idempotent. */
  dispose: () => void
}

/**
 * Create + ARM the drift-watcher loop. Returns a {@link DriftWatcher} handle.
 *
 * The interval is `unref()`-ed so it never keeps the process alive on its own
 * (watchdog discipline). When `config.driftEnabled` is false the loop is a
 * no-op (the timer is never armed) — same pattern as the watchdog's disabled path.
 */
export function createDriftWatcher(deps: DriftWatcherDeps): DriftWatcher {
  const { client, config, store, brief } = deps
  const registry = deps.registry ?? workflowRegistry
  const maxRespawns = Math.max(0, deps.maxRespawns ?? DEFAULT_MAX_RESPAWNS)

  /** Round-robin cursor across the registry's active children. */
  let cursor = 0
  /** Per-node respawn counter, keyed by node label (survives sessionId change). */
  const respawnCounts = new Map<string, number>()
  /** Original prompts captured per active child, for clarified respawns. */
  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false

  function log(level: "info" | "warn" | "error", message: string): void {
    try {
      void client.app.log({ body: { service: "drift-watcher", level, message } })
    } catch {
      // Logging must never throw.
    }
  }

  /**
   * Pick the NEXT active child in round-robin order. Returns undefined when no
   * children are active. The cursor is taken modulo the live list length each
   * call so it stays valid as children come and go.
   */
  function pickNext(active: ActiveChild[]): ActiveChild | undefined {
    if (active.length === 0) return undefined
    const idx = cursor % active.length
    cursor = (cursor + 1) % Math.max(1, active.length)
    return active[idx]
  }

  /**
   * Latest ASSISTANT text for a child, truncated to the last ~40 lines.
   * Reads `client.session.messages` (verified shape: data is an array of
   * `{ info: Message, parts: Part[] }` in chronological order). We take the
   * LAST message whose `info.role === "assistant"`, join its text parts, and
   * keep only the trailing {@link SNAPSHOT_LINES} lines. "" on any failure.
   */
  async function lastAssistantSnapshot(childID: string): Promise<string> {
    try {
      const res = await client.session.messages({ path: { id: childID } })
      const msgs = (res?.data ?? []) as Array<{
        info?: { role?: string }
        parts?: Array<{ type?: string; text?: string }>
      }>
      // Walk backwards to the most recent assistant message.
      let text = ""
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (!m || m.info?.role !== "assistant") continue
        text = (m.parts ?? [])
          .filter((p) => p && p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("")
        if (text.length > 0) break
      }
      return lastLines(text, SNAPSHOT_LINES)
    } catch {
      return ""
    }
  }

  /**
   * Build the watcher prompt from the swept child's snapshot + the shared brief,
   * then HARD-TRUNCATE to the ≤(driftCapTokens - headroom) budget BEFORE sending.
   * This is the host-side enforcement of the ≤40k ceiling (plan §A.3 #1).
   */
  function buildWatcherPrompt(child: ActiveChild, snapshot: string): string {
    const briefBlock =
      `## Shared brief\n` +
      `task: ${brief.task}\n` +
      `directory: ${brief.directory}\n` +
      (brief.dag ? `dag: ${brief.dag}\n` : "") +
      (brief.constraints && brief.constraints.length > 0
        ? `constraints:\n${brief.constraints.map((c) => `- ${c}`).join("\n")}\n`
        : "")

    const notes = safeNotes()
    const notesBlock = notes.length > 0 ? `## Blackboard notes\n${notes.map((n) => `- ${n}`).join("\n")}\n` : ""

    const agentBlock =
      `## Active agent snapshot (last ~${SNAPSHOT_LINES} lines)\n` +
      `target: ${child.sessionId}\n` +
      `label: ${child.label}\n` +
      `agentType: ${child.agentType}\n` +
      `model: ${child.model}\n` +
      `--- output ---\n${snapshot || "(no assistant output yet)"}\n`

    const instruction =
      `## Your task\n` +
      `Decide whether the agent above has diverged from / misunderstood the shared ` +
      `brief. Return ONLY a JSON object matching DriftVerdict:\n` +
      `{"drifted":bool,"severity":"report"|"respawn","target":"${child.sessionId}",` +
      `"reason":"...","clearerPrompt":"..."}\n` +
      `Default to {"drifted":false} unless you are confident. Use "respawn" ONLY ` +
      `when the agent is clearly off-track AND you can supply a non-empty clearerPrompt.\n`

    const assembled = `${briefBlock}\n${notesBlock}\n${agentBlock}\n${instruction}`

    // HARD CAP: never let more than (driftCapTokens - headroom) tokens through.
    const budgetTokens = Math.max(1_000, config.driftCapTokens - CAP_HEADROOM_TOKENS)
    return truncateToTokens(assembled, budgetTokens)
  }

  /** Blackboard notes, defensively (store.notes may throw on a buggy store). */
  function safeNotes(): string[] {
    try {
      return store.getNotes()
    } catch {
      return []
    }
  }

  /**
   * Run ONE fresh drift-watcher agent turn over `prompt`. A NEW child session is
   * created each sweep so context never compounds (plan §A.3 #2); it is aborted
   * immediately after we have the verdict. Returns the parsed verdict or null.
   */
  async function runWatcherTurn(prompt: string): Promise<DriftVerdict | null> {
    let watcherSession = ""
    try {
      const created = await client.session.create({
        body: { title: "drift-watcher" },
        ...(brief.directory ? { query: { directory: brief.directory } } : {}),
      })
      watcherSession = (created?.data as { id?: string } | undefined)?.id ?? ""
      if (!watcherSession) return null

      const res = await client.session.prompt({
        path: { id: watcherSession },
        body: {
          parts: [{ type: "text", text: prompt }],
          agent: DRIFT_AGENT,
        },
        ...(brief.directory ? { query: { directory: brief.directory } } : {}),
      })
      const data = res?.data as { parts?: Array<{ type?: string; text?: string }> } | undefined
      const text = (data?.parts ?? [])
        .filter((p) => p && p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("")
      return parseVerdict(text)
    } catch {
      return null
    } finally {
      // Abort+recreate hygiene: tear down the fresh watcher session so context
      // never accumulates across sweeps.
      if (watcherSession) {
        try {
          await client.session.abort({ path: { id: watcherSession } })
        } catch {
          /* never throw */
        }
      }
    }
  }

  /** "report" path: blackboard note + orchestrator nudge (no abort). */
  async function handleReport(child: ActiveChild, verdict: DriftVerdict): Promise<void> {
    const note = `drift detected in agent ${child.label} (${child.sessionId}): ${verdict.reason}`
    try {
      store.addNote(note)
    } catch {
      /* note storage must never throw */
    }
    log("warn", note)
    if (!deps.orchestratorID) return
    try {
      await client.session.promptAsync({
        path: { id: deps.orchestratorID },
        body: {
          parts: [
            {
              type: "text",
              text:
                `[drift] drift detected in agent ${child.label}: ${verdict.reason}. ` +
                `Inspect its child session and decide whether to course-correct.`,
            },
          ],
        },
      })
    } catch {
      log("error", `failed to nudge orchestrator ${deps.orchestratorID}`)
    }
  }

  /** "respawn" path: abort the drifted child, then re-run the node clarified. */
  async function handleRespawn(child: ActiveChild, verdict: DriftVerdict): Promise<void> {
    const used = respawnCounts.get(child.label) ?? 0
    if (used >= maxRespawns) {
      log(
        "warn",
        `respawn cap (${maxRespawns}) reached for node "${child.label}"; downgrading to report`,
      )
      await handleReport(child, verdict)
      return
    }
    if (!deps.respawnNode) {
      // No re-run capability wired in — degrade to a report so the signal isn't lost.
      log("warn", `no respawnNode wired; downgrading respawn of "${child.label}" to report`)
      await handleReport(child, verdict)
      return
    }

    // 1. Kill the drifted child.
    try {
      await client.session.abort({ path: { id: child.sessionId } })
    } catch {
      log("error", `failed to abort drifted child ${child.sessionId}`)
    }
    // It is no longer an active in-flight turn — drop it from the registry so the
    // round-robin doesn't keep sweeping a corpse.
    try {
      registry.deregister(child.sessionId)
    } catch {
      /* never throw */
    }

    // 2. Re-run the node with the clearer prompt appended to the original.
    const clarified =
      `${child.label}\n\n---\n[drift correction] ${verdict.clearerPrompt}`.trim()
    respawnCounts.set(child.label, used + 1)
    try {
      const fresh = await deps.respawnNode(child, clarified)
      log(
        "info",
        `respawned node "${child.label}" (respawn ${used + 1}/${maxRespawns})` +
          (fresh ? ` as ${fresh}` : ""),
      )
    } catch {
      log("error", `respawnNode threw for "${child.label}"`)
    }
  }

  /**
   * One round-robin sweep: snapshot the next active child, ask a fresh watcher
   * turn, act on the verdict. Never throws.
   */
  async function sweep(): Promise<void> {
    if (disposed) return
    try {
      const active = registry.listActive()
      const child = pickNext(active)
      if (!child) return

      const snapshot = await lastAssistantSnapshot(child.sessionId)
      const prompt = buildWatcherPrompt(child, snapshot)
      const verdict = await runWatcherTurn(prompt)

      if (!verdict || !verdict.drifted) {
        // Default to no-action; the watcher defaults to "report" only when it
        // is confident a problem exists (plan §E.6).
        return
      }

      // Always act on the child actually swept this tick. `verdict.target` is
      // LLM-generated free text and must NEVER drive action selection: if the
      // model hallucinates or copies a different session id from the
      // brief/blackboard that happens to belong to some other currently-active
      // (and possibly perfectly healthy) child, trusting it here would abort or
      // respawn the WRONG agent based on output we never inspected this sweep.
      // `targetChild` is therefore unconditionally `child`. We still log a
      // mismatch for diagnostics, but only informationally.
      const targetChild = child
      if (verdict.target && verdict.target !== child.sessionId) {
        log(
          "info",
          `drift verdict target "${verdict.target}" does not match swept session ${child.sessionId}; ignoring target, acting on swept child`,
        )
      }

      // respawn requires confidence: severity respawn AND a non-empty clearerPrompt
      // (plan §E.6); otherwise treat as a report.
      if (verdict.severity === "respawn" && verdict.clearerPrompt && verdict.clearerPrompt.trim()) {
        await handleRespawn(targetChild, verdict)
      } else {
        await handleReport(targetChild, verdict)
      }
    } catch {
      // Never throw out of the sweep.
      log("error", "drift sweep failed")
    }
  }

  function dispose(): void {
    disposed = true
    if (timer) {
      try {
        clearInterval(timer)
      } catch {
        /* ignore */
      }
      timer = undefined
    }
    respawnCounts.clear()
  }

  // ARM the loop (unless disabled), unref()-ing so it never holds the process up.
  if (config.driftEnabled) {
    timer = setInterval(() => {
      void sweep()
    }, config.driftIntervalMs)
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      ;(timer as { unref?: () => void }).unref!()
    }
    log("info", `drift-watcher armed (interval ${config.driftIntervalMs}ms, cap ${config.driftCapTokens} tok)`)
  }

  return { sweep, dispose }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for the test)
// ---------------------------------------------------------------------------

/** Last `n` lines of `text` (preserves blank lines inside the window). "" if empty. */
export function lastLines(text: string, n: number): string {
  if (!text) return ""
  const lines = text.split("\n")
  if (lines.length <= n) return text
  return lines.slice(lines.length - n).join("\n")
}

/**
 * Hard-truncate `text` to at most `tokenBudget` (chars/4) tokens. Cuts from the
 * FRONT so the most-recent (tail) content is preserved, since the snapshot's
 * trailing lines are the most diagnostic. Uses the same `estimateTokens`
 * (chars/4) heuristic as the context store, so the cap is exact + conservative.
 */
export function truncateToTokens(text: string, tokenBudget: number): string {
  if (!text) return ""
  if (estimateTokens(text) <= tokenBudget) return text
  // chars/4 == tokens  =>  charBudget = tokenBudget * 4. Keep the TAIL.
  const charBudget = Math.max(0, tokenBudget * 4)
  if (charBudget >= text.length) return text
  return text.slice(text.length - charBudget)
}

/**
 * Parse a {@link DriftVerdict} from raw watcher text (tolerating code fences /
 * surrounding prose). Returns null when no usable object is found. Coerces /
 * defaults fields conservatively: anything other than an explicit
 * `severity:"respawn"` is treated as `"report"`.
 */
export function parseVerdict(text: string): DriftVerdict | null {
  const obj = extractJsonObject(text)
  if (!obj || typeof obj !== "object") return null
  const o = obj as Record<string, unknown>
  if (typeof o.drifted !== "boolean") {
    // Without an explicit drifted flag we can't act safely.
    if (o.drifted === undefined) return null
  }
  const drifted = o.drifted === true
  const severity = o.severity === "respawn" ? "respawn" : "report"
  return {
    drifted,
    severity,
    target: typeof o.target === "string" ? o.target : "",
    reason: typeof o.reason === "string" ? o.reason : "",
    clearerPrompt: typeof o.clearerPrompt === "string" ? o.clearerPrompt : "",
  }
}

/** Extract the first balanced `{...}` object from `text`, parsed. undefined on failure. */
function extractJsonObject(text: string): unknown {
  if (!text) return undefined
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const candidate = fenced ? fenced[1] : trimmed
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf("{")
    const end = candidate.lastIndexOf("}")
    if (start === -1 || end <= start) return undefined
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}
