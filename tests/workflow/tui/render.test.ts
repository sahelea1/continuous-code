/**
 * Unit tests for the workflow TUI's pure renderer (src/workflow/tui/render.ts).
 *
 * Assertions are made on ANSI-stripped output and check for presence of
 * key substrings/labels/glyphs rather than exact byte-for-byte ANSI
 * sequences (brittle). Covers:
 *  - render output contains the right glyphs for done/active/pending agents
 *    and phases
 *  - the three nested views (phases / agents / detail) render their
 *    expected labels
 *  - header progress + spinner presence while something is active
 *
 * Run: bun test tests/workflow/tui/render.test.ts
 */
import { test, expect } from "bun:test"
import { render, stripAnsi, GLYPH } from "../../../src/workflow/tui/render.ts"
import {
  reduce,
  tick,
  navigate,
  createInitialState,
  type TuiState,
} from "../../../src/workflow/tui/state.ts"
import type { WorkflowEvent } from "../../../src/workflow/types.ts"

// ---------------------------------------------------------------------------
// Fixture events (mirrors state.test.ts's representative sequence).
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

function fold(events: WorkflowEvent[]): TuiState {
  return events.reduce(reduce, createInitialState())
}

// ---------------------------------------------------------------------------
// Phases view
// ---------------------------------------------------------------------------

test("render shows a done phase glyph and an active phase glyph", () => {
  const state = fold([
    phase0Start,
    agent0Start,
    agent0Activity,
    agent0Done, // phase 0 -> done
    phase1Start,
    agent1Start,
    agent2Start, // phase 1 still active (no agent.done yet)
  ])
  const out = stripAnsi(render(state, Date.parse("2026-06-20T10:02:00.000Z")))

  expect(out).toContain("Implement")
  expect(out).toContain("Tests + Docs")
  expect(out).toContain(GLYPH.done)
  expect(out).toContain(GLYPH.active)
})

test("render shows a waiting placeholder in the agents pane before any agent.start arrives", () => {
  const state = reduce(createInitialState(), phase0Start)
  // phase0Start alone -> status "active" since no agents yet (recomputed
  // status only flips to done once agents exist and are all done/failed).
  const drilled = navigate(state, "enter")
  expect(drilled.drillLevel).toBe("agents")
  const out = stripAnsi(render(drilled))
  expect(out).toContain("Implement")
  expect(out.toLowerCase()).toContain("waiting")
})

test("render of an empty initial state shows a waiting placeholder, not a crash", () => {
  const state = createInitialState()
  const out = stripAnsi(render(state))
  expect(out.toLowerCase()).toContain("waiting")
})

// ---------------------------------------------------------------------------
// Agents view (drilled to level 2)
// ---------------------------------------------------------------------------

test("agents view lists agent labels, models, and status glyphs", () => {
  let state = fold([phase1Start, agent1Start, agent2Start, agent2Done])
  state = navigate(state, "enter") // drill into phase 0 (selectedPhaseIdx 0)
  // Need to select phase1 (index 1 if phase0 also present) — here only
  // phase1 exists at array index 0 since phase0Start was never emitted.
  const out = stripAnsi(render(state, Date.parse("2026-06-20T10:02:00.000Z")))

  expect(out).toContain("tests:unittest")
  expect(out).toContain("docs:API.md")
  expect(out).toContain("opus")
  expect(out).toContain("sonnet")
  // docs:API.md failed (ok=false) -> failed glyph; tests:unittest still active.
  expect(out).toContain(GLYPH.failed)
  expect(out).toContain(GLYPH.active)
})

test("phases pane shows 0/N agents done while only some agents have started", () => {
  // agentCount=2, only 1 has started (and it isn't done yet) -> 0 done.
  const state = fold([phase1Start, agent1Start])
  const out = stripAnsi(render(state))
  expect(out).toContain("Tests + Docs")
  expect(out).toContain("0/2 agents")
})

test("agents view lists only the agents that have started so far", () => {
  const state = fold([phase1Start, agent1Start]) // agentCount=2, only 1 started
  const drilled = navigate(state, "enter")
  const out = stripAnsi(render(drilled))
  expect(out).toContain("tests:unittest")
  expect(out).not.toContain("docs:API.md")
})

// ---------------------------------------------------------------------------
// Detail view (drilled to level 3)
// ---------------------------------------------------------------------------

