/**
 * Per-run content-addressed context store for the workflow engine (plan §A.2).
 *
 * This is NOT the semantic memory backend (`src/memory/*`). It is an in-memory,
 * per-workflow-run `Map` of artifacts that implements the core token-control
 * lever: downstream agents receive SUMMARIES of upstream work by default, and
 * full verbatim text ONLY when a ref explicitly opts in via `@full:label`.
 *
 * Token estimate is a deliberately conservative `chars/4` heuristic (OpenCode
 * exposes no live token meter to the plugin; for *caps* an upper bound is all we
 * need — overcounting keeps the ceilings safe). Reconciliation R-style: pure
 * logic, no `@opencode-ai/plugin` import, never throws on bad input.
 */

// --- Types (mirror plan §B `types.ts`; defined here so the store is
// self-contained and buildable independently of the parallel types.ts task.
// When types.ts lands these can be imported instead). -----------------------

/**
 * A stored result from one `agent()` call. Downstream nodes pull these by
 * reference (see `resolveRefs`), getting `summary` by default and `full` only
 * when explicitly requested with `@full:`.
 */
export interface Artifact {
  /** Stable id (defaults to `label` when not provided). */
  id: string
  /** Human ref name, e.g. "impl:source"; the primary key callers reference. */
  label: string
  /** 1-based phase index this artifact was produced in. */
  phase: number
  /** ≤40-line digest (model-generated or head/tail). Injected by default. */
  summary: string
  /** Complete agent output. Injected only on `@full:` refs. */
  full: string
  /** chars/4 estimate of `full`. */
  tokensEst: number
  /** Insertion order, used for oldest-first trimming. */
  seq?: number
}

/**
 * The small, stable, immutable brief injected verbatim into EVERY agent's
 * `system`. Kept tiny on purpose (cache-friendly shared context).
 */
export interface WorkflowBrief {
  /** The user's original task / request. */
  task: string
  /** Absolute repo path the workflow operates on. */
  directory: string
  /** Global constraints every agent must honor. */
  constraints?: string[]
  /** A compact rendering of the planned DAG (phases/agents). */
  dag?: string
}

/**
 * The slice of an `AgentSpec` the store needs to build an agent's injection.
 * (The full `AgentSpec` lives in `types.ts`; this is structurally compatible.)
 */
export interface AgentSpecLike {
  label?: string
  phase?: number
  /** Refs to upstream artifacts: "label", "phase:N", or "@full:label". */
  contextRefs?: string[]
}

export interface ResolvedRef {
  /** Original ref string. */
  ref: string
  /** Resolved artifact label. */
  label: string
  /** Whether full text (vs summary) was selected. */
  full: boolean
  /** The text chosen for injection (summary or full). */
  text: string
  /** chars/4 estimate of `text`. */
  tokensEst: number
}

export interface ContextStoreOptions {
  /** Per-agent injection ceiling in estimated tokens. Default 60_000. */
  perAgentContextCapTokens?: number
  /** Max lines kept for a head/tail summary when no model summary given. Default 40. */
  summaryMaxLines?: number
  /** Hard cap on retained blackboard notes (last N). Default 50. */
  maxNotes?: number
}

// --- Constants --------------------------------------------------------------

const DEFAULT_CAP_TOKENS = 60_000
const DEFAULT_SUMMARY_MAX_LINES = 40
const DEFAULT_MAX_NOTES = 50
const MAX_NOTE_LINES = 2

/** Conservative chars/4 token estimate (rounds up — an upper bound for caps). */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/**
 * Build a ≤`maxLines` head/tail digest of `text`. If the text already fits, it
 * is returned as-is. Otherwise the first and last halves are kept with a
 * truncation marker between them — preserving both the agent's lead-in and its
 * conclusion (where outcomes usually live).
 */
export function headTailSummary(text: string, maxLines = DEFAULT_SUMMARY_MAX_LINES): string {
  if (!text) return ""
  const lines = text.split("\n")
  if (lines.length <= maxLines) return text
  // Reserve one line for the elision marker.
  const keep = maxLines - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  const omitted = lines.length - head - tail
  const headPart = lines.slice(0, head)
  const tailPart = tail > 0 ? lines.slice(lines.length - tail) : []
  return [
    ...headPart,
    `… [${omitted} line${omitted === 1 ? "" : "s"} elided] …`,
    ...tailPart,
  ].join("\n")
}

/**
 * Per-run content-addressed context store.
 *
 * Lifecycle: one instance per workflow run. Created with the immutable
 * `WorkflowBrief`; artifacts and notes accumulate as phases complete; each
 * downstream agent calls `injectionFor(spec)` to get its bounded context block.
 */
export class ContextStore {
  private readonly brief: WorkflowBrief
  private readonly artifacts = new Map<string, Artifact>()
  private readonly notes: string[] = []
  private seqCounter = 0

  readonly perAgentContextCapTokens: number
  readonly summaryMaxLines: number
  readonly maxNotes: number

