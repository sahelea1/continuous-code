/**
 * Pure state reducer for the workflow TUI (plan: standalone TUI consumer).
 *
 * NO terminal/IO code in this file — it must be unit-testable in isolation.
 * `reduce(state, event)` folds incoming WorkflowEvents into a tree of
 * phases → agents, plus UI-only fields (selection indices, drill level,
 * spinner frame). `tick(state)` advances the spinner animation only.
 *
 * Status glyph semantics (mirrors live-analysis.md's captured behavior):
 *  - "pending"   — not started yet (◯)
 *  - "active"    — running (●)
 *  - "done"      — completed (agent.done with ok=true, or phase whose
 *                  agents are all done) (✔)
 *  - "failed"    — agent.done with ok=false (also rendered distinctly)
 */

import type { WorkflowEvent } from "../types.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AgentStatus = "pending" | "active" | "done" | "failed"
export type PhaseStatus = "pending" | "active" | "done"

/** One agent row inside a phase. */
export interface AgentState {
  label: string
  agentType: string
  model: string
  sessionId: string
  status: AgentStatus
  /** Rolling buffer of the last few agent.activity preview lines. */
  activity: string[]
  /** Populated once agent.done arrives. */
  artifactId?: string
  tokensEst?: number
  durationMs?: number
  ok?: boolean
  /** ms epoch when agent.start was observed (for elapsed-time rendering). */
  startedAtMs?: number
  /** ms epoch when agent.done was observed. */
  doneAtMs?: number
}

/** One phase row, containing its agents in start order. */
export interface PhaseState {
  phaseIdx: number
  title: string
  mode: "parallel" | "pipeline" | "single"
  agentCount: number
  status: PhaseStatus
  /** Agents in the order their agent.start events arrived. */
  agents: AgentState[]
  startedAtMs?: number
}

/** Which nested view is currently focused. */
export type DrillLevel = "phases" | "agents" | "detail"

/** Summary populated once workflow.done arrives. */
export interface WorkflowSummary {
  title: string
  phasesCompleted: number
  agentsCompleted: number
  agentsFailed: number
  durationMs: number
  result: string
}