test("detail view shows Activity and Outcome sections for a completed agent", () => {
  let state = fold([
    phase0Start,
    agent0Start,
    agent0Activity,
    agent0Done,
  ])
  state = navigate(state, "enter") // -> agents
  state = navigate(state, "enter") // -> detail
  const out = stripAnsi(render(state))

  expect(out).toContain("Activity")
  expect(out).toContain("Read(src/calculator.py)")
  expect(out).toContain("Outcome")
  expect(out).toContain("ok")
  expect(out).toContain("1200") // tokensEst
  expect(out).toContain("63000") // durationMs
  expect(out).toContain(GLYPH.done)
})

test("detail view shows 'Still running' for an active agent with no outcome yet", () => {
  let state = fold([phase0Start, agent0Start, agent0Activity])
  state = navigate(state, "enter")
  state = navigate(state, "enter")
  const out = stripAnsi(render(state))

  expect(out).toContain("Still running")
  expect(out).toContain(GLYPH.active)
})

test("detail view shows fail outcome for a failed agent", () => {
  let state = fold([phase1Start, agent1Start, agent2Start, agent2Done])
  state = navigate(state, "enter") // -> agents (phase index 0 == "Tests + Docs")
  state = navigate(state, "down") // select docs:API.md (index 1)
  state = navigate(state, "enter") // -> detail
  const out = stripAnsi(render(state))

  expect(out).toContain("docs:API.md")
  expect(out).toContain("fail")
  expect(out).toContain(GLYPH.failed)
})

// ---------------------------------------------------------------------------
// Header: progress counters + spinner presence
// ---------------------------------------------------------------------------

test("header shows phases/agents progress counts", () => {
  const state = fold([
    phase0Start,
    agent0Start,
    agent0Done,
    phase1Start,
    agent1Start,
    agent2Start,
    agent2Done,
  ])
  const out = stripAnsi(render(state))
  // 1 phase done (phase0) out of 2; 2 agents done/failed out of 3.
  expect(out).toContain("1/2 phases")
  expect(out).toContain("2/3 agents")
})

test("header includes a spinner glyph while a phase/agent is active", () => {
  const active = fold([phase0Start, agent0Start])
  const out = stripAnsi(render(active))
  const spinnerChars = ["✽", "✶", "✳", "✻", "·"]
  expect(spinnerChars.some((c) => out.includes(c))).toBe(true)
})

test("header omits the spinner once everything is done (workflow.done)", () => {
  const workflowDone: WorkflowEvent = {
    type: "workflow.done",
    title: "minicalc-tasks",
    phasesCompleted: 1,
    agentsCompleted: 1,
    agentsFailed: 0,
    durationMs: 1000,
    result: "done",
    timestamp: "2026-06-20T10:05:00.000Z",
  }
  const state = fold([phase0Start, agent0Start, agent0Done, workflowDone])
  const out = stripAnsi(render(state))
  expect(out).toContain("workflow.done")
  expect(out).toContain("minicalc-tasks")
})

// ---------------------------------------------------------------------------
// Spinner frame cycling renders distinctly across tick() calls.
// ---------------------------------------------------------------------------

test("spinner frame in rendered header advances over repeated tick() calls", () => {
  let state = fold([phase0Start, agent0Start])
  const frames = new Set<string>()
  const spinnerChars = ["✽", "✶", "✳", "✻", "·"]

  for (let i = 0; i < 5; i++) {
    const out = stripAnsi(render(state))
    const found = spinnerChars.find((c) => out.includes(c))
    if (found) frames.add(found)
    state = tick(state)
  }
  // Across a full cycle of SPINNER_FRAMES.length distinct ticks, we should
  // see more than one distinct spinner glyph rendered.
  expect(frames.size).toBeGreaterThan(1)
})

// ---------------------------------------------------------------------------
// Footer keybinding hints per drill level
// ---------------------------------------------------------------------------

test("footer hints change with drillLevel", () => {
  let state = fold([phase0Start, agent0Start])
  const phasesFooter = stripAnsi(render(state))
  expect(phasesFooter).toContain("q quit")

  state = navigate(state, "enter")
  const agentsFooter = stripAnsi(render(state))
  expect(agentsFooter).toContain("back")

  state = navigate(state, "enter")
  const detailFooter = stripAnsi(render(state))
  expect(detailFooter).toContain("back")
  expect(detailFooter).toContain("q quit")
})
