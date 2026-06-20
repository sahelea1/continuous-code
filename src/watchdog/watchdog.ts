/**
 * Automatic subagent-watchdog.
 *
 * When the orchestrator spawns background subagent(s), ARM a recurring timer
 * (fixed interval, default 20m). If the timer fires while subagents are still
 * running, WAKE the (idle) orchestrator session with a NUDGE prompt asking it
 * to inspect its children and decide (abort/respawn/continue). When all
 * subagents finish, DISARM so the orchestrator processes results unhindered.
 *
 * v1 is NUDGE-ONLY: the watchdog never autonomously aborts or respawns a
 * subagent. It only re-prompts the idle orchestrator.
 *
 * ORCHESTRATOR identity = a session with NO parentID (a child/subagent HAS
 * parentID) — the same heuristic enforce-agent-only.ts / consensus-mode.ts use.
 *
 * Every client call + handler body is wrapped in try/catch so the watchdog can
 * NEVER throw into OpenCode's event loop or tool pipeline. Log-and-continue.
 */
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { loadWatchdogConfig, type WatchdogConfig } from "./config.js"

type WatchdogClient = PluginInput["client"]

interface ArmState {
  timer: ReturnType<typeof setInterval>
  childIDs: Set<string>
  idleChildIDs: Set<string>
  pendingTaskCallIDs: Set<string>
  wakeCount: number
  armedAt: number
  /** Debounce timer for an all-idle reconcile before we actually disarm. */
  lastReconcileTimer?: ReturnType<typeof setTimeout>
  /** Timestamp (ms) of the last reconcile/poll, for the poll-fallback cadence. */
  lastReconcileAt: number
}

export interface Watchdog {
  onEvent: NonNullable<Hooks["event"]>
  onToolBefore: NonNullable<Hooks["tool.execute.before"]>
  onToolAfter: NonNullable<Hooks["tool.execute.after"]>
  dispose: () => void
}

function buildWatchdogPrompt(intervalMs: number, wakeCount: number): string {
  const approxMs = intervalMs * Math.max(1, wakeCount)
  const minutes = Math.max(1, Math.round(approxMs / 60_000))
  return (
    `[watchdog] Your background subagents have been running for ~${minutes} ` +
    `minute${minutes === 1 ? "" : "s"}. Check each child session's progress ` +
    `(use session children/status). If any subagent is stuck, hung, or ` +
    `awaiting input, decide whether to abort and respawn it; otherwise let ` +
    `healthy ones continue. This is an automated progress check — if ` +
    `everything already finished, just proceed with the results.`
  )
}