export interface TuiState {
  /** Workflow title; best-effort from the first phase.start's context, falls
   * back to workflow.done's title, or a placeholder until known. */
  title: string
  phases: PhaseState[]
  /** Index into `phases` of the currently selected phase row. */
  selectedPhaseIdx: number
  /** Index into the selected phase's `agents` of the currently selected
   * agent row (only meaningful once drilled past "phases"). */
  selectedAgentIdx: number
  drillLevel: DrillLevel
  /** Spinner animation frame index, advanced only by `tick()`. */
  spinnerFrame: number
  /** Set once a workflow.done event arrives. */
  summary: WorkflowSummary | null
  /** True once any event has been processed (used to render an initial
   * "waiting for events" placeholder vs. a real empty state). */
  hasReceivedEvents: boolean
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export function createInitialState(): TuiState {
  return {
    title: "workflow",
    phases: [],
    selectedPhaseIdx: 0,
    selectedAgentIdx: 0,
    drillLevel: "phases",
    spinnerFrame: 0,
    summary: null,
    hasReceivedEvents: false,
  }
}

// ---------------------------------------------------------------------------
// Spinner animation
// ---------------------------------------------------------------------------

export const SPINNER_FRAMES = ["✽", "✶", "✳", "✻", "·"] as const

/** Advance the spinner animation by one frame. Does not touch anything else. */
export function tick(state: TuiState): TuiState {
  return {
    ...state,
    spinnerFrame: (state.spinnerFrame + 1) % SPINNER_FRAMES.length,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampIndex(idx: number, length: number): number {
  if (length <= 0) return 0
  if (idx < 0) return 0
  if (idx >= length) return length - 1
  return idx
}

function recomputePhaseStatus(phase: PhaseState): PhaseStatus {
  if (phase.agents.length === 0) {
    return phase.status === "done" ? "done" : phase.status
  }
  const allDone = phase.agents.every(
    (a) => a.status === "done" || a.status === "failed",
  )
  if (allDone && phase.agents.length >= phase.agentCount) return "done"
  return "active"
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Fold one WorkflowEvent into the previous TuiState, returning a new state.
 * Pure: never mutates `state` in place.
 */
export function reduce(state: TuiState, event: WorkflowEvent): TuiState {
  const next: TuiState = {
    ...state,
    phases: state.phases.slice(),
    hasReceivedEvents: true,
  }

  switch (event.type) {
    case "phase.start": {
      const existingIdx = next.phases.findIndex(
        (p) => p.phaseIdx === event.phaseIdx,
      )
      const phase: PhaseState = {
        phaseIdx: event.phaseIdx,
        title: event.title,
        mode: event.mode,
        agentCount: event.agentCount,
        status: "active",
        agents: existingIdx >= 0 ? next.phases[existingIdx]!.agents : [],
        startedAtMs: Date.parse(event.timestamp) || Date.now(),
      }
      if (existingIdx >= 0) {
        next.phases[existingIdx] = { ...phase, agents: next.phases[existingIdx]!.agents }
      } else {
        next.phases.push(phase)
      }
      return next
    }

    case "agent.start": {
      const phaseIdx = ensurePhase(next, event.phaseIdx)
      const phase = next.phases[phaseIdx]!
      const agents = phase.agents.slice()
      const existingAgentIdx = agents.findIndex(
        (a) => a.label === event.agentLabel,
      )
      const agent: AgentState = {
        label: event.agentLabel,
        agentType: event.agentType,
        model: event.model,
        sessionId: event.sessionId,
        status: "active",
        activity: existingAgentIdx >= 0 ? agents[existingAgentIdx]!.activity : [],
        startedAtMs: Date.parse(event.timestamp) || Date.now(),
      }
      if (existingAgentIdx >= 0) {
        agents[existingAgentIdx] = agent
      } else {
        agents.push(agent)
      }
      next.phases[phaseIdx] = {
        ...phase,
        agents,
        status: recomputePhaseStatus({ ...phase, agents }),
      }
      return next
    }

    case "agent.activity": {
      const phaseIdx = ensurePhase(next, event.phaseIdx)
      const phase = next.phases[phaseIdx]!
      const agents = phase.agents.slice()
      const agentIdx = agents.findIndex((a) => a.label === event.agentLabel)
      if (agentIdx < 0) {
        // Activity for an agent we haven't seen agent.start for yet — create
        // a placeholder row so nothing is silently dropped.
        agents.push({
          label: event.agentLabel,
          agentType: "",
          model: "",
          sessionId: event.sessionId,
          status: "active",
          activity: [event.preview],
        })
      } else {
        const prevActivity = agents[agentIdx]!.activity
        const ACTIVITY_LIMIT = 5
        agents[agentIdx] = {
          ...agents[agentIdx]!,
          activity: [...prevActivity, event.preview].slice(-ACTIVITY_LIMIT),
        }
      }
      next.phases[phaseIdx] = { ...phase, agents }
      return next
    }

    case "agent.done": {
      const phaseIdx = ensurePhase(next, event.phaseIdx)
      const phase = next.phases[phaseIdx]!
      const agents = phase.agents.slice()
      const agentIdx = agents.findIndex((a) => a.label === event.agentLabel)
      const doneAtMs = Date.parse(event.timestamp) || Date.now()
      if (agentIdx < 0) {
        agents.push({
          label: event.agentLabel,
          agentType: "",
          model: "",
          sessionId: event.sessionId,
          status: event.ok ? "done" : "failed",
          activity: [],
          artifactId: event.artifactId,
          tokensEst: event.tokensEst,
          durationMs: event.durationMs,
          ok: event.ok,
          doneAtMs,
        })
      } else {
        agents[agentIdx] = {
          ...agents[agentIdx]!,
          status: event.ok ? "done" : "failed",
          artifactId: event.artifactId,
          tokensEst: event.tokensEst,
          durationMs: event.durationMs,
          ok: event.ok,
          doneAtMs,
        }
      }
      const updatedPhase = { ...phase, agents }
      next.phases[phaseIdx] = {
        ...updatedPhase,
        status: recomputePhaseStatus(updatedPhase),
      }
      return next
    }

    case "workflow.done": {
      next.title = event.title
      next.summary = {
        title: event.title,
        phasesCompleted: event.phasesCompleted,
        agentsCompleted: event.agentsCompleted,
        agentsFailed: event.agentsFailed,
        durationMs: event.durationMs,
        result: event.result,
      }
      // Mark every phase/agent that wasn't explicitly done as done so the
      // final view doesn't show stale spinners.
      next.phases = next.phases.map((p) => ({
        ...p,
        status: "done",
        agents: p.agents.map((a) =>
          a.status === "active" ? { ...a, status: "done" as AgentStatus } : a,
        ),
      }))
      return next
    }

    default:
      return next
  }
}

/** Ensure `phases` has an entry for `phaseIdx`; returns its array index.
 * Used defensively when agent.* events arrive before/without phase.start
 * (should not happen in practice, but keeps the reducer total). */
function ensurePhase(state: TuiState, phaseIdx: number): number {
  const idx = state.phases.findIndex((p) => p.phaseIdx === phaseIdx)
  if (idx >= 0) return idx
  state.phases.push({
    phaseIdx,
    title: `Phase ${phaseIdx + 1}`,
    mode: "single",
    agentCount: 0,
    status: "active",
    agents: [],
  })
  return state.phases.length - 1
}

// ---------------------------------------------------------------------------
// Navigation (keyboard-driven, but still pure — keyboard.ts maps raw bytes
// to these semantic actions, cli.ts wires them up).
// ---------------------------------------------------------------------------

export type NavAction = "up" | "down" | "enter" | "back"

export function navigate(state: TuiState, action: NavAction): TuiState {
  switch (action) {
    case "up":
      return moveSelection(state, -1)
    case "down":
      return moveSelection(state, 1)
    case "enter":
      return drillIn(state)
    case "back":
      return drillOut(state)
    default:
      return state
  }
}

function moveSelection(state: TuiState, delta: number): TuiState {
  if (state.drillLevel === "phases") {
    return {
      ...state,
      selectedPhaseIdx: clampIndex(
        state.selectedPhaseIdx + delta,
        state.phases.length,
      ),
    }
  }
  if (state.drillLevel === "agents") {
    const phase = state.phases[state.selectedPhaseIdx]
    const len = phase ? phase.agents.length : 0
    return {
      ...state,
      selectedAgentIdx: clampIndex(state.selectedAgentIdx + delta, len),
    }
  }
  // "detail" level has nothing to move between (single agent focus); no-op.
  return state
}

function drillIn(state: TuiState): TuiState {
  if (state.drillLevel === "phases") {
    if (state.phases.length === 0) return state
    return { ...state, drillLevel: "agents", selectedAgentIdx: 0 }
  }
  if (state.drillLevel === "agents") {
    const phase = state.phases[state.selectedPhaseIdx]
    if (!phase || phase.agents.length === 0) return state
    return { ...state, drillLevel: "detail" }
  }
  return state
}

function drillOut(state: TuiState): TuiState {
  if (state.drillLevel === "detail") {
    return { ...state, drillLevel: "agents" }
  }
  if (state.drillLevel === "agents") {
    return { ...state, drillLevel: "phases", selectedAgentIdx: 0 }
  }
  return state
}
