/**
 * Unit tests for the workflow TUI's pure reducer (src/workflow/tui/state.ts).
 *
 * Covers:
 *  - reducer builds the correct phase/agent tree from a representative
 *    event sequence (phase.start -> agent.start -> agent.activity ->
 *    agent.done -> workflow.done)
 *  - selection/drill-down state transitions (enter/back) are correct
 *  - spinner frame cycling advances over repeated tick() calls
 *
 * Run: bun test tests/workflow/tui/state.test.ts
 */
import { test, expect } from "bun:test"
import {
  reduce,
  tick,
  navigate,
  createInitialState,
  SPINNER_FRAMES,
  type TuiState,
} from "../../../src/workflow/tui/state.ts"
import type { WorkflowEvent } from "../../../src/workflow/types.ts"

// ---------------------------------------------------------------------------
// Fixture: a representative event sequence for a 2-phase workflow.
// ---------------------------------------------------------------------------

const phase0Start: WorkflowEvent = {
  type: "phase.start",
  phaseIdx: 0,
  title: "Implement",
  mode: "single",
  agentCount: 1,
  timestamp: "2026-06-20T10:00:00.000Z",
}

const agent0Start: WorkflowEvent = {
  type: "agent.start",
  phaseIdx: 0,
  agentLabel: "impl:source",
  agentType: "implementer",
  model: "opus",
  sessionId: "sess-1",
  timestamp: "2026-06-20T10:00:01.000Z",
}

const agent0Activity: WorkflowEvent = {
  type: "agent.activity",
  phaseIdx: 0,
  agentLabel: "impl:source",
  sessionId: "sess-1",
  preview: "Read(src/calculator.py)",
  timestamp: "2026-06-20T10:00:05.000Z",
}

const agent0Done: WorkflowEvent = {
  type: "agent.done",
  phaseIdx: 0,
  agentLabel: "impl:source",
  sessionId: "sess-1",
  artifactId: "phase0:impl-source",
  tokensEst: 1200,
  durationMs: 63000,
  ok: true,
  timestamp: "2026-06-20T10:01:04.000Z",
}

const phase1Start: WorkflowEvent = {
  type: "phase.start",
  phaseIdx: 1,
  title: "Tests + Docs",
  mode: "parallel",
  agentCount: 2,
  timestamp: "2026-06-20T10:01:05.000Z",
}

const agent1Start: WorkflowEvent = {
  type: "agent.start",
  phaseIdx: 1,
  agentLabel: "tests:unittest",
  agentType: "tester",
  model: "opus",
  sessionId: "sess-2",
  timestamp: "2026-06-20T10:01:06.000Z",
}

const agent2Start: WorkflowEvent = {
  type: "agent.start",
  phaseIdx: 1,
  agentLabel: "docs:API.md",
  agentType: "writer",
  model: "sonnet",
  sessionId: "sess-3",
  timestamp: "2026-06-20T10:01:06.500Z",
}

const agent2Done: WorkflowEvent = {
  type: "agent.done",
  phaseIdx: 1,
  agentLabel: "docs:API.md",
  sessionId: "sess-3",
  artifactId: "phase1:docs-api-md",
  tokensEst: 800,
  durationMs: 30000,
  ok: false,
  timestamp: "2026-06-20T10:01:40.000Z",
}

const workflowDone: WorkflowEvent = {
  type: "workflow.done",
  title: "minicalc-tasks",
  phasesCompleted: 2,
  agentsCompleted: 2,
  agentsFailed: 1,
  durationMs: 338000,
  result: "All tasks completed; docs agent failed.",
  timestamp: "2026-06-20T10:05:00.000Z",
}

function fold(events: WorkflowEvent[]): TuiState {
  return events.reduce(reduce, createInitialState())
}

// ---------------------------------------------------------------------------
// Tree-building tests
// ---------------------------------------------------------------------------

test("createInitialState starts empty with phases view focused", () => {
  const state = createInitialState()
  expect(state.phases).toEqual([])
  expect(state.drillLevel).toBe("phases")
  expect(state.selectedPhaseIdx).toBe(0)
  expect(state.selectedAgentIdx).toBe(0)
  expect(state.spinnerFrame).toBe(0)
  expect(state.summary).toBeNull()
  expect(state.hasReceivedEvents).toBe(false)
})

test("phase.start adds a phase row with status active", () => {
  const state = reduce(createInitialState(), phase0Start)
  expect(state.phases.length).toBe(1)
  expect(state.phases[0]?.title).toBe("Implement")
  expect(state.phases[0]?.mode).toBe("single")
  expect(state.phases[0]?.agentCount).toBe(1)
  expect(state.phases[0]?.status).toBe("active")
  expect(state.hasReceivedEvents).toBe(true)
})

