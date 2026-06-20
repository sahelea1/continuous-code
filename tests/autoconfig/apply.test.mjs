/**
 * Pure unit tests for the autoconfig apply logic (NO network, NO plugin import).
 *
 * Run with:  node --test tests/autoconfig/
 *
 * These tests import the compiled pure-logic module from dist/, so run
 * `npx tsc` first (the consensus tests follow the same convention).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  applyAssignments,
  stripJsonComments,
  effortToVariant,
} from "../../dist/autoconfig/core.js"

/** Create a fresh temp dir for fixtures (in OS temp, never in the repo). */
function freshDir() {
  return mkdtempSync(join(tmpdir(), "autoconfig-"))
}

test("applyAssignments updates an existing agent model and variant, preserves other keys, makes a .bak", () => {
  const dir = freshDir()
  try {
    const configPath = join(dir, "opencode.json")
    const original = {
      $schema: "https://opencode.ai/config.json",
      default_agent: "build",
      model: "ollama-cloud/deepseek-v4-pro",
      agent: {
        build: {
          model: "ollama-cloud/deepseek-v4-pro",
          description: "Primary orchestrator",
          permission: { task: "allow" },
        },
        scout: { model: "ollama-cloud/deepseek-v4-flash" },
      },
      plugin: ["opencode-continuous"],
    }
    writeFileSync(configPath, JSON.stringify(original, null, 2), "utf-8")

    const result = applyAssignments({
      assignments: {
        scout: { model: "anthropic/claude-haiku-4-6", effort: "low" },
      },
      configPath,
    })

    assert.equal(result.ok, true, "apply should succeed")
    assert.equal(result.configPath, configPath, "reports the path it wrote")

    // .bak backup created
    assert.ok(existsSync(configPath + ".bak"), ".bak backup should exist")

    const written = JSON.parse(readFileSync(configPath, "utf-8"))

    // scout.model changed
    assert.equal(written.agent.scout.model, "anthropic/claude-haiku-4-6")
    // effort=low -> variant=low
    assert.equal(written.agent.scout.variant, "low")

    // Other keys preserved untouched.
    assert.equal(written.$schema, "https://opencode.ai/config.json")
    assert.equal(written.default_agent, "build")
    assert.equal(written.model, "ollama-cloud/deepseek-v4-pro")
    assert.deepEqual(written.plugin, ["opencode-continuous"])
    // build agent and its nested keys untouched.
    assert.equal(written.agent.build.model, "ollama-cloud/deepseek-v4-pro")
    assert.equal(written.agent.build.description, "Primary orchestrator")
    assert.deepEqual(written.agent.build.permission, { task: "allow" })

    // A change record is reported for scout.
    const scoutChange = result.changes.find((c) => c.agent === "scout")
    assert.ok(scoutChange, "a change for scout is reported")
    assert.equal(scoutChange.oldModel, "ollama-cloud/deepseek-v4-flash")
    assert.equal(scoutChange.newModel, "anthropic/claude-haiku-4-6")
    assert.equal(scoutChange.newVariant, "low")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("applyAssignments creates a missing agent entry", () => {
  const dir = freshDir()
  try {
    const configPath = join(dir, "opencode.json")
    writeFileSync(
      configPath,
      JSON.stringify({ agent: { build: { model: "x/y" } } }, null, 2),
      "utf-8",
    )

    const result = applyAssignments({
      assignments: {
        oracle: { model: "anthropic/claude-sonnet-4-6", effort: "high" },
      },
      configPath,
    })

    assert.equal(result.ok, true)
    const written = JSON.parse(readFileSync(configPath, "utf-8"))
    assert.ok(written.agent.oracle, "oracle entry created")
    assert.equal(written.agent.oracle.model, "anthropic/claude-sonnet-4-6")
    assert.equal(written.agent.oracle.variant, "high")
    // existing build untouched
    assert.equal(written.agent.build.model, "x/y")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("applyAssignments tolerates JSONC (comments) input", () => {
  const dir = freshDir()
  try {
    const configPath = join(dir, "opencode.jsonc")
    const jsonc = `{
  // top-level comment
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "scout": { "model": "anthropic/claude-haiku-4-6" } // trailing comment
  }
}`
    writeFileSync(configPath, jsonc, "utf-8")

    const result = applyAssignments({
      assignments: {
        scout: { model: "anthropic/claude-sonnet-4-6", effort: "medium" },
      },
      configPath,
    })

    assert.equal(result.ok, true)
    const written = JSON.parse(readFileSync(configPath, "utf-8"))
    assert.equal(written.agent.scout.model, "anthropic/claude-sonnet-4-6")
    assert.equal(written.agent.scout.variant, "medium")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("applyAssignments returns an error (no write) when target config is unparseable", () => {
  const dir = freshDir()
  try {
    const configPath = join(dir, "opencode.json")
    // Truly broken JSON that comment-stripping cannot rescue.
    writeFileSync(configPath, '{ "agent": { "scout": ', "utf-8")
    const before = readFileSync(configPath, "utf-8")

    const result = applyAssignments({
      assignments: { scout: { model: "anthropic/claude-haiku-4-6" } },
      configPath,
    })

    assert.equal(result.ok, false, "should fail on unparseable input")
    assert.ok(result.error, "an error message is returned")
    // File untouched, no backup written.
    assert.equal(readFileSync(configPath, "utf-8"), before, "file not modified")
    assert.equal(existsSync(configPath + ".bak"), false, "no .bak on failure")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FIX 2: a second applyAssignments run preserves the ORIGINAL .bak", () => {
  const dir = freshDir()
  try {
    const configPath = join(dir, "opencode.json")
    const original = {
      $schema: "https://opencode.ai/config.json",
      agent: {
        scout: { model: "anthropic/claude-haiku-4-6" },
      },
    }
    const originalText = JSON.stringify(original, null, 2)
    writeFileSync(configPath, originalText, "utf-8")

    // First run: should create the pristine .bak from the original.
    const first = applyAssignments({
      assignments: { scout: { model: "anthropic/claude-sonnet-4-6" } },
      configPath,
    })
    assert.equal(first.ok, true)
    assert.ok(existsSync(configPath + ".bak"), ".bak created on first run")
    const bakAfterFirst = readFileSync(configPath + ".bak", "utf-8")
    assert.equal(bakAfterFirst, originalText, ".bak holds the pristine original")

    // Confirm the live config was modified (so a naive re-run would clobber).
    const afterFirst = readFileSync(configPath, "utf-8")
    assert.notEqual(afterFirst, originalText, "live config changed after run 1")

    // Second run: must NOT overwrite the pristine .bak with the modified config.
    const second = applyAssignments({
      assignments: { scout: { model: "anthropic/claude-opus-4-8" } },
      configPath,
    })
    assert.equal(second.ok, true)
    const bakAfterSecond = readFileSync(configPath + ".bak", "utf-8")
    assert.equal(
      bakAfterSecond,
      originalText,
      ".bak still holds the pristine original after second run",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FIX 3: assigning a model under an UNKNOWN provider errors and writes nothing", () => {
  const dir = freshDir()
  try {
    const configPath = join(dir, "opencode.json")
    const original = {
      $schema: "https://opencode.ai/config.json",
      agent: { scout: { model: "anthropic/claude-haiku-4-6" } },
    }
    const originalText = JSON.stringify(original, null, 2)
    writeFileSync(configPath, originalText, "utf-8")

    const result = applyAssignments({
      assignments: {
        scout: { model: "totally-made-up-provider/some-model", effort: "high" },
      },
      configPath,
    })

    assert.equal(result.ok, false, "unknown provider should reject the apply")
    assert.ok(result.error, "an error message is returned")
    assert.ok(
      Array.isArray(result.invalidAssignments),
      "offending pairs are reported",
    )
    assert.equal(result.invalidAssignments[0].agent, "scout")
    assert.equal(
      result.invalidAssignments[0].provider,
      "totally-made-up-provider",
    )
    assert.ok(
      Array.isArray(result.validProviders) && result.validProviders.length > 0,
      "valid provider ids are listed",
    )
    // anthropic is a known fallback provider and should appear as valid.
    assert.ok(result.validProviders.includes("anthropic"))

    // File untouched, no backup written.
    assert.equal(readFileSync(configPath, "utf-8"), originalText, "file untouched")
    assert.equal(existsSync(configPath + ".bak"), false, "no .bak on rejection")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FIX 4: effort on a known NON-reasoning model does not write a variant", () => {
  const dir = freshDir()
  try {
    const configPath = join(dir, "opencode.json")
    const original = {
      $schema: "https://opencode.ai/config.json",
      agent: { scout: { model: "ollama-cloud/deepseek-v4-pro" } },
    }
    writeFileSync(configPath, JSON.stringify(original, null, 2), "utf-8")

    // deepseek-v4-flash is marked non-reasoning (variants: []) in the fallback map.
    const result = applyAssignments({
      assignments: {
        scout: { model: "ollama-cloud/deepseek-v4-flash", effort: "high" },
      },
      configPath,
    })

    assert.equal(result.ok, true, "apply still succeeds")
    const written = JSON.parse(readFileSync(configPath, "utf-8"))
    assert.equal(written.agent.scout.model, "ollama-cloud/deepseek-v4-flash")
    assert.equal(
      written.agent.scout.variant,
      undefined,
      "no variant written for a non-reasoning model",
    )
    // A non-fatal warning explains the ignored effort.
    assert.ok(
      Array.isArray(result.warnings) && result.warnings.length > 0,
      "a warning is surfaced",
    )
    assert.ok(
      result.warnings.some((w) => w.includes("not reasoning-capable")),
      "warning mentions the model is not reasoning-capable",
    )
    // The change record reflects no new variant.
    const change = result.changes.find((c) => c.agent === "scout")
    assert.ok(change)
    assert.equal(change.newVariant, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FIX 4: effort on a known reasoning model still writes a variant", () => {
  const dir = freshDir()
  try {
    const configPath = join(dir, "opencode.json")
    writeFileSync(
      configPath,
      JSON.stringify({ agent: {} }, null, 2),
      "utf-8",
    )

    const result = applyAssignments({
      assignments: {
        scout: { model: "ollama-cloud/deepseek-v4-pro", effort: "high" },
      },
      configPath,
    })

    assert.equal(result.ok, true)
    const written = JSON.parse(readFileSync(configPath, "utf-8"))
    assert.equal(
      written.agent.scout.variant,
      "high",
      "reasoning model keeps its variant",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("effortToVariant maps efforts to variant strings (xhigh -> max)", () => {
  assert.equal(effortToVariant("low"), "low")
  assert.equal(effortToVariant("medium"), "medium")
  assert.equal(effortToVariant("high"), "high")
  assert.equal(effortToVariant("max"), "max")
  // opencode variant vocabulary tops out at "max"; xhigh maps to max.
  assert.equal(effortToVariant("xhigh"), "max")
})

test("stripJsonComments removes // and block comments but keeps strings with slashes", () => {
  const input = `{
  // line comment
  "url": "https://example.com", /* block */
  "path": "a//b"
}`
  const cleaned = stripJsonComments(input)
  const obj = JSON.parse(cleaned)
  assert.equal(obj.url, "https://example.com")
  assert.equal(obj.path, "a//b")
})