export function createWatchdog(
  directory: string,
  client: WatchdogClient,
): Watchdog {
  const config: WatchdogConfig = loadWatchdogConfig(directory)

  // Per-orchestrator arm state. Keyed by orchestrator sessionID so concurrent
  // orchestrators are independent.
  const arms = new Map<string, ArmState>()
  // Reverse index: childID -> orchestratorID (for fast idle/error routing).
  const childToOrchestrator = new Map<string, string>()

  const noop = async (): Promise<void> => {}

  function log(level: "info" | "warn" | "error", message: string): void {
    try {
      void client.app.log({
        body: { service: "watchdog", level, message },
      })
    } catch {
      // Logging must never throw.
    }
  }

  /** Is this session an orchestrator (no parentID)? */
  async function isOrchestrator(sessionID: string): Promise<boolean> {
    try {
      const result = await client.session.get({ path: { id: sessionID } })
      const data = result.data as { parentID?: string } | undefined
      if (!data) return false
      return !data.parentID
    } catch {
      return false
    }
  }

  function disarm(orchestratorID: string): void {
    const state = arms.get(orchestratorID)
    if (!state) return
    try {
      clearInterval(state.timer)
    } catch {
      /* ignore */
    }
    if (state.lastReconcileTimer) {
      try {
        clearTimeout(state.lastReconcileTimer)
      } catch {
        /* ignore */
      }
    }
    for (const childID of state.childIDs) {
      childToOrchestrator.delete(childID)
    }
    arms.delete(orchestratorID)
    log("info", `disarmed watchdog for orchestrator ${orchestratorID}`)
  }

  function arm(orchestratorID: string): ArmState {
    let state = arms.get(orchestratorID)
    if (state) return state
    const timer = setInterval(() => {
      void onTimer(orchestratorID)
    }, config.intervalMs)
    // Don't keep the event loop alive solely for the watchdog timer.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      ;(timer as { unref?: () => void }).unref!()
    }
    state = {
      timer,
      childIDs: new Set<string>(),
      idleChildIDs: new Set<string>(),
      pendingTaskCallIDs: new Set<string>(),
      wakeCount: 0,
      armedAt: Date.now(),
      lastReconcileAt: Date.now(),
    }
    arms.set(orchestratorID, state)
    log("info", `armed watchdog for orchestrator ${orchestratorID}`)
    return state
  }

  function registerChild(orchestratorID: string, childID: string): void {
    const state = arm(orchestratorID)
    state.childIDs.add(childID)
    state.idleChildIDs.delete(childID)
    childToOrchestrator.set(childID, orchestratorID)
  }

  /**
   * Fetch children + status for an orchestrator. Returns the set of currently
   * busy tracked-child IDs and whether all tracked children are non-busy.
   * Treats unknown/missing status as NOT busy.
   */
  async function inspect(orchestratorID: string): Promise<{
    busyChildIDs: Set<string>
    knownChildIDs: Set<string>
  } | null> {
    try {
      const [childrenRes, statusRes] = await Promise.all([
        client.session.children({ path: { id: orchestratorID } }),
        client.session.status(),
      ])
      const children = (childrenRes.data ?? []) as Array<{ id: string }>
      const statusMap = (statusRes.data ?? {}) as {
        [id: string]: { type?: string }
      }

      const state = arms.get(orchestratorID)
      const knownChildIDs = new Set<string>()
      for (const c of children) {
        if (c && typeof c.id === "string") knownChildIDs.add(c.id)
      }
      // Fold in any children we learned about via events/tool calls that the
      // children endpoint hasn't surfaced yet.
      if (state) {
        for (const id of state.childIDs) knownChildIDs.add(id)
      }

      const busyChildIDs = new Set<string>()
      for (const id of knownChildIDs) {
        const st = statusMap[id]
        if (st && st.type === "busy") busyChildIDs.add(id)
      }
      return { busyChildIDs, knownChildIDs }
    } catch {
      return null
    }
  }

  /** Orchestrator's own status type, or undefined on failure. */
  async function orchestratorStatusType(
    orchestratorID: string,
  ): Promise<string | undefined> {
    try {
      const statusRes = await client.session.status()
      const statusMap = (statusRes.data ?? {}) as {
        [id: string]: { type?: string }
      }
      return statusMap[orchestratorID]?.type
    } catch {
      return undefined
    }
  }

  /**
   * Reconcile: if EVERY known child is non-busy, start/refresh an idleGrace
   * debounce; when the debounce fires AND children are still all non-busy,
   * DISARM. This avoids disarming during a brief inter-tool idle.
   */
  async function reconcile(orchestratorID: string): Promise<void> {
    try {
      const state = arms.get(orchestratorID)
      if (!state) return
      state.lastReconcileAt = Date.now()

      const info = await inspect(orchestratorID)
      if (!info) return

      // A concurrent disarm() (session.deleted/error) may have torn down and
      // deleted this arm during the await. Bail if it's gone or replaced so we
      // don't resurrect a zombie arm via registerChild()->arm().
      const live = arms.get(orchestratorID)
      if (!live || live !== state) return

      // Keep our notion of children in sync with the server's view.
      for (const id of info.knownChildIDs) {
        if (!state.childIDs.has(id)) registerChild(orchestratorID, id)
      }

      const allIdle =
        info.busyChildIDs.size === 0 && state.pendingTaskCallIDs.size === 0

      if (!allIdle) {
        // Still work in flight — cancel any pending disarm debounce.
        if (state.lastReconcileTimer) {
          clearTimeout(state.lastReconcileTimer)
          state.lastReconcileTimer = undefined
        }
        return
      }

      // All idle → schedule a debounced disarm (refresh if already pending).
      if (state.lastReconcileTimer) {
        clearTimeout(state.lastReconcileTimer)
      }
      const debounce = setTimeout(() => {
        void confirmDisarm(orchestratorID)
      }, config.idleGraceMs)
      if (typeof (debounce as { unref?: () => void }).unref === "function") {
        ;(debounce as { unref?: () => void }).unref!()
      }
      state.lastReconcileTimer = debounce
    } catch {
      // Never throw out of reconcile.
      log("error", `watchdog reconcile failed for orchestrator ${orchestratorID}`)
    }
  }

  /** Debounce fired — disarm only if children are STILL all non-busy. */
  async function confirmDisarm(orchestratorID: string): Promise<void> {
    try {
      const state = arms.get(orchestratorID)
      if (!state) return
      state.lastReconcileTimer = undefined
      const info = await inspect(orchestratorID)
      if (!info) {
        // Couldn't confirm; leave armed, the next timer tick will retry.
        return
      }
      // A concurrent disarm() (session.deleted/error) may have torn down and
      // deleted this arm during the await. Bail if it's gone or replaced so we
      // don't resurrect a zombie arm via registerChild()->arm().
      const live = arms.get(orchestratorID)
      if (!live || live !== state) return
      // tool.execute.* is only a corroborating signal; a dropped after-event
      // would leave pendingTaskCallIDs non-empty forever and block disarm,
      // causing a permanent arm. The debounced confirmation relies on LIVE
      // status only: if every child is non-busy, disarm even if
      // pendingTaskCallIDs is non-empty. The first reconcile() gate still
      // requires pendingTaskCallIDs to be empty, so the corroborating signal
      // continues to delay the first attempt.
      const allIdle = info.busyChildIDs.size === 0
      if (allIdle) {
        disarm(orchestratorID)
      }
    } catch {
      // Never throw out of confirmDisarm.
      log(
        "error",
        `watchdog confirmDisarm failed for orchestrator ${orchestratorID}`,
      )
    }
  }

  /** Recurring per-orchestrator timer callback (every intervalMs). */
  async function onTimer(orchestratorID: string): Promise<void> {
    try {
      const state = arms.get(orchestratorID)
      if (!state) return

      const info = await inspect(orchestratorID)
      if (!info) return

      // A concurrent disarm() (session.deleted/error) may have torn down and
      // deleted this arm during the await. Bail if it's gone or replaced so we
      // don't resurrect a zombie arm via registerChild()->arm().
      const live = arms.get(orchestratorID)
      if (!live || live !== state) return

      // Sync children.
      for (const id of info.knownChildIDs) {
        if (!state.childIDs.has(id)) registerChild(orchestratorID, id)
      }

      const anyBusy = info.busyChildIDs.size > 0

      if (!anyBusy && state.pendingTaskCallIDs.size === 0) {
        // Nothing running — reconcile (will debounce-disarm).
        await reconcile(orchestratorID)
        return
      }

      // A subagent is still busy. Wake the orchestrator if it's idle and we
      // haven't exhausted the loop guard.
      if (state.wakeCount >= config.maxWakes) {
        log(
          "warn",
          `watchdog wake cap (${config.maxWakes}) reached for ` +
            `orchestrator ${orchestratorID}; no longer re-prompting`,
        )
        return
      }

      const orchType = await orchestratorStatusType(orchestratorID)
      // Only nudge an IDLE orchestrator — if it's busy it's already working.
      if (orchType !== "idle") return

      // The orchestratorStatusType() await may have raced a concurrent
      // disarm(); skip the nudge if the arm is gone or replaced.
      if (arms.get(orchestratorID) !== state) return

      try {
        await client.session.promptAsync({
          path: { id: orchestratorID },
          body: {
            parts: [
              {
                type: "text",
                text: buildWatchdogPrompt(config.intervalMs, state.wakeCount + 1),
              },
            ],
          },
        })
        // The promptAsync() await may have raced a concurrent disarm(); skip
        // mutating state / logging success if the arm is gone or replaced.
        if (arms.get(orchestratorID) !== state) return
        state.wakeCount += 1
        log(
          "info",
          `watchdog nudged orchestrator ${orchestratorID} ` +
            `(wake ${state.wakeCount}/${config.maxWakes})`,
        )
      } catch {
        log("error", `watchdog failed to nudge orchestrator ${orchestratorID}`)
      }
    } catch {
      // Never throw out of the timer.
    }
  }

  // ------------------------------------------------------------------ hooks

  const onEvent: NonNullable<Hooks["event"]> = async ({ event }) => {
    if (!config.enabled) return
    try {
      switch (event.type) {
        case "session.created": {
          const info = event.properties.info as {
            id?: string
            parentID?: string
          }
          const childID = info?.id
          const parentID = info?.parentID
          if (!childID || !parentID) return // only spawned children have parentID
          // Confirm the parent is an orchestrator (no parentID of its own).
          if (await isOrchestrator(parentID)) {
            registerChild(parentID, childID)
          }
          return
        }
        case "session.idle": {
          const sessionID = event.properties.sessionID
          if (!sessionID) return
          const orchestratorID = childToOrchestrator.get(sessionID)
          if (orchestratorID) {
            const state = arms.get(orchestratorID)
            if (state) state.idleChildIDs.add(sessionID)
            await reconcile(orchestratorID)
            return
          }
          // The idle session might itself be an armed orchestrator: run a
          // poll-fallback reconcile if one is due (catches dropped events).
          const ownState = arms.get(sessionID)
          if (ownState) {
            if (
              Date.now() - ownState.lastReconcileAt >=
              config.pollFallbackMs
            ) {
              await reconcile(sessionID)
            }
          }
          return
        }
        case "session.deleted": {
          const info = event.properties.info as { id?: string } | undefined
          const id = info?.id
          if (!id) return
          if (arms.has(id)) {
            disarm(id)
          } else {
            const orchestratorID = childToOrchestrator.get(id)
            if (orchestratorID) await reconcile(orchestratorID)
          }
          return
        }
        case "session.error": {
          const sessionID = event.properties.sessionID
          if (!sessionID) return
          if (arms.has(sessionID)) {
            disarm(sessionID)
          } else {
            const orchestratorID = childToOrchestrator.get(sessionID)
            if (orchestratorID) await reconcile(orchestratorID)
          }
          return
        }
        default:
          return
      }
    } catch {
      // Never throw into the event firehose.
    }
  }

  const onToolBefore: NonNullable<Hooks["tool.execute.before"]> = async (
    input,
  ) => {
    if (!config.enabled) return
    try {
      // SECONDARY/corroborating signal only — task firing tool.execute.* is
      // UNCONFIRMED, so never rely on it as the sole arm signal.
      if (input.tool !== "task") return
      const orchestratorID = input.sessionID
      if (!orchestratorID) return
      // Only arm for genuine orchestrators (no parentID); a child session can
      // also fire tool.execute.before with tool==='task'.
      if (!(await isOrchestrator(orchestratorID))) return
      const state = arm(orchestratorID)
      state.pendingTaskCallIDs.add(input.callID)
    } catch {
      // Never throw into the tool pipeline.
    }
  }

  const onToolAfter: NonNullable<Hooks["tool.execute.after"]> = async (
    input,
  ) => {
    if (!config.enabled) return
    try {
      if (input.tool !== "task") return
      const orchestratorID = input.sessionID
      if (!orchestratorID) return
      const state = arms.get(orchestratorID)
      if (!state) return
      state.pendingTaskCallIDs.delete(input.callID)
      // If pending task calls drained, reconcile — corroborates completion.
      if (state.pendingTaskCallIDs.size === 0) {
        await reconcile(orchestratorID)
      }
    } catch {
      // Never throw into the tool pipeline.
    }
  }

  function dispose(): void {
    for (const [orchestratorID] of arms) {
      const state = arms.get(orchestratorID)
      if (!state) continue
      try {
        clearInterval(state.timer)
      } catch {
        /* ignore */
      }
      if (state.lastReconcileTimer) {
        try {
          clearTimeout(state.lastReconcileTimer)
        } catch {
          /* ignore */
        }
      }
    }
    arms.clear()
    childToOrchestrator.clear()
  }

  if (!config.enabled) {
    // All handlers become cheap no-ops when disabled.
    return {
      onEvent: noop as NonNullable<Hooks["event"]>,
      onToolBefore: noop as NonNullable<Hooks["tool.execute.before"]>,
      onToolAfter: noop as NonNullable<Hooks["tool.execute.after"]>,
      dispose,
    }
  }

  return { onEvent, onToolBefore, onToolAfter, dispose }
}