test("agent.start adds an agent row under the correct phase", () => {
  const state = fold([phase0Start, agent0Start])
  expect(state.phases[0]?.agents.length).toBe(1)
  const agent = state.phases[0]?.agents[0]
  expect(agent?.label).toBe("impl:source")
  expect(agent?.agentType).toBe("implementer")
  expect(agent?.model).toBe("opus")
  expect(agent?.status).toBe("active")
})

test("agent.activity appends to the agent's rolling activity buffer", () => {
  const state = fold([phase0Start, agent0Start, agent0Activity])
  const agent = state.phases[0]?.agents[0]
  expect(agent?.activity).toEqual(["Read(src/calculator.py)"])
})

test("agent.activity caps the rolling buffer at the last few entries", () => {
  const many: WorkflowEvent[] = Array.from({ length: 8 }, (_, i) => ({
    type: "agent.activity",
    phaseIdx: 0,
    agentLabel: "impl:source",
    sessionId: "sess-1",
    preview: `step ${i}`,
    timestamp: "2026-06-20T10:00:05.000Z",
  }))
  const state = fold([phase0Start, agent0Start, ...many])
  const agent = state.phases[0]?.agents[0]
  expect(agent?.activity.length).toBeLessThanOrEqual(5)
  // Most recent entry must be present; oldest ones should have been dropped.
  expect(agent?.activity[agent.activity.length - 1]).toBe("step 7")
  expect(agent?.activity).not.toContain("step 0")
})

test("agent.done marks the agent done/failed and records outcome fields", () => {
  const state = fold([phase0Start, agent0Start, agent0Done])
  const agent = state.phases[0]?.agents[0]
  expect(agent?.status).toBe("done")
  expect(agent?.ok).toBe(true)
  expect(agent?.tokensEst).toBe(1200)
  expect(agent?.durationMs).toBe(63000)
  expect(agent?.artifactId).toBe("phase0:impl-source")
})

test("agent.done with ok=false marks the agent failed", () => {
  const state = fold([phase1Start, agent1Start, agent2Start, agent2Done])
  const docsAgent = state.phases
    .find((p) => p.phaseIdx === 1)
    ?.agents.find((a) => a.label === "docs:API.md")
  expect(docsAgent?.status).toBe("failed")
  expect(docsAgent?.ok).toBe(false)
})

test("phase status becomes done only once all its agents are done/failed", () => {
  // Only one of two agents in phase 1 is done -> phase still active.
  const partial = fold([phase1Start, agent1Start, agent2Start, agent2Done])
  expect(partial.phases.find((p) => p.phaseIdx === 1)?.status).toBe("active")

  const agent1Done: WorkflowEvent = {
    type: "agent.done",
    phaseIdx: 1,
    agentLabel: "tests:unittest",
    sessionId: "sess-2",
    artifactId: "phase1:tests-unittest",
    tokensEst: 500,
    durationMs: 20000,
    ok: true,
    timestamp: "2026-06-20T10:01:50.000Z",
  }
  const full = fold([phase1Start, agent1Start, agent2Start, agent2Done, agent1Done])
  expect(full.phases.find((p) => p.phaseIdx === 1)?.status).toBe("done")
})

test("full representative sequence builds the expected 2-phase tree", () => {
  const state = fold([
    phase0Start,
    agent0Start,
    agent0Activity,
    agent0Done,
    phase1Start,
    agent1Start,
    agent2Start,
    agent2Done,
  ])

  expect(state.phases.length).toBe(2)
  expect(state.phases[0]?.status).toBe("done")
  expect(state.phases[0]?.agents.length).toBe(1)
  expect(state.phases[1]?.agents.length).toBe(2)
  expect(state.phases[1]?.agents.map((a) => a.label)).toEqual([
    "tests:unittest",
    "docs:API.md",
  ])
})

test("workflow.done sets summary and forces remaining active items to done", () => {
  const state = fold([
    phase0Start,
    agent0Start,
    agent0Done,
    phase1Start,
    agent1Start, // still active, never gets its own agent.done
    agent2Start,
    agent2Done,
    workflowDone,
  ])

  expect(state.summary).not.toBeNull()
  expect(state.summary?.title).toBe("minicalc-tasks")
  expect(state.summary?.agentsCompleted).toBe(2)
  expect(state.summary?.agentsFailed).toBe(1)
  expect(state.summary?.durationMs).toBe(338000)

  // tests:unittest never got agent.done but workflow.done should force it done.
  const testsAgent = state.phases
    .find((p) => p.phaseIdx === 1)
    ?.agents.find((a) => a.label === "tests:unittest")
  expect(testsAgent?.status).toBe("done")
  expect(state.phases.every((p) => p.status === "done")).toBe(true)
})

