/**
 * Pure unit tests for the consensus config module (NO network).
 * Run with: node --test tests/consensus/config.test.mjs
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  loadConsensusConfig,
  validateForRun,
  getMain,
  DEFAULT_CONFIG,
} from "../../dist/consensus/config.js"

/** Create a fresh temp dir for fixtures (in OS temp, never in the repo). */
function freshDir() {
  return mkdtempSync(join(tmpdir(), "consensus-cfg-"))
}

/** Write a consensus.json into the given dir. */
function writeConfig(dir, obj) {
  writeFileSync(join(dir, "consensus.json"), JSON.stringify(obj), "utf-8")
}

test("no consensus.json present -> defaults, enabled=false", () => {
  const dir = freshDir()
  try {
    const cfg = loadConsensusConfig(dir)
    assert.equal(cfg.enabled, false)
    assert.equal(cfg.enabled, DEFAULT_CONFIG.enabled)
    assert.deepEqual(cfg.panel, [])
    assert.equal(cfg.synthesis, DEFAULT_CONFIG.synthesis)
    assert.equal(cfg.maxTokens, DEFAULT_CONFIG.maxTokens)
    // Default providers should be present.
    assert.ok(cfg.providers.openrouter)
    assert.equal(
      cfg.providers.openrouter.baseURL,
      "https://openrouter.ai/api/v1",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("3-model panel with NO main flagged -> first becomes main", () => {
  const dir = freshDir()
  try {
    writeConfig(dir, {
      enabled: true,
      panel: [
        { id: "a", provider: "openrouter", model: "m/a" },
        { id: "b", provider: "openrouter", model: "m/b" },
        { id: "c", provider: "openrouter", model: "m/c" },
      ],
    })
    const cfg = loadConsensusConfig(dir)
    const mains = cfg.panel.filter((m) => m.main)
    assert.equal(mains.length, 1, "exactly one main")
    assert.equal(mains[0].id, "a", "first member is main")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("panel with TWO main flags -> only the first remains main", () => {
  const dir = freshDir()
  try {
    writeConfig(dir, {
      enabled: true,
      panel: [
        { id: "a", provider: "openrouter", model: "m/a", main: true },
        { id: "b", provider: "openrouter", model: "m/b", main: true },
        { id: "c", provider: "openrouter", model: "m/c" },
      ],
    })
    const cfg = loadConsensusConfig(dir)
    const mains = cfg.panel.filter((m) => m.main)
    assert.equal(mains.length, 1, "exactly one main")
    assert.equal(mains[0].id, "a", "first flagged main wins")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("CONSENSUS_ENABLED=true env overrides file enabled=false", () => {
  const dir = freshDir()
  const prev = process.env.CONSENSUS_ENABLED
  try {
    writeConfig(dir, {
      enabled: false,
      panel: [{ id: "a", provider: "openrouter", model: "m/a" }],
    })
    // Sanity: without env it stays disabled.
    delete process.env.CONSENSUS_ENABLED
    assert.equal(loadConsensusConfig(dir).enabled, false)

    process.env.CONSENSUS_ENABLED = "true"
    const cfg = loadConsensusConfig(dir)
    assert.equal(cfg.enabled, true, "env override forces enabled=true")
  } finally {
    if (prev === undefined) delete process.env.CONSENSUS_ENABLED
    else process.env.CONSENSUS_ENABLED = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test("validateForRun: error for disabled config", () => {
  const cfg = {
    ...DEFAULT_CONFIG,
    enabled: false,
    panel: [{ id: "a", provider: "openrouter", model: "m/a", main: true }],
  }
  const err = validateForRun(cfg)
  assert.ok(err, "should return an error string")
  assert.match(err, /disabled/i)
})

test("validateForRun: error for enabled + empty panel", () => {
  const cfg = { ...DEFAULT_CONFIG, enabled: true, panel: [] }
  const err = validateForRun(cfg)
  assert.ok(err, "should return an error string")
  assert.match(err, /empty/i)
})

test("validateForRun: error for unknown provider reference", () => {
  const cfg = {
    ...DEFAULT_CONFIG,
    enabled: true,
    panel: [{ id: "a", provider: "nope", model: "m/a", main: true }],
  }
  const err = validateForRun(cfg)
  assert.ok(err, "should return an error string")
  assert.match(err, /unknown provider/i)
})

test("validateForRun: null for a valid enabled config", () => {
  const cfg = {
    ...DEFAULT_CONFIG,
    enabled: true,
    panel: [{ id: "a", provider: "openrouter", model: "m/a", main: true }],
  }
  const err = validateForRun(cfg)
  assert.equal(err, null)
})

test("getMain returns the flagged main member", () => {
  const cfg = {
    ...DEFAULT_CONFIG,
    enabled: true,
    panel: [
      { id: "a", provider: "openrouter", model: "m/a" },
      { id: "b", provider: "openrouter", model: "m/b", main: true },
    ],
  }
  const main = getMain(cfg)
  assert.equal(main.id, "b")
})
