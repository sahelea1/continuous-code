/**
 * Singleton WorkflowRegistry — active-run + active-child bookkeeping.
 *
 * The engine registers a child session here the moment it starts an agent turn
 * and deregisters it the moment that turn settles. Two consumers read this:
 *
 *  - the drift-watcher loop (`src/workflow/drift-watcher.ts`) round-robins the
 *    currently-active children (the ones it should snapshot each sweep);
 *  - the dashboard (`src/workflow/dashboard.ts`) seeds `/state` for late joiners.
 *
 * Design mirrors the watchdog's `Set`-based bookkeeping (`src/watchdog/watchdog.ts`):
 *  - in-memory only, no `@opencode-ai/plugin` import, no I/O;
 *  - never throws — there is no async/timer work here, but every public method
 *    is defensive against bad input so a buggy caller cannot break the engine;
 *  - a single module-level singleton (`workflowRegistry`) is imported everywhere,
 *    exactly like `uiBus` in `ui-bus.ts`.
 *
 * "Active" = a child whose `session.prompt` turn is in flight. A child is added
 * on `register()` and removed on `deregister()`; respawns (drift kill+rerun)
 * deregister the aborted child and register the fresh one.
 */

/**
 * One in-flight child session tracked while its agent turn runs.
 */
export interface ActiveChild {
  /** The child session id returned by `client.session.create`. */
  sessionId: string
  /** The owning workflow run id (one run == one engine instance). */
  runId: string
  /** Human label (matches AgentSpec.label / the child session title). */
  label: string
  /** Phase index that started this child. */
  phase: number
  /** Resolved model shorthand or "{providerID}:{modelID}" for display. */
  model: string
  /** Resolved OpenCode agent type the turn runs as. */
  agentType: string
  /** Epoch ms when the turn started (for age / sweep ordering). */
  startedAt: number
}

/**
 * One workflow run. `children` holds only the CURRENTLY-active child ids; the
 * full detail lives in the registry's flat `byId` map so lookups are O(1).
 */
export interface ActiveRun {
  runId: string
  title: string
  directory: string
  startedAt: number
  /** Ids of children currently in flight for this run. */
  children: Set<string>
}

/** A flat snapshot for the dashboard / drift loop. */
export interface RegistrySnapshot {
  runs: Array<{
    runId: string
    title: string
    directory: string
    startedAt: number
    activeChildren: ActiveChild[]
  }>
  /** All active children across every run (flattened, for the drift sweep). */
  activeChildren: ActiveChild[]
}

/**
 * Process-wide registry of active workflow runs and their in-flight children.
 *
 * One instance is exported as `workflowRegistry`. The engine calls
 * `startRun`/`endRun` around a whole workflow and `register`/`deregister`
 * around each agent turn.
 */
export class WorkflowRegistry {
  /** runId -> run record. */
  private readonly runs = new Map<string, ActiveRun>()
  /** Flat childSessionId -> detail, for O(1) lookup by drift loop. */
  private readonly byId = new Map<string, ActiveChild>()

  /**
   * Open a run. Idempotent: re-opening an existing runId refreshes its title /
   * directory but preserves any already-tracked children.
   */
  startRun(runId: string, title: string, directory: string): void {
    if (!runId) return
    const existing = this.runs.get(runId)
    if (existing) {
      existing.title = title || existing.title
      existing.directory = directory || existing.directory
      return
    }
    this.runs.set(runId, {
      runId,
      title: title || runId,
      directory: directory || "",
      startedAt: Date.now(),
      children: new Set<string>(),
    })
  }

  /**
   * Close a run and drop all of its remaining child entries (defensive cleanup
   * in case a turn settled without deregistering). No-op for an unknown runId.
   */
  endRun(runId: string): void {
    const run = this.runs.get(runId)
    if (!run) return
    for (const childId of run.children) {
      this.byId.delete(childId)
    }
    this.runs.delete(runId)
  }

  /**
   * Mark a child session active for its run. Auto-opens the run if it was not
   * explicitly started (so a stray register can never silently lose a child).
   * Overwrites a prior entry for the same sessionId (respawn-safe).
   */
  register(child: ActiveChild): void {
    if (!child || !child.sessionId || !child.runId) return
    let run = this.runs.get(child.runId)
    if (!run) {
      this.startRun(child.runId, child.runId, "")
      run = this.runs.get(child.runId)!
    }
    run.children.add(child.sessionId)
    this.byId.set(child.sessionId, { ...child })
  }

  /**
   * Mark a child session no longer active. Removes it from both the flat map
   * and its run's set. Safe to call for an unknown sessionId (no-op).
   */
  deregister(sessionId: string): void {
    if (!sessionId) return
    const child = this.byId.get(sessionId)
    this.byId.delete(sessionId)
    if (!child) return
    const run = this.runs.get(child.runId)
    if (run) run.children.delete(sessionId)
  }

  /** Detail for a single active child, or undefined. */
  get(sessionId: string): ActiveChild | undefined {
    return this.byId.get(sessionId)
  }

  /** True if the session is currently tracked as active. */
  isActive(sessionId: string): boolean {
    return this.byId.has(sessionId)
  }

  /**
   * All currently-active children across every run, oldest-started first.
   * This is the list the drift-watcher round-robins each sweep.
   */
  listActive(): ActiveChild[] {
    return [...this.byId.values()].sort((a, b) => a.startedAt - b.startedAt)
  }

  /** Active children for one run only (oldest-started first). */
  listActiveForRun(runId: string): ActiveChild[] {
    const run = this.runs.get(runId)
    if (!run) return []
    const out: ActiveChild[] = []
    for (const id of run.children) {
      const c = this.byId.get(id)
      if (c) out.push(c)
    }
    return out.sort((a, b) => a.startedAt - b.startedAt)
  }

  /** Count of currently-active children (all runs). */
  get activeCount(): number {
    return this.byId.size
  }

  /** Count of open runs. */
  get runCount(): number {
    return this.runs.size
  }

  /**
   * A copy snapshot for the dashboard `/state` endpoint and the drift loop.
   * Pure data — mutating it does not affect the registry.
   */
  snapshot(): RegistrySnapshot {
    const runs = [...this.runs.values()].map((run) => ({
      runId: run.runId,
      title: run.title,
      directory: run.directory,
      startedAt: run.startedAt,
      activeChildren: this.listActiveForRun(run.runId),
    }))
    return { runs, activeChildren: this.listActive() }
  }
}

/**
 * The process-wide singleton. Import this everywhere:
 *
 *   import { workflowRegistry } from "./registry.js"
 *
 * Engine side:    workflowRegistry.register({...}) / .deregister(id)
 * Drift loop:     workflowRegistry.listActive()
 * Dashboard side: workflowRegistry.snapshot()
 */
export const workflowRegistry = new WorkflowRegistry()
