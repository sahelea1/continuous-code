/**
 * Engine fan-out + pipeline-streaming tests (plan §D.1).
 *
 * Proves the HEADLINE claim with a fully deterministic fake client (no live
 * model): `session.prompt` resolves after a small delay and records each turn's
 * {start,end}. We then:
 *
 *  1. drive `parallel([a, b, c])` and ASSERT the three turns OVERLAP in time
 *     (max(end) - min(start) < sum(durations)) — i.e. they ran concurrently,
 *     not serially — AND that all three child sessions were created with the
 *     run's parent id;
 *  2. drive `pipeline(items, stage1, stage2)` and ASSERT NO BARRIER: item[1]
 *     enters stage 1 before item[0] finishes stage 2.
 *
 * Run: `bun test tests/workflow/engine.fanout.test.ts`
 */
import { test, expect } from "bun:test"
import { createEngine } from "../../src/workflow/engine.ts"
import { WorkflowRegistry } from "../../src/workflow/registry.ts"
import { ModelResolver } from "../../src/workflow/model-resolver.ts"
import type { WorkflowBrief } from "../../src/workflow/context-store.ts"
import type { WorkflowConfig } from "../../src/workflow/config.ts"

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const PARENT_ID = "parent-session-xyz"

interface PromptRecord {
  sessionId: string
  start: number
  end: number
  agent: string
  model: { providerID: string; modelID: string }
  text: string
}

interface CreateRecord {
  parentID?: string
  title?: string
  returnedId: string
}

/**
 * A fake OpenCode v1 client. `session.prompt` sleeps `delayMs` and records a
 * timestamped interval; `session.create` records the create call and returns a
 * unique child id. `app.agents`/`app.log` are stubbed. The brief carries a
 * `parentID` so `createChild` threads it through (proving the parent linkage).
 */
