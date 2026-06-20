/**
 * Drift-watcher cap-enforcement + report/respawn tests (plan §D.2).
 *
 * The HEADLINE guarantee: the prompt the host actually sends to the drift-watcher
 * agent is ≤40k tokens AND only ~40 lines per child — no matter how large the
 * swept child's transcript is. We prove this with a fully deterministic fake
 * client whose `session.messages` returns a ~200k-token blob; we capture the
 * prompt passed to `session.prompt` and assert it is trimmed BEFORE sending.
 *
 * We also prove the two action paths:
 *   - a `severity:"respawn"` verdict -> `session.abort(target)` + the host's
 *     `respawnNode` re-run with the `clearerPrompt` appended;
 *   - a `severity:"report"` verdict -> a blackboard note + an orchestrator
 *     `promptAsync` nudge, with NO abort.
 *
 * Run: `bun test tests/workflow/drift.test.ts`
 */
import { test, expect } from "bun:test"
import {
  createDriftWatcher,
  parseVerdict,
  truncateToTokens,
  lastLines,
} from "../../src/workflow/drift-watcher.ts"
import { ContextStore, estimateTokens, type WorkflowBrief } from "../../src/workflow/context-store.ts"
import { WorkflowRegistry, type ActiveChild } from "../../src/workflow/registry.ts"
import type { WorkflowConfig } from "../../src/workflow/config.ts"
import type { DriftVerdict } from "../../src/workflow/types.ts"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORCHESTRATOR_ID = "orch-root"

function makeBrief(): WorkflowBrief {
  return {
    task: "add input validation to src/",
    directory: "/repo/test",
    constraints: ["no new deps"],
    dag: "P0: impl | docs",
  }
}

function makeConfig(over: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    enabled: true,
    dashboardEnabled: false,
    dashboardPort: 0,
    concurrency: 4,
    // driftEnabled false so the constructor never arms a real timer in tests —
    // we drive sweep() by hand.
    driftEnabled: false,
    driftIntervalMs: 90_000,
    driftCapTokens: 40_000,
    perAgentContextCapTokens: 60_000,
    maxAgents: 1_000,
    storeLearnings: false,
    ...over,
  }
}

function makeActiveChild(over: Partial<ActiveChild> = {}): ActiveChild {
  return {
    sessionId: "child-1",
    runId: "run-1",
    label: "impl",
    phase: 0,
    model: "anthropic:claude-opus-4",
    agentType: "implementer",
    startedAt: Date.now(),
    ...over,
  }
}

/**
 * A fake v1 client. `session.messages` returns a single huge assistant message
 * (~200k tokens). `session.prompt` (the watcher turn) records the prompt it was
 * given and returns whatever `verdict` text the test queued. `abort` /
 * `promptAsync` / `create` / `log` record their calls.
 */
function makeFakeClient(opts: {
  /** Total chars of the giant assistant blob. */
  blobChars: number
  /** The watcher's JSON verdict text to return from session.prompt. */
  verdictText: string
}) {
  const calls = {
    promptsToWatcher: [] as string[],
    aborts: [] as string[],
    promptAsyncTo: [] as Array<{ id: string; text: string }>,
    creates: 0,
    logs: [] as string[],
  }

  // One assistant message with a huge, line-structured body.
  const lineCount = 600
  const perLine = Math.max(1, Math.floor(opts.blobChars / lineCount))
  const blobLines: string[] = []
  for (let i = 0; i < lineCount; i++) {
    blobLines.push(`LINE-${i} ` + "x".repeat(perLine))
  }
  const blob = blobLines.join("\n")

  const client = {
    app: {
      log: async (a: { body?: { message?: string } }) => {
        if (a?.body?.message) calls.logs.push(a.body.message)
        return { data: true }
      },
    },
    session: {
      messages: async (_a: { path: { id: string } }) => ({
        data: [
          {
            info: { id: "u1", role: "user" },
            parts: [{ type: "text", text: "do the task" }],
          },
          {
            info: { id: "a1", role: "assistant" },
            parts: [{ type: "text", text: blob }],
          },
        ],
      }),
      create: async (_a: unknown) => {
        calls.creates++
        return { data: { id: `watcher-${calls.creates}` } }
      },
      prompt: async (a: { path: { id: string }; body: { parts: Array<{ text: string }> } }) => {
        // Record the EXACT text the host sent to the watcher.
        calls.promptsToWatcher.push(a.body.parts.map((p) => p.text).join(""))
        return {
          data: {
            info: { id: "wmsg", role: "assistant" },
            parts: [{ type: "text", text: opts.verdictText }],
          },
        }
      },
      abort: async (a: { path: { id: string } }) => {
        calls.aborts.push(a.path.id)
        return { data: true }
      },
      promptAsync: async (a: { path: { id: string }; body: { parts: Array<{ text: string }> } }) => {
        calls.promptAsyncTo.push({ id: a.path.id, text: a.body.parts.map((p) => p.text).join("") })
        return { data: { id: "async-msg" } }
      },
    },
  }

  return { client, calls, blob }
}