test("agent.activity for an unseen agent creates a placeholder row (no events dropped)", () => {
  const orphanActivity: WorkflowEvent = {
    type: "agent.activity",
    phaseIdx: 5,
    agentLabel: "ghost:agent",
    sessionId: "sess-ghost",
    preview: "Bash(ls)",
    timestamp: "2026-06-20T10:00:00.000Z",
  }
  const state = reduce(createInitialState(), orphanActivity)
  const phase = state.phases.find((p) => p.phaseIdx === 5)
  expect(phase).toBeDefined()
  expect(phase?.agents[0]?.label).toBe("ghost:agent")
  expect(phase?.agents[0]?.activity).toEqual(["Bash(ls)"])
})

// ---------------------------------------------------------------------------
// Selection / drill-down navigation tests
// ---------------------------------------------------------------------------

function seededState(): TuiState {
  return fold([phase0Start, agent0Start, phase1Start, agent1Start, agent2Start])
}

test("down/up move selectedPhaseIdx within bounds at the phases level", () => {
  let state = seededState()
  expect(state.selectedPhaseIdx).toBe(0)
  state = navigate(state, "down")
  expect(state.selectedPhaseIdx).toBe(1)
  // Already at last phase; further "down" should clamp, not overflow.
  state = navigate(state, "down")
  expect(state.selectedPhaseIdx).toBe(1)
  state = navigate(state, "up")
  expect(state.selectedPhaseIdx).toBe(0)
  state = navigate(state, "up")
  expect(state.selectedPhaseIdx).toBe(0)
})

test("enter drills from phases -> agents -> detail; back reverses it", () => {
  let state = seededState()
  expect(state.drillLevel).toBe("phases")

  state = navigate(state, "enter")
  expect(state.drillLevel).toBe("agents")
  expect(state.selectedAgentIdx).toBe(0)

  state = navigate(state, "enter")
  expect(state.drillLevel).toBe("detail")

  state = navigate(state, "back")
  expect(state.drillLevel).toBe("agents")

  state = navigate(state, "back")
  expect(state.drillLevel).toBe("phases")

  // back at the top level is a no-op.
  state = navigate(state, "back")
  expect(state.drillLevel).toBe("phases")
})

test("up/down move selectedAgentIdx within the selected phase's agents", () => {
  let state = seededState()
  // Select phase 1 (2 agents), then drill in.
  state = navigate(state, "down") // selectedPhaseIdx -> 1
  state = navigate(state, "enter") // drillLevel -> agents
  expect(state.selectedAgentIdx).toBe(0)
  state = navigate(state, "down")
  expect(state.selectedAgentIdx).toBe(1)
  state = navigate(state, "down")
  expect(state.selectedAgentIdx).toBe(1) // clamp
  state = navigate(state, "up")
  expect(state.selectedAgentIdx).toBe(0)
})

test("enter on a phase with zero agents still drills in (shows a waiting placeholder)", () => {
  const state0 = reduce(createInitialState(), phase0Start)
  // phase0Start declares agentCount 1 but no agent.start fired yet — drilling
  // in is still allowed; the agents pane just has nothing to list yet.
  const state1 = navigate(state0, "enter")
  expect(state1.drillLevel).toBe("agents")
  expect(state1.phases[0]?.agents.length).toBe(0)
})

test("enter is a no-op when there are no phases at all", () => {
  const state0 = createInitialState()
  const state1 = navigate(state0, "enter")
  expect(state1.drillLevel).toBe("phases")
})

test("enter at the agents level is a no-op when the selected phase has zero agents", () => {
  const state0 = reduce(createInitialState(), phase0Start)
  const atAgents = navigate(state0, "enter") // -> agents, 0 agents listed
  const atDetail = navigate(atAgents, "enter") // should NOT advance to detail
  expect(atDetail.drillLevel).toBe("agents")
})

// ---------------------------------------------------------------------------
// Spinner animation tests
// ---------------------------------------------------------------------------

test("tick advances spinnerFrame and wraps around SPINNER_FRAMES.length", () => {
  let state = createInitialState()
  expect(state.spinnerFrame).toBe(0)
  for (let i = 1; i < SPINNER_FRAMES.length; i++) {
    state = tick(state)
    expect(state.spinnerFrame).toBe(i)
  }
  // One more tick wraps back to 0.
  state = tick(state)
  expect(state.spinnerFrame).toBe(0)
})

test("tick does not touch any field other than spinnerFrame", () => {
  const before = fold([phase0Start, agent0Start])
  const after = tick(before)
  expect(after.phases).toEqual(before.phases)
  expect(after.drillLevel).toBe(before.drillLevel)
  expect(after.selectedPhaseIdx).toBe(before.selectedPhaseIdx)
  expect(after.spinnerFrame).toBe((before.spinnerFrame + 1) % SPINNER_FRAMES.length)
})
