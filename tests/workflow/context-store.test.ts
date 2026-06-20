/**
 * Unit tests for the per-run content-addressed context store (plan §A.2, §D.3).
 *
 * Proves the three token-control invariants:
 *  1. A large (30k-token) artifact is injected as its ≤40-line SUMMARY, not full.
 *  2. `@full:label` forces verbatim full-text injection.
 *  3. Exceeding `perAgentContextCapTokens` trims the OLDEST non-`@full` ref and
 *     NEVER trims the immutable WorkflowBrief.
 *
 * Run: `bun test tests/workflow/context-store.test.ts`
 */
import { test, expect } from "bun:test"
import {
  ContextStore,
  estimateTokens,
  type WorkflowBrief,
} from "../../src/workflow/context-store.ts"

const BRIEF: WorkflowBrief = {
  task: "Add input validation and tests to src/",
  directory: "/repo/project",
  constraints: ["No new deps", "Never throw in timers"],
  dag: "P1: implement -> P2: tests | docs -> P3: verify",
}

/** Build a multi-line blob of roughly `tokens` estimated tokens (chars/4). */
function blob(tokens: number, lineWord = "lorem"): string {
  const targetChars = tokens * 4
  // ~ (word+space) per chunk; spread across many lines so summaries elide.
  const perLine = (lineWord + " ").repeat(8) // 1 line
  const charsPerLine = perLine.length + 1 // + newline
  const lineCount = Math.ceil(targetChars / charsPerLine)
  const lines: string[] = []
  for (let i = 0; i < lineCount; i++) lines.push(`${i} ${perLine}`)
  return lines.join("\n")
}

test("30k-token artifact injects as a <=40-line summary, not the full text", () => {
  const store = new ContextStore(BRIEF)

  const full = blob(30_000, "implementation")
  expect(estimateTokens(full)).toBeGreaterThan(25_000) // genuinely large

  store.putArtifact({ label: "impl:source", phase: 1, full })

  const { system, context } = store.injectionFor({
    label: "writer",
    phase: 2,
    contextRefs: ["impl:source"],
  })

  // Brief is injected verbatim into system.
  expect(system).toContain("## WorkflowBrief")
  expect(system).toContain(BRIEF.task)

  // Upstream context present and references the artifact.
  expect(context).toContain("## Upstream Context")
  expect(context).toContain("impl:source")

  // The injected upstream summary block is small (<=40 content lines + headers),
  // NOT the ~7000-line full blob.
  const upstreamLines = context.split("\n").length
  expect(upstreamLines).toBeLessThan(60)

  // Summary must NOT contain the full body — it should be elided.
  expect(context).toContain("line")
  expect(context).toContain("elided")
  // Full text would be enormous; injected context must be far smaller.
  expect(estimateTokens(context)).toBeLessThan(2_000)
})

test("@full:label forces verbatim full-text injection", () => {
  const store = new ContextStore(BRIEF)

  const full = blob(8_000, "verbatimdetail")
  store.putArtifact({ label: "verify:final", phase: 2, full })

  // Default (summary) injection is small...
  const summaryInj = store.injectionFor({
    label: "synth",
    phase: 3,
    contextRefs: ["verify:final"],
  })
  expect(estimateTokens(summaryInj.context)).toBeLessThan(1_500)

  // ...but @full forces the entire body in.
  const fullInj = store.injectionFor({
    label: "synth",
    phase: 3,
    contextRefs: ["@full:verify:final"],
  })
  expect(fullInj.context).toContain("verify:final (full)")
  // The full body is present verbatim (a deep line that head/tail would elide).
  expect(fullInj.context).toContain(full)
  expect(estimateTokens(fullInj.context)).toBeGreaterThan(7_000)
})