// ---------------------------------------------------------------------------
// 1. HOST-SIDE ≤40k CAP: prompt sent to the watcher is trimmed before sending
// ---------------------------------------------------------------------------

test("one sweep sends the watcher only ~40 lines per child AND ≤35k-token prompt", async () => {
  // ~200k-token blob (≈800k chars at chars/4).
  const { client, calls } = makeFakeClient({
    blobChars: 800_000,
    verdictText: JSON.stringify({ drifted: false }),
  })
  const config = makeConfig() // driftCapTokens 40_000 -> budget 35_000
  const store = new ContextStore(makeBrief())
  const registry = new WorkflowRegistry()
  registry.register(makeActiveChild())

  const watcher = createDriftWatcher({
    client: client as never,
    config,
    store,
    brief: makeBrief(),
    registry,
    orchestratorID: ORCHESTRATOR_ID,
  })

  await watcher.sweep()
  watcher.dispose()

  // Exactly one watcher turn ran.
  expect(calls.promptsToWatcher.length).toBe(1)
  const sent = calls.promptsToWatcher[0]

  // (a) ≤35k-token budget: driftCapTokens(40k) - headroom(5k) = 35k. The host
  //     truncates BEFORE sending, so the watcher can never receive >~40k.
  const budget = config.driftCapTokens - 5_000
  expect(estimateTokens(sent)).toBeLessThanOrEqual(budget)
  // And it is far smaller than the 200k-token source blob.
  expect(estimateTokens(sent)).toBeLessThan(200_000)

  // (b) Only ~40 lines of the AGENT SNAPSHOT made it in. Isolate the snapshot
  //     block and count its data lines (excluding our header/footer scaffolding).
  const snapStart = sent.indexOf("--- output ---")
  expect(snapStart).toBeGreaterThan(-1)
  const afterOutput = sent.slice(snapStart + "--- output ---".length)
  const snapEnd = afterOutput.indexOf("## Your task")
  const snapshotBlock = (snapEnd === -1 ? afterOutput : afterOutput.slice(0, snapEnd)).trim()
  const dataLines = snapshotBlock.split("\n").filter((l) => l.startsWith("LINE-"))
  // We keep the last ~40 lines; allow tail truncation to remove a couple.
  expect(dataLines.length).toBeLessThanOrEqual(40)
  expect(dataLines.length).toBeGreaterThan(0)
  // The lines kept are the TAIL of the transcript (most-recent), not the head.
  expect(snapshotBlock).toContain("LINE-599")
  expect(snapshotBlock).not.toContain("LINE-0 ")
})

// ---------------------------------------------------------------------------
// 2. RESPAWN verdict -> abort(target) + respawnNode re-run with clearerPrompt
// ---------------------------------------------------------------------------

test("respawn verdict aborts the target and re-runs the node with clearerPrompt appended", async () => {
  const verdict: DriftVerdict = {
    drifted: true,
    severity: "respawn",
    target: "child-1",
    reason: "agent is editing unrelated files",
    clearerPrompt: "ONLY add validation to src/input.ts; touch nothing else.",
  }
  const { client, calls } = makeFakeClient({
    blobChars: 4_000,
    verdictText: JSON.stringify(verdict),
  })
  const config = makeConfig()
  const store = new ContextStore(makeBrief())
  const registry = new WorkflowRegistry()
  registry.register(makeActiveChild({ sessionId: "child-1", label: "impl" }))

  const respawns: Array<{ label: string; clarified: string }> = []
  const watcher = createDriftWatcher({
    client: client as never,
    config,
    store,
    brief: makeBrief(),
    registry,
    orchestratorID: ORCHESTRATOR_ID,
    respawnNode: (drifted, clarified) => {
      respawns.push({ label: drifted.label, clarified })
      return "child-1b" // fresh session id
    },
  })

  await watcher.sweep()
  watcher.dispose()

  // The drifted child was aborted (alongside per-sweep watcher-session hygiene aborts).
  expect(calls.aborts).toContain("child-1")
  // ...and the node was re-run via respawnNode, with the clearerPrompt appended.
  expect(respawns.length).toBe(1)
  expect(respawns[0].label).toBe("impl")
  expect(respawns[0].clarified).toContain(verdict.clearerPrompt)
  expect(respawns[0].clarified).toContain("[drift correction]")
  // A respawn does NOT nudge the orchestrator.
  expect(calls.promptAsyncTo.length).toBe(0)
})

