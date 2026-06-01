/**
 * Pure unit tests for the panel-edit helpers + persistence + the consensus
 * single-instance lock (NO network).
 * Run with: node --test tests/consensus/panel.test.mjs
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  deriveId,
  upsertPanelMember,
  removePanelMember,
  setMainMember,
  saveConsensusConfig,
  loadConsensusConfig,
  DEFAULT_CONFIG,
} from "../../dist/consensus/config.js"
import { withConsensusLock } from "../../dist/consensus/lock.js"

/** A fresh config copy with an empty panel. */
function baseConfig() {
  return {
    ...DEFAULT_CONFIG,
    panel: [],
    providers: { ...DEFAULT_CONFIG.providers },
  }
}

test("deriveId: last segment, lowercased, non-alphanumerics -> -", () => {
  assert.equal(deriveId("anthropic/claude-opus-4.6"), "claude-opus-4-6")
  assert.equal(deriveId("x-ai/grok-4"), "grok-4")
  assert.equal(deriveId("GPT_4o"), "gpt-4o")
  assert.equal(deriveId("openai/gpt-4o:free"), "gpt-4o-free")
})

test("upsertPanelMember: add new member auto-derives id and becomes main when first", () => {
  let cfg = baseConfig()
  cfg = upsertPanelMember(cfg, {
    id: "",
    provider: "openrouter",
    model: "anthropic/claude-opus-4.6",
  })
  assert.equal(cfg.panel.length, 1)
  assert.equal(cfg.panel[0].id, "claude-opus-4-6")
  assert.equal(cfg.panel[0].main, true, "first member becomes main")
})

test("upsertPanelMember: update existing member (match by id)", () => {
  let cfg = baseConfig()
  cfg = upsertPanelMember(cfg, {
    id: "opus",
    provider: "openrouter",
    model: "anthropic/claude-opus-4.6",
  })
  cfg = upsertPanelMember(cfg, {
    id: "opus",
    provider: "openrouter",
    model: "anthropic/claude-opus-4.6",
    reasoning: "high",
  })
  assert.equal(cfg.panel.length, 1, "updated, not duplicated")
  assert.equal(cfg.panel[0].reasoning, "high")
})

test("upsertPanelMember: only one main when multiple added", () => {
  let cfg = baseConfig()
  cfg = upsertPanelMember(cfg, { id: "a", provider: "openrouter", model: "m/a" })
  cfg = upsertPanelMember(cfg, { id: "b", provider: "openrouter", model: "m/b" })
  const mains = cfg.panel.filter((m) => m.main)
  assert.equal(mains.length, 1, "exactly one main")
  assert.equal(mains[0].id, "a", "first stays main")
})

test("upsertPanelMember: id collision with DIFFERENT model -> suffix", () => {
  let cfg = baseConfig()
  // Two different slugs that derive the same id.
  cfg = upsertPanelMember(cfg, { id: "", provider: "openrouter", model: "vendorA/model" })
  cfg = upsertPanelMember(cfg, { id: "", provider: "openrouter", model: "vendorB/model" })
  assert.equal(cfg.panel.length, 2)
  assert.equal(cfg.panel[0].id, "model")
  assert.equal(cfg.panel[1].id, "model-2", "collision suffix applied")
})

test("upsertPanelMember: same model re-add updates existing derived id (no suffix)", () => {
  let cfg = baseConfig()
  cfg = upsertPanelMember(cfg, { id: "", provider: "openrouter", model: "vendor/model" })
  cfg = upsertPanelMember(cfg, {
    id: "",
    provider: "openrouter",
    model: "vendor/model",
    reasoning: "low",
  })
  assert.equal(cfg.panel.length, 1, "same model -> same id -> updated")
  assert.equal(cfg.panel[0].reasoning, "low")
})

test("removePanelMember: by id, promotes first remaining to main", () => {
  let cfg = baseConfig()
  cfg = upsertPanelMember(cfg, { id: "a", provider: "openrouter", model: "m/a" })
  cfg = upsertPanelMember(cfg, { id: "b", provider: "openrouter", model: "m/b" })
  cfg = upsertPanelMember(cfg, { id: "c", provider: "openrouter", model: "m/c" })
  // 'a' is main; remove it.
  cfg = removePanelMember(cfg, "a")
  assert.equal(cfg.panel.length, 2)
  const mains = cfg.panel.filter((m) => m.main)
  assert.equal(mains.length, 1)
  assert.equal(mains[0].id, "b", "first remaining promoted to main")
})

test("removePanelMember: by model slug", () => {
  let cfg = baseConfig()
  cfg = upsertPanelMember(cfg, { id: "a", provider: "openrouter", model: "m/a" })
  cfg = upsertPanelMember(cfg, { id: "b", provider: "openrouter", model: "m/b" })
  cfg = removePanelMember(cfg, "m/b")
  assert.equal(cfg.panel.length, 1)
  assert.equal(cfg.panel[0].id, "a")
})

test("setMainMember: sets main on id, unsets others; throws if not found", () => {
  let cfg = baseConfig()
  cfg = upsertPanelMember(cfg, { id: "a", provider: "openrouter", model: "m/a" })
  cfg = upsertPanelMember(cfg, { id: "b", provider: "openrouter", model: "m/b" })
  cfg = setMainMember(cfg, "b")
  assert.equal(cfg.panel.find((m) => m.id === "b").main, true)
  assert.equal(cfg.panel.find((m) => m.id === "a").main, false)
  assert.throws(() => setMainMember(cfg, "nope"), /No panel member/)
})

test("saveConsensusConfig -> loadConsensusConfig round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "consensus-panel-"))
  const prev = process.env.CONSENSUS_ENABLED
  try {
    delete process.env.CONSENSUS_ENABLED
    let cfg = baseConfig()
    cfg.enabled = true
    cfg.synthesis = "fusion"
    cfg.requireParameters = true
    cfg = upsertPanelMember(cfg, {
      id: "opus",
      provider: "openrouter",
      model: "anthropic/claude-opus-4.6",
      reasoning: "high",
    })
    cfg = upsertPanelMember(cfg, {
      id: "grok",
      provider: "openrouter",
      model: "x-ai/grok-4",
    })
    saveConsensusConfig(dir, cfg)

    const loaded = loadConsensusConfig(dir)
    assert.equal(loaded.enabled, true)
    assert.equal(loaded.synthesis, "fusion")
    assert.equal(loaded.requireParameters, true)
    assert.equal(loaded.panel.length, 2)
    assert.equal(loaded.panel.find((m) => m.id === "opus").reasoning, "high")
    assert.equal(loaded.panel.find((m) => m.id === "opus").main, true)
    assert.equal(loaded.panel.find((m) => m.id === "grok").main, false)
  } finally {
    if (prev === undefined) delete process.env.CONSENSUS_ENABLED
    else process.env.CONSENSUS_ENABLED = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test("withConsensusLock: overlapping calls run sequentially (no overlap)", async () => {
  const events = []
  const mkTask = (label, delay) => async () => {
    events.push(`${label}:start`)
    await new Promise((r) => setTimeout(r, delay))
    events.push(`${label}:end`)
    return label
  }

  // Fire both without awaiting the first — they overlap in wall-clock time.
  const p1 = withConsensusLock(mkTask("A", 30))
  const p2 = withConsensusLock(mkTask("B", 5))
  const results = await Promise.all([p1, p2])

  assert.deepEqual(results, ["A", "B"])
  // A must fully complete before B starts.
  assert.deepEqual(events, ["A:start", "A:end", "B:start", "B:end"])
})