test("exceeding perAgentContextCapTokens trims the OLDEST non-@full ref first", () => {
  // Small cap so a few summaries blow the budget. Disable head/tail elision by
  // using inputs that are already <=40 lines so each summary == its full text,
  // giving us predictable token sizes per ref.
  // Cap fits two ~600-token summaries (~1200) but not three (~1800).
  const cap = 1_300
  const store = new ContextStore(BRIEF, { perAgentContextCapTokens: cap })

  // Each ~600-token, single-region artifact, inserted oldest -> newest.
  const oldText = "OLD-ARTIFACT " + "x".repeat(600 * 4)
  const midText = "MID-ARTIFACT " + "y".repeat(600 * 4)
  const newText = "NEW-ARTIFACT " + "z".repeat(600 * 4)

  store.putArtifact({ label: "old", phase: 1, full: oldText, summary: oldText })
  store.putArtifact({ label: "mid", phase: 1, full: midText, summary: midText })
  store.putArtifact({ label: "new", phase: 1, full: newText, summary: newText })

  const resolved = store.resolveRefs(["old", "mid", "new"], cap)
  const keptLabels = resolved.map((r) => r.label)

  // The NEWEST two are kept; the OLDEST ("old") is trimmed.
  expect(keptLabels).toContain("new")
  expect(keptLabels).toContain("mid")
  expect(keptLabels).not.toContain("old")

  // Total kept tokens must respect the cap.
  const total = resolved.reduce((s, r) => s + r.tokensEst, 0)
  expect(total).toBeLessThanOrEqual(cap)
})

test("the WorkflowBrief is NEVER trimmed, even under an absurdly tiny cap", () => {
  const store = new ContextStore(BRIEF, { perAgentContextCapTokens: 1 })

  const huge = blob(20_000, "huge")
  store.putArtifact({ label: "big", phase: 1, full: huge })

  const { system, context } = store.injectionFor({
    label: "downstream",
    phase: 2,
    contextRefs: ["big"],
  })

  // Brief survives fully regardless of cap (it is immutable system context).
  expect(system).toContain("## WorkflowBrief")
  expect(system).toContain(BRIEF.task)
  expect(system).toContain(BRIEF.directory)
  for (const c of BRIEF.constraints ?? []) expect(system).toContain(c)

  // Under a cap of 1 token, the summary ref does not fit and is dropped.
  expect(context).not.toContain("## Upstream Context")
})

test("@full refs are protected even when summary refs are being trimmed", () => {
  const store = new ContextStore(BRIEF, { perAgentContextCapTokens: 800 })

  const protectedText = "PROTECTED " + "p".repeat(700 * 4) // ~700 tokens, forced full
  const summaryText = "SUMMARYREF " + "s".repeat(600 * 4) // ~600 tokens, trimmable

  store.putArtifact({ label: "keepme", phase: 1, full: protectedText, summary: "tiny" })
  store.putArtifact({ label: "dropme", phase: 1, full: summaryText, summary: summaryText })

  const resolved = store.resolveRefs(["@full:keepme", "dropme"], 800)
  const labels = resolved.map((r) => r.label)

  // The forced-full ref is reserved first and kept verbatim...
  expect(labels).toContain("keepme")
  const kept = resolved.find((r) => r.label === "keepme")!
  expect(kept.full).toBe(true)
  expect(kept.text).toBe(protectedText)

  // ...leaving no room for the ~600-token summary ref, which is trimmed.
  expect(labels).not.toContain("dropme")
})

test("addNote is append-only, clamps to 2 lines, and keeps only the last 50", () => {
  const store = new ContextStore(BRIEF, { maxNotes: 50 })

  store.addNote("line1\nline2\nline3\nline4") // should clamp to 2 lines
  const first = store.getNotes()[0]
  expect(first.split("\n").length).toBeLessThanOrEqual(2)
  expect(first).toContain("line1")
  expect(first).not.toContain("line3")

  for (let i = 0; i < 60; i++) store.addNote(`note ${i}`)
  const notes = store.getNotes()
  expect(notes.length).toBe(50)
  // Oldest dropped: the very first clamped note is gone; newest retained.
  expect(notes).toContain("note 59")
  expect(notes).not.toContain("line1\nline2")
})

test("phase:N resolves all artifacts in a phase as summaries", () => {
  const store = new ContextStore(BRIEF)
  store.putArtifact({ label: "a", phase: 2, full: "alpha body", summary: "alpha sum" })
  store.putArtifact({ label: "b", phase: 2, full: "beta body", summary: "beta sum" })
  store.putArtifact({ label: "c", phase: 3, full: "gamma body", summary: "gamma sum" })

  const resolved = store.resolveRefs(["phase:2"])
  const labels = resolved.map((r) => r.label).sort()
  expect(labels).toEqual(["a", "b"])
  expect(resolved.every((r) => !r.full)).toBe(true)
})