  constructor(brief: WorkflowBrief, opts: ContextStoreOptions = {}) {
    this.brief = brief
    this.perAgentContextCapTokens =
      opts.perAgentContextCapTokens && opts.perAgentContextCapTokens > 0
        ? opts.perAgentContextCapTokens
        : DEFAULT_CAP_TOKENS
    this.summaryMaxLines =
      opts.summaryMaxLines && opts.summaryMaxLines > 0
        ? opts.summaryMaxLines
        : DEFAULT_SUMMARY_MAX_LINES
    this.maxNotes =
      opts.maxNotes && opts.maxNotes > 0 ? opts.maxNotes : DEFAULT_MAX_NOTES
  }

  /**
   * Store an agent result. If `summary` is empty/missing, a ≤`summaryMaxLines`
   * head/tail digest of `full` is generated. `id` defaults to `label`;
   * `tokensEst` is (re)computed from `full`. Stored by `label` (the ref key);
   * later artifacts with the same label overwrite earlier ones (last write
   * wins), preserving insertion order for trimming.
   */
  putArtifact(a: Partial<Artifact> & { label: string; full: string; phase: number }): Artifact {
    const label = a.label
    const full = a.full ?? ""
    const summary =
      a.summary && a.summary.trim().length > 0
        ? a.summary
        : headTailSummary(full, this.summaryMaxLines)
    const existing = this.artifacts.get(label)
    const artifact: Artifact = {
      id: a.id ?? label,
      label,
      phase: a.phase,
      summary,
      full,
      tokensEst: estimateTokens(full),
      // Keep original seq on overwrite so an updated artifact does not jump to
      // "newest" (its position in the run is stable).
      seq: existing?.seq ?? this.seqCounter++,
    }
    this.artifacts.set(label, artifact)
    return artifact
  }

  /** True if an artifact with `label` exists. */
  has(label: string): boolean {
    return this.artifacts.has(label)
  }

  /** The summary text for `ref`, or undefined. Accepts bare label or `@full:`/`phase:` forms. */
  getSummary(ref: string): string | undefined {
    const { kind, key } = parseRef(ref)
    if (kind === "phase") {
      const arts = this.artifactsForPhase(Number(key))
      if (arts.length === 0) return undefined
      return arts.map((x) => `### ${x.label}\n${x.summary}`).join("\n\n")
    }
    return this.artifacts.get(key)?.summary
  }

  /** The full text for `ref`, or undefined. */
  getFull(ref: string): string | undefined {
    const { kind, key } = parseRef(ref)
    if (kind === "phase") {
      const arts = this.artifactsForPhase(Number(key))
      if (arts.length === 0) return undefined
      return arts.map((x) => `### ${x.label}\n${x.full}`).join("\n\n")
    }
    return this.artifacts.get(key)?.full
  }

  /**
   * Append a one-liner finding to the blackboard. Each note is clamped to
   * `MAX_NOTE_LINES` lines; the store keeps only the last `maxNotes`. No-op on
   * empty input. Never throws.
   */
  addNote(s: string): void {
    if (!s) return
    const clamped = s.split("\n").slice(0, MAX_NOTE_LINES).join("\n").trim()
    if (!clamped) return
    this.notes.push(clamped)
    if (this.notes.length > this.maxNotes) {
      this.notes.splice(0, this.notes.length - this.maxNotes)
    }
  }

  /** Snapshot of current blackboard notes (newest last). */
  getNotes(): string[] {
    return [...this.notes]
  }

  /**
   * Resolve a list of refs into selected texts under a token cap.
   *
   * Ref forms:
   *  - `"label"`            → that artifact's SUMMARY
   *  - `"phase:N"`          → all phase-N artifacts' summaries (one logical ref)
   *  - `"@full:label"`      → that artifact's FULL text (forced verbatim)
   *
   * Budgeting: `@full` refs are protected — they are reserved first and never
   * trimmed. The remaining (summary) refs fill the leftover budget in declared
   * order; when the running total would exceed `capTokens`, the OLDEST
   * non-`@full` artifacts (lowest `seq`) are dropped first. Unknown refs are
   * skipped silently (resilient to a phase that produced nothing).
   */
  resolveRefs(refs: string[], capTokens = this.perAgentContextCapTokens): ResolvedRef[] {
    if (!Array.isArray(refs) || refs.length === 0) return []

    const resolved: ResolvedRef[] = []
    for (const ref of refs) {
      if (!ref) continue
      const { kind, key, full } = parseRef(ref)
      if (kind === "phase") {
        const arts = this.artifactsForPhase(Number(key))
        for (const art of arts) {
          const text = full ? art.full : art.summary
          resolved.push({
            ref,
            label: art.label,
            full,
            text,
            tokensEst: estimateTokens(text),
          })
        }
        continue
      }
      const art = this.artifacts.get(key)
      if (!art) continue
      const text = full ? art.full : art.summary
      resolved.push({
        ref,
        label: art.label,
        full,
        text,
        tokensEst: estimateTokens(text),
      })
    }

    // Partition: forced-full refs are protected; summary refs are trimmable.
    const forced = resolved.filter((r) => r.full)
    const trimmable = resolved.filter((r) => !r.full)

    // Order trimmable by artifact age (oldest first) so we keep newest context.
    const seqOf = (label: string) => this.artifacts.get(label)?.seq ?? 0
    const trimmableNewestFirst = [...trimmable].sort((a, b) => seqOf(b.label) - seqOf(a.label))

    // Reserve full refs' budget first (they are never trimmed).
    let used = forced.reduce((sum, r) => sum + r.tokensEst, 0)

    // Greedily keep newest summaries that still fit under the cap.
    const keptTrimmable = new Set<ResolvedRef>()
    for (const r of trimmableNewestFirst) {
      if (used + r.tokensEst > capTokens) continue
      used += r.tokensEst
      keptTrimmable.add(r)
    }

    // Re-emit in the caller's original declared order, dropping trimmed ones.
    return resolved.filter((r) => r.full || keptTrimmable.has(r))
  }

