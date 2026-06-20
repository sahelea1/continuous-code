/**
 * Shared types for the workflow engine.
 *
 * Pure type declarations only — no runtime imports. Every other module in
 * src/workflow/ imports from here; nothing here imports from them.
 */

// ---------------------------------------------------------------------------
// Spec types (the declarative DAG a caller or the ultracode tool submits)
// ---------------------------------------------------------------------------

/**
 * Per-agent node inside a phase spec.
 *
 * - `agentType`   maps to an OpenCode agent name (e.g. "implementer").
 * - `model`       shorthand ("opus"|"sonnet"|"haiku") or a full
 *                 "{providerID}:{modelID}" string; resolved by model-resolver.
 * - `effort`      passed through for future per-prompt reasoning control
 *                 (currently used to select model variant, per plan §E.8).
 * - `schema`      optional JSON-schema object; when present the engine will
 *                 validate and retry (≤2 times) to get structured output.
 * - `label`       human-readable name shown in the dashboard and used as the
 *                 child session title.
 * - `phase`       index of the enclosing phase (filled in by the engine, not
 *                 required from callers).
 * - `contextRefs` list of artifact reference strings resolved by the context
 *                 store before the agent turn. Prefix `@full:` forces full
 *                 text injection instead of summary.
 */
export interface AgentSpec {
  agentType: string
  model?: string
  effort?: "low" | "medium" | "high" | "max"
  schema?: Record<string, unknown>
  label: string
  phase?: number
  contextRefs?: string[]
  /** The prompt text sent to this agent. */
  prompt: string
}

/**
 * One phase in a workflow.
 *
 * mode:
 *  - "parallel"  all agents in `agents[]` run concurrently (Promise.allSettled).
 *  - "pipeline"  `items[]` flows through `stages[]` with no inter-stage barrier
 *                (item N+1 enters stage 1 as soon as item N leaves it).
 *  - "single"    a single agent in `agents[0]`.
 *
 * `contextRefs` at the phase level are inherited by every agent in the phase
 * unless the agent spec overrides with its own list.
 */
export type PhaseSpec =
  | {
      mode: "parallel" | "single"
      title: string
      agents: AgentSpec[]
      contextRefs?: string[]
    }
  | {
      mode: "pipeline"
      title: string
      items: string[]
      stages: AgentSpec[]
      contextRefs?: string[]
    }

/**
 * Top-level workflow declaration submitted to the ultracode tool or engine.
 */
export interface WorkflowSpec {
  /** Short human title shown in the dashboard header. */
  title: string
  /** Ordered list of phases. Later phases see artifacts from earlier ones. */
  phases: PhaseSpec[]
  /**
   * Raw task description passed verbatim into the WorkflowBrief (the tiny
   * shared context injected into every agent's system prompt).
   */
  task: string
  /** Absolute path to the project root; injected into the brief. */
  directory: string
  /** Global constraints appended to every agent's system string. */
  constraints?: string[]
}

// ---------------------------------------------------------------------------
// Runtime types (produced by the engine during execution)
// ---------------------------------------------------------------------------

/**
 * Content-addressed artifact produced by one agent turn and stored in the
 * context store. Downstream agents receive `summary` by default; `full` only
 * when an `@full:` ref is declared.
 *
 * `tokensEst` is a chars/4 heuristic (conservative upper bound).
 */
export interface Artifact {
  /** Unique stable id: `"phase{phaseIdx}:{label}"` (slugified). */
  id: string
  /** Human label (matches AgentSpec.label). */
  label: string
  /** Phase index that produced this artifact. */
  phase: number
  /** ≤40-line summary (head/tail or model-generated). */
  summary: string
  /** Complete raw text returned by the agent. */
  full: string
  /** Estimated token count (chars / 4, rounded up). */
  tokensEst: number
  /** ISO timestamp when the artifact was stored. */
  createdAt: string
}

/**
 * Tiny shared context injected verbatim into every agent's system prompt.
 * Kept small deliberately so it stays cache-friendly.
 */
export interface WorkflowBrief {
  /** Original task from WorkflowSpec.task. */
  task: string
  /** Absolute project root path. */
  directory: string
  /** Short summary of the full planned DAG (phase titles + agent labels). */
  dagSummary: string
  /** Global constraints copied from WorkflowSpec.constraints. */
  constraints: string[]
  /** ISO timestamp the workflow was started. */
  startedAt: string
}

// ---------------------------------------------------------------------------
// Event bus types (emitted by the engine, consumed by dashboard + tests)
// ---------------------------------------------------------------------------

export type WorkflowEvent =
  | {
      type: "phase.start"
      phaseIdx: number
      title: string
      mode: "parallel" | "pipeline" | "single"
      agentCount: number
      timestamp: string
    }
  | {
      type: "agent.start"
      phaseIdx: number
      agentLabel: string
      agentType: string
      model: string
      sessionId: string
      timestamp: string
    }
  | {
      type: "agent.activity"
      phaseIdx: number
      agentLabel: string
      sessionId: string
      /** Last ~3 lines of the current assistant turn (for the dashboard detail pane). */
      preview: string
      timestamp: string
    }
  | {
      type: "agent.done"
      phaseIdx: number
      agentLabel: string
      sessionId: string
      artifactId: string
      tokensEst: number
      durationMs: number
      /** Whether the agent succeeded (false = threw, result stored as null). */
      ok: boolean
      timestamp: string
    }
  | {
      type: "workflow.done"
      title: string
      phasesCompleted: number
      agentsCompleted: number
      agentsFailed: number
      durationMs: number
      /** Synthesized final text returned by the tool. */
      result: string
      timestamp: string
    }

// ---------------------------------------------------------------------------
// Drift-watcher verdict (structured output from the drift-watcher agent turn)
// ---------------------------------------------------------------------------

/**
 * Structured JSON the drift-watcher agent must return.
 *
 * - `drifted`       false → no action taken; the drift loop logs and moves on.
 * - `severity`
 *     "report"  → inject a correction note into the blackboard and send a
 *                 nudge to the orchestrator via promptAsync.
 *     "respawn" → abort the drifted child session and re-run the node with
 *                 `clearerPrompt` appended to the original.
 * - `target`        sessionId of the drifted child (MUST match an active id in
 *                   the WorkflowRegistry).
 * - `reason`        one-sentence human-readable explanation logged + shown in
 *                   the dashboard.
 * - `clearerPrompt` required when severity is "respawn"; appended to the
 *                   original agent prompt for the re-run.
 */
export interface DriftVerdict {
  drifted: boolean
  severity: "report" | "respawn"
  target: string
  reason: string
  clearerPrompt: string
}
