/**
 * SSE client for the workflow TUI.
 *
 * Connects to a given dashboard base URL:
 *   1. GET /state    -> seed snapshot ({ events: WorkflowEvent[] })
 *   2. GET /events   -> SSE stream, frames are `data: <json>\n\n`
 *      (the server also sends a `state.seed` framed event on connect,
 *      i.e. { type: "state.seed", events: [...] } — handled here too so
 *      callers only ever see real WorkflowEvent objects).
 *
 * Uses only global `fetch` + `response.body.getReader()` + TextDecoder —
 * no dependencies. Connection-refused / network errors are surfaced via the
 * `onError` callback (or thrown by `fetchSeed`) rather than crashing with a
 * raw stack trace; `cli.ts` is responsible for printing the friendly message
 * and exiting.
 */

import type { WorkflowEvent } from "../types.js"

type SeedFrame = { type: "state.seed"; events: WorkflowEvent[] }

function isSeedFrame(value: unknown): value is SeedFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "state.seed" &&
    Array.isArray((value as { events?: unknown }).events)
  )
}

/** Raised when the initial connection to the dashboard fails. */
export class DashboardConnectionError extends Error {
  constructor(public readonly url: string, cause?: unknown) {
    super(`could not connect to dashboard at ${url} — is a workflow running?`)
    this.name = "DashboardConnectionError"
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

/**
 * Fetch the ring-buffer snapshot from GET /state. Throws
 * DashboardConnectionError on any network failure or non-2xx response.
 */
export async function fetchSeed(baseUrl: string): Promise<WorkflowEvent[]> {
  let resp: Response
  try {
    resp = await fetch(`${baseUrl}/state`)
  } catch (err) {
    throw new DashboardConnectionError(baseUrl, err)
  }
  if (!resp.ok) {
    throw new DashboardConnectionError(baseUrl)
  }
  try {
    const json = (await resp.json()) as { events?: unknown }
    if (!Array.isArray(json.events)) return []
    return json.events as WorkflowEvent[]
  } catch (err) {
    throw new DashboardConnectionError(baseUrl, err)
  }
}

export interface SseClientCallbacks {
  /** Called once with the seed snapshot (from GET /state). */
  onSeed?: (events: WorkflowEvent[]) => void
  /** Called for every WorkflowEvent received over the SSE stream
   * (state.seed frames are unwrapped and each contained event delivered
   * individually through this same callback, so consumers only need one
   * handler). */
  onEvent: (event: WorkflowEvent) => void
  /** Called if the initial connection fails (GET /state or GET /events). */
  onError?: (err: DashboardConnectionError) => void
  /** Called when the SSE stream ends (server closed the connection). */
  onClose?: () => void
}

/**
 * Connect to the dashboard at `baseUrl`: fetch the seed snapshot, then open
 * the SSE stream and deliver every event via callbacks. Resolves once the
 * stream closes (or rejects only if the *initial* connection — GET /state —
 * fails and no onError handler was provided).
 */
export async function connect(
  baseUrl: string,
  callbacks: SseClientCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  let seed: WorkflowEvent[]
  try {
    seed = await fetchSeed(baseUrl)
  } catch (err) {
    if (callbacks.onError && err instanceof DashboardConnectionError) {
      callbacks.onError(err)
      return
    }
    throw err
  }
  callbacks.onSeed?.(seed)

  let resp: Response
  try {
    resp = await fetch(`${baseUrl}/events`, { signal })
  } catch (err) {
    const connErr = new DashboardConnectionError(baseUrl, err)
    if (callbacks.onError) {
      callbacks.onError(connErr)
      return
    }
    throw connErr
  }

  if (!resp.body) {
    const connErr = new DashboardConnectionError(baseUrl)
    if (callbacks.onError) {
      callbacks.onError(connErr)
      return
    }
    throw connErr
  }

  await consumeSseStream(resp.body, callbacks)
  callbacks.onClose?.()
}

/**
 * Read an SSE ReadableStream, splitting on double-newline frame boundaries
 * and dispatching parsed `data:` payloads to `callbacks.onEvent` (unwrapping
 * state.seed frames transparently).
 *
 * Exported separately so it can be unit-tested with a synthetic stream
 * without going through `fetch`.
 */
export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  callbacks: Pick<SseClientCallbacks, "onEvent" | "onSeed">,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Frames are separated by a blank line ("\n\n"). Process every
      // complete frame in the buffer, keep any trailing partial frame.
      let sepIdx: number
      while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sepIdx)
        buffer = buffer.slice(sepIdx + 2)
        dispatchFrame(frame, callbacks)
      }
    }
    // Flush any trailing partial frame on stream end.
    if (buffer.trim().length > 0) {
      dispatchFrame(buffer, callbacks)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

function dispatchFrame(
  frame: string,
  callbacks: Pick<SseClientCallbacks, "onEvent" | "onSeed">,
): void {
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.trim()
    if (!line.startsWith("data:")) continue
    const jsonText = line.slice(5).trim()
    if (jsonText.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      continue // malformed frame; skip
    }
    if (isSeedFrame(parsed)) {
      callbacks.onSeed?.(parsed.events)
      for (const ev of parsed.events) callbacks.onEvent(ev)
      continue
    }
    callbacks.onEvent(parsed as WorkflowEvent)
  }
}
