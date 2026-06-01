/**
 * Process-wide async mutex for consensus deliberations.
 *
 * Pure logic only — no `@opencode-ai/plugin` import.
 *
 * There is exactly ONE consensus instance running (the primary/orchestrator).
 * This promise-chain mutex additionally guarantees that only ONE deliberation
 * (or fusion) runs at a time within the process, so overlapping calls are
 * serialized rather than racing. The underlying fetch calls already have
 * timeouts, so the lock can never hang indefinitely.
 */
let _lock: Promise<unknown> = Promise.resolve()

export async function withConsensusLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _lock
  let release!: () => void
  _lock = new Promise<void>((r) => (release = r))
  try {
    await prev
  } catch {
    // Ignore the previous holder's outcome; we only wait for it to settle.
  }
  try {
    return await fn()
  } finally {
    release()
  }
}
