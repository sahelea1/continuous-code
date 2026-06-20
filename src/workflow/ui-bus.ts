/**
 * Typed singleton event bus for WorkflowEvents.
 *
 * The engine emits WorkflowEvents onto this bus; the dashboard subscribes
 * and relays them as SSE to connected browsers. The bus also keeps a
 * ring-buffer of the last ~500 events so late joiners (a browser that opens
 * the dashboard after a workflow is already mid-run) can seed from GET /state
 * without missing history.
 *
 * Design rules (matching watchdog discipline):
 *  - Never throws — all listener calls are guarded in try/catch.
 *  - No external deps — pure Node EventEmitter under the hood.
 *  - Singleton pattern: import the exported `uiBus` instance everywhere.
 */
import { EventEmitter } from "events"
import type { WorkflowEvent } from "./types.js"

// ---------------------------------------------------------------------------
// Internal EventEmitter with a typed wrapper
// ---------------------------------------------------------------------------

const RING_SIZE = 500
const EVENT_CHANNEL = "workflow"

class WorkflowEventBus {
  private readonly emitter: EventEmitter
  /** Ring-buffer of recent events for late joiners. */
  private readonly ring: WorkflowEvent[] = []
  private ringHead = 0

  constructor() {
    this.emitter = new EventEmitter()
    // Allow many concurrent SSE connections (each adds one listener) without
    // Node's default 10-listener warning firing prematurely.
    this.emitter.setMaxListeners(256)
  }

  /**
   * Emit a WorkflowEvent. The event is appended to the ring-buffer and then
   * delivered synchronously to all registered listeners. Any listener that
   * throws is caught and ignored — the bus must never propagate errors to
   * the engine that emitted the event.
   */
  emit(event: WorkflowEvent): void {
    // Store in ring-buffer (overwrite oldest when full).
    if (this.ring.length < RING_SIZE) {
      this.ring.push(event)
    } else {
      this.ring[this.ringHead] = event
      this.ringHead = (this.ringHead + 1) % RING_SIZE
    }

    try {
      this.emitter.emit(EVENT_CHANNEL, event)
    } catch {
      // Swallow — listener errors must never surface to the engine.
    }
  }

  /**
   * Subscribe to all future WorkflowEvents. Returns an `off` function for
   * easy cleanup (pass to `off()` or call the returned function directly).
   */
  on(fn: (event: WorkflowEvent) => void): void {
    const wrapped = (ev: WorkflowEvent): void => {
      try {
        fn(ev)
      } catch {
        // Listener errors are silently dropped.
      }
    }
    // Attach the wrapped version so we can remove it via off().
    // We store the mapping on the function object itself for identity tracking.
    ;(fn as WrappedListener).__wrapped = wrapped
    this.emitter.on(EVENT_CHANNEL, wrapped)
  }

  /**
   * Unsubscribe a listener previously registered with `on()`. Safe to call
   * with a listener that was never registered (no-op).
   */
  off(fn: (event: WorkflowEvent) => void): void {
    try {
      const wrapped = (fn as WrappedListener).__wrapped
      if (wrapped) {
        this.emitter.off(EVENT_CHANNEL, wrapped)
      } else {
        // Fallback: try removing fn directly (handles cases where the
        // wrapped reference was lost).
        this.emitter.off(EVENT_CHANNEL, fn as never)
      }
    } catch {
      // Never throw.
    }
  }

  /**
   * Return a snapshot of recent events in chronological order (oldest first),
   * capped at RING_SIZE entries. Used by GET /state to seed late joiners.
   *
   * The returned array is a copy — mutations do not affect the internal ring.
   */
  snapshot(): WorkflowEvent[] {
    if (this.ring.length < RING_SIZE) {
      // Ring hasn't filled yet — straightforward copy, already ordered.
      return [...this.ring]
    }
    // Ring is full and has wrapped. Reconstruct chronological order:
    // ringHead points to the OLDEST slot.
    const ordered: WorkflowEvent[] = []
    for (let i = 0; i < RING_SIZE; i++) {
      ordered.push(this.ring[(this.ringHead + i) % RING_SIZE])
    }
    return ordered
  }

  /** Number of events currently held in the ring-buffer. */
  get size(): number {
    return this.ring.length
  }
}

// Type-helper: attach the wrapped listener reference to the original function
// so off() can reverse-map to it.
interface WrappedListener {
  __wrapped?: (ev: WorkflowEvent) => void
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/**
 * The singleton WorkflowEventBus. Import this everywhere:
 *
 *   import { uiBus } from "./ui-bus.js"
 *
 * Engine side:   uiBus.emit({ type: "phase.start", ... })
 * Dashboard side: uiBus.on(fn) / uiBus.off(fn) / uiBus.snapshot()
 */
export const uiBus = new WorkflowEventBus()