  /**
   * Build the complete context injection for one agent under the per-agent cap.
   * Returns the system string (immutable brief, ALWAYS verbatim, never trimmed)
   * and the user-facing context block (`## Upstream Context` of resolved ref
   * texts + the blackboard notes).
   *
   * Budget order (most→least protected):
   *   1. WorkflowBrief  — verbatim, never trimmed (load-bearing shared context).
   *   2. `@full:` refs  — protected, never trimmed.
   *   3. blackboard notes — small, kept.
   *   4. summary refs   — oldest trimmed first to fit the remaining budget.
   */
  injectionFor(spec: AgentSpecLike): { system: string; context: string; tokensEst: number } {
    const system = renderBrief(this.brief)
    const briefTokens = estimateTokens(system)

    const refs = Array.isArray(spec.contextRefs) ? spec.contextRefs : []

    // Notes are tiny and protected; reserve their budget before summary refs.
    const notesBlock = this.renderNotes()
    const notesTokens = estimateTokens(notesBlock)

    // The cap governs the injected CONTEXT (brief is separate/immutable system),
    // but we still account brief+notes against the per-agent budget so a large
    // brief shrinks the room available to summary refs (never the reverse).
    const remainingForRefs = Math.max(
      0,
      this.perAgentContextCapTokens - notesTokens,
    )

    const resolved = this.resolveRefs(refs, remainingForRefs)
    const upstreamBlock = this.renderUpstream(resolved)

    const parts: string[] = []
    if (upstreamBlock) parts.push(upstreamBlock)
    if (notesBlock) parts.push(notesBlock)
    const context = parts.join("\n\n")

    return {
      system,
      context,
      tokensEst: briefTokens + estimateTokens(context),
    }
  }

  // --- internal helpers -----------------------------------------------------

  private artifactsForPhase(phase: number): Artifact[] {
    if (!Number.isFinite(phase)) return []
    return [...this.artifacts.values()]
      .filter((a) => a.phase === phase)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  }

  private renderUpstream(resolved: ResolvedRef[]): string {
    if (resolved.length === 0) return ""
    const blocks = resolved.map((r) => {
      const tag = r.full ? `${r.label} (full)` : r.label
      return `### ${tag}\n${r.text}`
    })
    return `## Upstream Context\n\n${blocks.join("\n\n")}`
  }

  private renderNotes(): string {
    if (this.notes.length === 0) return ""
    const items = this.notes.map((n) => `- ${n.replace(/\n/g, "\n  ")}`)
    return `## Blackboard Notes\n\n${items.join("\n")}`
  }
}

// --- ref parsing ------------------------------------------------------------

interface ParsedRef {
  kind: "label" | "phase"
  key: string
  full: boolean
}

/**
 * Parse a ref string into its kind and key.
 *  - `@full:` prefix forces full injection (may combine with `phase:`).
 *  - `phase:N` selects all artifacts in phase N.
 *  - anything else is a bare artifact label.
 */
export function parseRef(ref: string): ParsedRef {
  let rest = ref.trim()
  let full = false
  if (rest.toLowerCase().startsWith("@full:")) {
    full = true
    rest = rest.slice("@full:".length).trim()
  }
  if (rest.toLowerCase().startsWith("phase:")) {
    return { kind: "phase", key: rest.slice("phase:".length).trim(), full }
  }
  return { kind: "label", key: rest, full }
}

/** Render the immutable brief into a stable, cache-friendly system string. */
export function renderBrief(brief: WorkflowBrief): string {
  const lines: string[] = ["## WorkflowBrief", "", `Task: ${brief.task}`, `Repo: ${brief.directory}`]
  if (brief.constraints && brief.constraints.length > 0) {
    lines.push("", "Constraints:")
    for (const c of brief.constraints) lines.push(`- ${c}`)
  }
  if (brief.dag && brief.dag.trim().length > 0) {
    lines.push("", "Planned DAG:", brief.dag.trim())
  }
  return lines.join("\n")
}