test("respawn cap (2) downgrades a 3rd respawn to a report (no further abort)", async () => {
  const verdict: DriftVerdict = {
    drifted: true,
    severity: "respawn",
    target: "child-1",
    reason: "still off-track",
    clearerPrompt: "Refocus on the brief.",
  }
  const { client, calls } = makeFakeClient({
    blobChars: 2_000,
    verdictText: JSON.stringify(verdict),
  })
  const store = new ContextStore(makeBrief())
  const registry = new WorkflowRegistry()

  const watcher = createDriftWatcher({
    client: client as never,
    config: makeConfig(),
    store,
    brief: makeBrief(),
    registry,
    orchestratorID: ORCHESTRATOR_ID,
    maxRespawns: 2,
    respawnNode: () => "fresh",
  })

  // Re-register the same node label before each sweep (respawnNode would do this
  // in production; here we just keep an active target with the same label).
  for (let i = 0; i < 3; i++) {
    registry.register(makeActiveChild({ sessionId: "child-1", label: "impl" }))
    await watcher.sweep()
  }
  watcher.dispose()

  // Two real respawns (=> two CHILD aborts), then the 3rd is downgraded to a
  // report. (Per-sweep watcher-session aborts are filtered out here.)
  const childAborts = calls.aborts.filter((id) => id === "child-1")
  expect(childAborts.length).toBe(2)
  expect(calls.promptAsyncTo.length).toBe(1) // the downgraded report nudged once
})

// ---------------------------------------------------------------------------
// 3. REPORT verdict -> blackboard note + orchestrator promptAsync, NO abort
// ---------------------------------------------------------------------------

test("report verdict adds a blackboard note + nudges the orchestrator, no abort", async () => {
  const verdict: DriftVerdict = {
    drifted: true,
    severity: "report",
    target: "child-1",
    reason: "misreading the validation requirement",
    clearerPrompt: "",
  }
  const { client, calls } = makeFakeClient({
    blobChars: 4_000,
    verdictText: JSON.stringify(verdict),
  })
  const store = new ContextStore(makeBrief())
  const registry = new WorkflowRegistry()
  registry.register(makeActiveChild({ sessionId: "child-1", label: "impl" }))

  let respawned = false
  const watcher = createDriftWatcher({
    client: client as never,
    config: makeConfig(),
    store,
    brief: makeBrief(),
    registry,
    orchestratorID: ORCHESTRATOR_ID,
    respawnNode: () => {
      respawned = true
      return "x"
    },
  })

  await watcher.sweep()
  watcher.dispose()

  // The drifted CHILD is never aborted on a report (only the watcher session is
  // torn down per-sweep). No respawn.
  expect(calls.aborts).not.toContain("child-1")
  expect(respawned).toBe(false)
  // Blackboard note recorded the drift.
  const notes = store.getNotes()
  expect(notes.some((n) => n.includes("drift detected") && n.includes(verdict.reason))).toBe(true)
  // Orchestrator was nudged exactly once with the reason.
  expect(calls.promptAsyncTo.length).toBe(1)
  expect(calls.promptAsyncTo[0].id).toBe(ORCHESTRATOR_ID)
  expect(calls.promptAsyncTo[0].text).toContain(verdict.reason)
})

// ---------------------------------------------------------------------------
// 4. drifted:false verdict -> no action at all
// ---------------------------------------------------------------------------

test("a not-drifted verdict takes no action", async () => {
  const { client, calls } = makeFakeClient({
    blobChars: 2_000,
    verdictText: JSON.stringify({ drifted: false, severity: "report", target: "child-1", reason: "", clearerPrompt: "" }),
  })
  const store = new ContextStore(makeBrief())
  const registry = new WorkflowRegistry()
  registry.register(makeActiveChild({ sessionId: "child-1" }))

  const watcher = createDriftWatcher({
    client: client as never,
    config: makeConfig(),
    store,
    brief: makeBrief(),
    registry,
    orchestratorID: ORCHESTRATOR_ID,
    respawnNode: () => "x",
  })

  await watcher.sweep()
  watcher.dispose()

  expect(calls.aborts).not.toContain("child-1")
  expect(calls.promptAsyncTo.length).toBe(0)
  expect(store.getNotes().length).toBe(0)
})

// ---------------------------------------------------------------------------
// 5. Pure helpers
// ---------------------------------------------------------------------------

test("truncateToTokens keeps the tail and respects the chars/4 budget", () => {
  const text = Array.from({ length: 1000 }, (_, i) => `row-${i}`).join("\n")
  const out = truncateToTokens(text, 50) // 50 tokens => ~200 chars
  expect(estimateTokens(out)).toBeLessThanOrEqual(50)
  expect(out.endsWith("row-999")).toBe(true) // tail preserved
})

test("lastLines keeps only the trailing N lines", () => {
  const text = Array.from({ length: 100 }, (_, i) => `L${i}`).join("\n")
  const out = lastLines(text, 40)
  const lines = out.split("\n")
  expect(lines.length).toBe(40)
  expect(lines[lines.length - 1]).toBe("L99")
  expect(lines[0]).toBe("L60")
})

test("parseVerdict tolerates code fences and defaults severity to report", () => {
  const v = parseVerdict('```json\n{"drifted":true,"severity":"weird","target":"t","reason":"r","clearerPrompt":""}\n```')
  expect(v).not.toBeNull()
  expect(v!.drifted).toBe(true)
  expect(v!.severity).toBe("report") // unknown severity -> report
  expect(v!.target).toBe("t")
})

test("parseVerdict returns null when no drifted flag is present", () => {
  expect(parseVerdict("no json here")).toBeNull()
  expect(parseVerdict('{"severity":"report"}')).toBeNull()
})
