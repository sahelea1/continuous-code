/**
 * Smoke test for the workflow dashboard server (plan §D.4).
 *
 * Verifies:
 *  1. startDashboard(0) binds to an ephemeral OS port and returns its URL.
 *  2. GET / serves HTML content.
 *  3. A synthetic phase.start emitted on ui-bus arrives over /events (SSE).
 *  4. A synthetic agent.done emitted on ui-bus arrives over /events (SSE).
 *  5. GET /state returns a JSON snapshot that reflects the emitted events.
 *  6. startDashboard is idempotent.
 *
 * SSE is read via `Bun.spawn(['curl', ...])` rather than a same-process
 * `fetch` body reader. Same-process streaming fetch in Bun blocks the event
 * loop (the reader.read() microtask starves the HTTP handler), so an external
 * reader subprocess is the correct pattern for in-process-server smoke tests.
 *
 * Skips cleanly if Bun.serve or Bun.spawn is unavailable.
 * Run:  bun test tests/workflow/dashboard.smoke.test.ts
 */
import { test, expect, beforeAll, afterAll } from "bun:test"
import { uiBus } from "../../src/workflow/ui-bus.ts"
import {
  startDashboard,
  getDashboardUrl,
  _resetDashboardState,
} from "../../src/workflow/dashboard.ts"
import type { WorkflowEvent } from "../../src/workflow/types.ts"

// ---------------------------------------------------------------------------
// Skip guard — detect Bun.serve + Bun.spawn at import-time.
// ---------------------------------------------------------------------------

const BUN_AVAILABLE =
  typeof globalThis !== "undefined" &&
  "Bun" in globalThis &&
  typeof (globalThis as Record<string, unknown>).Bun === "object" &&
  typeof ((globalThis as Record<string, unknown>).Bun as Record<string, unknown>)
    .serve === "function" &&
  typeof ((globalThis as Record<string, unknown>).Bun as Record<string, unknown>)
    .spawn === "function"

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let baseUrl = ""

beforeAll(async () => {
  if (!BUN_AVAILABLE) return

  // Ensure a clean singleton state (in case another test file ran first).
  _resetDashboardState()

  // Start on ephemeral port 0 → OS assigns a free port.
  baseUrl = await startDashboard(0)
  // Give the server a moment to be ready for connections.
  await new Promise<void>((r) => setTimeout(r, 80))
})

afterAll(() => {
  // Reset so the module can be re-used in other test suites.
  _resetDashboardState()
})

// ---------------------------------------------------------------------------
// Helper: poll curl's stderr (from -v) until the response status line
// ("< HTTP/1.x 200") appears, signalling curl has actually received headers
// for the SSE response and is subscribed — i.e. the server has registered
// the SSE writer and any subsequent broadcast() will reach this client.
//
// This replaces a fixed-duration sleep, which is flaky under load: a fixed
// 200ms guess can be exceeded by curl's TCP connect + the server's SSE
// handshake under contention, causing events to be emitted before curl is
// actually subscribed (and silently missed).
//
// Bounded by a short timeout so a genuinely broken connection still fails
// fast rather than hanging the test.
// ---------------------------------------------------------------------------

async function waitForSseReady(
  stderrStream: ReadableStream<Uint8Array>,
  timeoutMs = 2000,
  pollIntervalMs = 20,
): Promise<void> {
  const reader = stderrStream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const deadline = Date.now() + timeoutMs

  try {
    while (Date.now() < deadline) {
      // Race the next stderr chunk against a short poll interval so we
      // don't block forever if curl produces no more output before
      // connecting (read() resolves as soon as ANY chunk arrives, so this
      // is not a fixed-duration sleep — it's a bounded-wait readiness poll).
      const readPromise = reader.read()
      const timeoutPromise = new Promise<{ timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), pollIntervalMs),
      )
      const result = await Promise.race([readPromise, timeoutPromise])

      if ("timedOut" in result) {
        // No new data yet within this poll tick; check buffer again on the
        // next loop iteration (covers the case where the chunk arrives
        // between our check and the next read() call).
        if (/<\s*HTTP\/1\.\d\s+200/.test(buffer)) return
        continue
      }

      const { value, done } = result
      if (done) break
      buffer += decoder.decode(value)
      if (/<\s*HTTP\/1\.\d\s+200/.test(buffer)) return
    }
  } finally {
    // Release the lock so the rest of the stream (if any) can still be
    // consumed/drained by whatever reads stderr next (we don't read it
    // again here, but releasing avoids leaving the stream locked).
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
  // Timed out without seeing the status line — fall through. The caller's
  // own test timeout will catch a genuinely hung connection; we don't throw
  // here so a slow-but-eventually-successful connection still gets a chance.
}

// ---------------------------------------------------------------------------
// Helper: use curl (subprocess) to read N ms of SSE from the server, then
// parse all "data: ..." lines and return the decoded events.
//
// Why a subprocess? Same-process streaming fetch in Bun blocks the event loop
// when awaiting reader.read() — the HTTP response handler never gets to flush
// its response while the test loop is suspended in that microtask. curl runs
// in its own process and reads non-blocking from the server's perspective.
// ---------------------------------------------------------------------------

