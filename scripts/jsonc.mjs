#!/usr/bin/env node
// scripts/jsonc.mjs — committed JSONC reader for install.sh (replaces jq).
//
// Reads a JSONC file (// and /* */ comments + trailing commas allowed) and
// prints the value at a dot-path. Scalars print verbatim; objects/arrays print
// as JSON. Missing values print the supplied default (empty string if none).
//
// Usage:
//   node scripts/jsonc.mjs <file> <dot.path> [default]
//
// Examples:
//   node scripts/jsonc.mjs continuous-code.config.jsonc memory.mode sqlite
//   node scripts/jsonc.mjs continuous-code.config.jsonc components.agents true
//   node scripts/jsonc.mjs continuous-code.config.jsonc extras.mcpServers '{}'
//
// Mirrors src/autoconfig/core.ts:stripJsonComments so behavior stays identical.

import { readFileSync, existsSync } from "node:fs"

/** Strip // line comments and block comments, preserving string contents. */
function stripJsonComments(input) {
  let out = ""
  let inString = false
  let stringQuote = ""
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    const next = input[i + 1]

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false
        out += ch
      }
      continue
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false
        i++
      }
      continue
    }

    if (inString) {
      out += ch
      if (ch === "\\") {
        out += next ?? ""
        i++
        continue
      }
      if (ch === stringQuote) {
        inString = false
      }
      continue
    }

    if (ch === '"' || ch === "'") {
      inString = true
      stringQuote = ch
      out += ch
      continue
    }
    if (ch === "/" && next === "/") {
      inLineComment = true
      i++
      continue
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true
      i++
      continue
    }
    out += ch
  }

  return out
}

/** Remove trailing commas that are legal in JSONC but not JSON. */
function stripTrailingCommas(input) {
  return input.replace(/,(\s*[}\]])/g, "$1")
}

/** Parse JSON or JSONC, returning null on failure. */
function parseJsonc(text) {
  try {
    return JSON.parse(text)
  } catch {
    // fall through to lenient parse
  }
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(text)))
  } catch {
    return null
  }
}

function main() {
  const [, , file, path, def = ""] = process.argv
  if (!file || path == null) {
    process.stderr.write("usage: node scripts/jsonc.mjs <file> <dot.path> [default]\n")
    process.exit(1)
  }

  let obj = {}
  if (existsSync(file)) {
    const parsed = parseJsonc(readFileSync(file, "utf8"))
    if (parsed && typeof parsed === "object") obj = parsed
  }

  const value = path
    .split(".")
    .reduce((acc, key) => (acc == null ? acc : acc[key]), obj)

  if (value == null) {
    process.stdout.write(def)
    return
  }
  if (typeof value === "object") {
    process.stdout.write(JSON.stringify(value))
    return
  }
  process.stdout.write(String(value))
}

main()