function makeFakeClient(delayMs: number) {
  const prompts: PromptRecord[] = []
  const creates: CreateRecord[] = []
  let childSeq = 0

  const client = {
    app: {
      agents: async () => ({
        data: [
          { name: "general", model: { providerID: "anthropic", modelID: "claude-sonnet-4" } },
          { name: "implementer", model: { providerID: "anthropic", modelID: "claude-opus-4" } },
        ],
      }),
      log: async () => ({ data: true }),
    },
    session: {
      create: async (args: { body?: { parentID?: string; title?: string } }) => {
        const returnedId = `child-${++childSeq}`
        creates.push({
          parentID: args?.body?.parentID,
          title: args?.body?.title,
          returnedId,
        })
        return { data: { id: returnedId, parentID: args?.body?.parentID } }
      },
      prompt: async (args: {
        path: { id: string }
        body: {
          parts: Array<{ type: string; text: string }>
          agent?: string
          model?: { providerID: string; modelID: string }
          system?: string
        }
      }) => {
        const start = Date.now()
        await sleep(delayMs)
        const end = Date.now()
        const text = `result for ${args.path.id}`
        prompts.push({
          sessionId: args.path.id,
          start,
          end,
          agent: args.body.agent ?? "",
          model: args.body.model ?? { providerID: "", modelID: "" },
          text,
        })
        return {
          data: {
            info: { id: `msg-${args.path.id}`, role: "assistant" },
            parts: [{ type: "text", text }],
          },
        }
      },
    },
  }

  return { client, prompts, creates }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function makeBrief(): WorkflowBrief & { parentID: string } {
  return {
    task: "fan-out test",
    directory: "/repo/test",
    constraints: ["no real model"],
    dag: "P0: a | b | c",
    // Smuggled parent id read by engine.createChild (getParentId).
    parentID: PARENT_ID,
  }
}

function makeConfig(concurrency: number): WorkflowConfig {
  return {
    enabled: true,
    dashboardEnabled: false,
    dashboardPort: 0,
    concurrency,
    driftEnabled: false,
    driftIntervalMs: 90_000,
    driftCapTokens: 40_000,
    perAgentContextCapTokens: 60_000,
    maxAgents: 1_000,
    storeLearnings: false,
  }
}

// ---------------------------------------------------------------------------
// 1. REAL parallel fan-out
// ---------------------------------------------------------------------------

test("parallel() runs agent turns concurrently (overlapping intervals), all under the parent", async () => {
  const DELAY = 80
  const { client, prompts, creates } = makeFakeClient(DELAY)
  const registry = new WorkflowRegistry()

  const { parallel, agent } = createEngine(
    { client: client as never, brief: makeBrief(), config: makeConfig(8), registry },
    // Use the real resolver against the fake app.agents().
    new ModelResolver(client as never, { directory: "/repo/test" }),
  )

  const results = await parallel([
    () => agent("do A", { label: "A", agentType: "implementer", model: "opus", phase: 0 }),
    () => agent("do B", { label: "B", agentType: "general", model: "sonnet", phase: 0 }),
    () => agent("do C", { label: "C", agentType: "general", model: "sonnet", phase: 0 }),
  ])

  // All three resolved (none null) and produced text.
  expect(results.length).toBe(3)
  for (const r of results) {
    expect(r).not.toBeNull()
    expect(r!.ok).toBe(true)
    expect(r!.text.length).toBeGreaterThan(0)
  }

  // Exactly three prompt turns recorded.
  expect(prompts.length).toBe(3)

  // CONCURRENCY PROOF: the wall-clock span of all turns is far less than the
  // serial sum. With 3 turns of ~DELAY each, serial would be ~3*DELAY; concurrent
  // is ~DELAY. Assert span < sum-of-durations (genuine overlap).
  const minStart = Math.min(...prompts.map((p) => p.start))
  const maxEnd = Math.max(...prompts.map((p) => p.end))
  const span = maxEnd - minStart
  const sumDurations = prompts.reduce((s, p) => s + (p.end - p.start), 0)
  expect(span).toBeLessThan(sumDurations)
  // And tighter: the span should be near a single delay, not three.
  expect(span).toBeLessThan(DELAY * 2)

  // PAIRWISE OVERLAP: at least one pair of turns has overlapping [start,end].
  let anyOverlap = false
  for (let i = 0; i < prompts.length; i++) {
    for (let j = i + 1; j < prompts.length; j++) {
      if (prompts[i].start < prompts[j].end && prompts[j].start < prompts[i].end) {
        anyOverlap = true
      }
    }
  }
  expect(anyOverlap).toBe(true)

  // PARENT LINKAGE: all three children were created under the run's parent id.
  expect(creates.length).toBe(3)
  for (const c of creates) {
    expect(c.parentID).toBe(PARENT_ID)
  }
  // The prompt turns ran on the freshly-created child sessions.
  const createdIds = new Set(creates.map((c) => c.returnedId))
  for (const p of prompts) {
    expect(createdIds.has(p.sessionId)).toBe(true)
  }
})

// ---------------------------------------------------------------------------
// 1b. Semaphore actually SERIALIZES when concurrency = 1 (control)
// ---------------------------------------------------------------------------

test("parallel() respects concurrency=1 (turns do NOT overlap)", async () => {
  const DELAY = 60
  const { client, prompts } = makeFakeClient(DELAY)
  const registry = new WorkflowRegistry()

  const { parallel, agent } = createEngine(
    { client: client as never, brief: makeBrief(), config: makeConfig(1), registry },
    new ModelResolver(client as never, { directory: "/repo/test" }),
  )

  await parallel([
    () => agent("do A", { label: "A", phase: 0 }),
    () => agent("do B", { label: "B", phase: 0 }),
  ])

  expect(prompts.length).toBe(2)
  // With a single slot the two turns must NOT overlap: the second starts at or
  // after the first ends.
  const sorted = [...prompts].sort((a, b) => a.start - b.start)
  expect(sorted[1].start).toBeGreaterThanOrEqual(sorted[0].end - 5 /* timer slack */)
})

// ---------------------------------------------------------------------------
// 2. pipeline() has NO barrier (streaming)
// ---------------------------------------------------------------------------

test("pipeline() streams without a barrier: item[1] enters stage1 before item[0] clears stage2", async () => {
  const { client } = makeFakeClient(0)
  const registry = new WorkflowRegistry()

  const { pipeline } = createEngine(
    { client: client as never, brief: makeBrief(), config: makeConfig(8), registry },
    new ModelResolver(client as never, { directory: "/repo/test" }),
  )

  // Instrument the stages directly (we are proving the SCHEDULER, not the SDK):
  // record when each (item,stage) fires.
  const events: Array<{ item: number; stage: number; phase: "in" | "out"; t: number }> = []
  const mark = (item: number, stage: number, phase: "in" | "out") =>
    events.push({ item, stage, phase, t: Date.now() })

  const stage1 = async (_prev: unknown, _orig: string, index: number) => {
    mark(index, 1, "in")
    await sleep(40)
    mark(index, 1, "out")
    return `s1:${index}`
  }
  const stage2 = async (prev: unknown, _orig: string, index: number) => {
    mark(index, 2, "in")
    await sleep(40)
    mark(index, 2, "out")
    return `s2:${index}:${prev}`
  }

  const out = await pipeline<string>(["x", "y"], stage1, stage2)

  // Both items produced a final result, in input order.
  expect(out.length).toBe(2)
  expect(out[0]).toBe("s2:0:s1:0")
  expect(out[1]).toBe("s2:1:s1:1")

  // NO-BARRIER PROOF: item[1] entered stage 1 BEFORE item[0] left stage 2.
  const item1Stage1In = events.find((e) => e.item === 1 && e.stage === 1 && e.phase === "in")!
  const item0Stage2Out = events.find((e) => e.item === 0 && e.stage === 2 && e.phase === "out")!
  expect(item1Stage1In).toBeDefined()
  expect(item0Stage2Out).toBeDefined()
  expect(item1Stage1In.t).toBeLessThan(item0Stage2Out.t)
})

// ---------------------------------------------------------------------------
// 2b. pipeline() per-item failure isolation (one item drops to null)
// ---------------------------------------------------------------------------

test("pipeline() drops a failing item to null without affecting others", async () => {
  const { client } = makeFakeClient(0)
  const registry = new WorkflowRegistry()

  const { pipeline } = createEngine(
    { client: client as never, brief: makeBrief(), config: makeConfig(8), registry },
    new ModelResolver(client as never, { directory: "/repo/test" }),
  )

  const stage1 = async (_prev: unknown, orig: string, index: number) => {
    if (index === 1) throw new Error("boom on item 1")
    return `ok:${orig}`
  }
  const stage2 = async (prev: unknown) => `done:${prev}`

  const out = await pipeline<string>(["a", "b", "c"], stage1, stage2)
  expect(out.length).toBe(3)
  expect(out[0]).toBe("done:ok:a")
  expect(out[1]).toBeNull() // dropped
  expect(out[2]).toBe("done:ok:c")
})

// ---------------------------------------------------------------------------
// 3. parallel() maps a rejecting thunk to null (hard barrier, allSettled)
// ---------------------------------------------------------------------------

test("parallel() maps a rejected thunk to null and still resolves the rest", async () => {
  const { client } = makeFakeClient(0)
  const registry = new WorkflowRegistry()

  const { parallel, agent } = createEngine(
    { client: client as never, brief: makeBrief(), config: makeConfig(8), registry },
    new ModelResolver(client as never, { directory: "/repo/test" }),
  )

  const results = await parallel<unknown>([
    () => agent("ok", { label: "ok", phase: 0 }),
    () => Promise.reject(new Error("thunk blew up")),
    () => agent("ok2", { label: "ok2", phase: 0 }),
  ])

  expect(results.length).toBe(3)
  expect(results[0]).not.toBeNull()
  expect(results[1]).toBeNull()
  expect(results[2]).not.toBeNull()
})