async function collectSseViaCurl(
  url: string,
  emitFn: () => void,
  maxTimeSecs = 3,
): Promise<WorkflowEvent[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const BunGlobal = (globalThis as Record<string, unknown>).Bun as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawn: (cmd: string[], opts: Record<string, unknown>) => any
  }

  // Start curl reading the SSE stream. --max-time N will kill curl after N s.
  // -v (verbose) writes the request/response trace — including the response
  // status line, e.g. "< HTTP/1.1 200 OK" — to stderr as soon as Bun's fetch
  // handler has run and flushed headers. That status line only appears once
  // the server has entered the /events ReadableStream's start(controller)
  // and registered the SSE writer, which is the exact readiness point we
  // need: curl is now actually subscribed and will see everything broadcast
  // from this point on. We poll stderr for that line instead of guessing a
  // fixed sleep duration, which is unreliable under load (slow TCP connect +
  // slow SSE handshake can both exceed a fixed timeout under contention).
  const proc = BunGlobal.spawn(
    ["curl", "-sN", "-v", "--max-time", String(maxTimeSecs), url + "/events"],
    { stdout: "pipe", stderr: "pipe" },
  )

  await waitForSseReady(proc.stderr as ReadableStream<Uint8Array>)

  // Now emit the events; curl is confirmed subscribed and reading the stream.
  emitFn()

  // Wait for curl to finish (max-time expires or stream closes).
  await proc.exited

  const raw = await new Response(proc.stdout).text()

  // Parse SSE "data: <json>" lines.
  const events: WorkflowEvent[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data: ")) continue
    try {
      const ev = JSON.parse(trimmed.slice(6)) as
        | WorkflowEvent
        | { type: "state.seed" }
      if (ev.type !== "state.seed") {
        events.push(ev as WorkflowEvent)
      }
    } catch {
      // malformed; skip
    }
  }
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("startDashboard returns a URL when Bun is available", () => {
  if (!BUN_AVAILABLE) {
    console.log("SKIP: Bun.serve/Bun.spawn not available")
    return
  }
  expect(baseUrl).toMatch(/^http:\/\/localhost:\d+$/)
  expect(getDashboardUrl()).toBe(baseUrl)
})

test("GET / serves the dashboard HTML", async () => {
  if (!BUN_AVAILABLE) {
    console.log("SKIP: Bun not available")
    return
  }

  const resp = await fetch(`${baseUrl}/`)
  expect(resp.status).toBe(200)
  expect(resp.headers.get("content-type")).toContain("text/html")
  const body = await resp.text()
  // The real asset contains "Ultracode Workflow Dashboard"; fallback still has "workflow".
  expect(body.toLowerCase()).toContain("workflow")
})

test("GET /state returns JSON with events array", async () => {
  if (!BUN_AVAILABLE) {
    console.log("SKIP: Bun not available")
    return
  }

  const resp = await fetch(`${baseUrl}/state`)
  expect(resp.status).toBe(200)
  expect(resp.headers.get("content-type")).toContain("application/json")
  const json = (await resp.json()) as { events: unknown }
  expect(Array.isArray(json.events)).toBe(true)
})

test(
  "SSE /events delivers phase.start and agent.done emitted on ui-bus",
  async () => {
    if (!BUN_AVAILABLE) {
      console.log("SKIP: Bun not available")
      return
    }

    const phaseStart: WorkflowEvent = {
      type: "phase.start",
      phaseIdx: 0,
      title: "Smoke Phase",
      mode: "parallel",
      agentCount: 1,
      timestamp: new Date().toISOString(),
    }
    const agentDone: WorkflowEvent = {
      type: "agent.done",
      phaseIdx: 0,
      agentLabel: "smoke-agent",
      sessionId: "sess-smoke-001",
      artifactId: "phase0:smoke-agent",
      tokensEst: 42,
      durationMs: 100,
      ok: true,
      timestamp: new Date().toISOString(),
    }

    // Collect SSE events via curl subprocess; emit both events inside the
    // emitFn callback (called after curl has connected).
    const events = await collectSseViaCurl(
      baseUrl,
      () => {
        uiBus.emit(phaseStart)
        uiBus.emit(agentDone)
      },
      // curl will exit after 3 s; both events arrive in the first ~100 ms.
      3,
    )

    // Validate we received both events.
    const types = events.map((e) => e.type)
    expect(types).toContain("phase.start")
    expect(types).toContain("agent.done")

    const ps = events.find((e) => e.type === "phase.start") as Extract<
      WorkflowEvent,
      { type: "phase.start" }
    >
    expect(ps.title).toBe("Smoke Phase")
    expect(ps.phaseIdx).toBe(0)
    expect(ps.agentCount).toBe(1)

    const ad = events.find((e) => e.type === "agent.done") as Extract<
      WorkflowEvent,
      { type: "agent.done" }
    >
    expect(ad.agentLabel).toBe("smoke-agent")
    expect(ad.ok).toBe(true)
    expect(ad.tokensEst).toBe(42)
  },
  // Give the test up to 8 s (curl runs for 3 s).
  8000,
)

test("GET /state reflects emitted events in ring-buffer", async () => {
  if (!BUN_AVAILABLE) {
    console.log("SKIP: Bun not available")
    return
  }

  // At this point the bus ring-buffer should contain the events from the
  // previous test (phase.start + agent.done).
  const resp = await fetch(`${baseUrl}/state`)
  const json = (await resp.json()) as { events: WorkflowEvent[] }

  const types = json.events.map((e) => e.type)
  expect(types).toContain("phase.start")
  expect(types).toContain("agent.done")

  const ps = json.events.find((e) => e.type === "phase.start") as Extract<
    WorkflowEvent,
    { type: "phase.start" }
  >
  expect(ps?.title).toBe("Smoke Phase")
})

test("startDashboard is idempotent — second call returns the same URL", async () => {
  if (!BUN_AVAILABLE) {
    console.log("SKIP: Bun not available")
    return
  }

  // Call again with a different port; should return the already-started URL.
  const second = await startDashboard(12345)
  expect(second).toBe(baseUrl)
})
