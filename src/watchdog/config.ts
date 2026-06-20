/**
 * Configuration loading for the automatic subagent-watchdog feature.
 *
 * Pure logic only — no `@opencode-ai/plugin` import (mirrors
 * `src/consensus/config.ts`). Never throws: a missing or malformed config
 * file always falls back to DEFAULT_CONFIG.
 */
import { readFileSync, existsSync } from "fs"
import { join } from "path"

export interface WatchdogConfig {
  /** Master on/off switch. ON BY DEFAULT. */
  enabled: boolean
  /** Recurring timer interval in ms (fixed, NOT escalating). */
  intervalMs: number
  /** Debounce window before disarming on an all-idle reconcile. */
  idleGraceMs: number
  /** Hard cap on consecutive wake nudges per orchestrator (loop guard). */
  maxWakes: number
  /** Lighter poll cadence to catch dropped idle events. */
  pollFallbackMs: number
}

export const DEFAULT_CONFIG: WatchdogConfig = {
  enabled: true,
  intervalMs: 1_200_000 /* 20m */,
  idleGraceMs: 30_000,
  maxWakes: 6,
  pollFallbackMs: 60_000,
}

/** Interpret a truthy/falsy env string. Returns undefined if unrecognized. */
function parseBoolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  const v = value.trim().toLowerCase()
  if (v === "1" || v === "true" || v === "yes") return true
  if (v === "0" || v === "false" || v === "no") return false
  return undefined
}

/**
 * Strip `//` line comments and block comments, plus trailing commas, so a
 * tolerant JSONC file can be fed to JSON.parse. Minimal and dependency-free.
 * Skips comment-like sequences inside string literals.
 */
function stripJsonc(text: string): string {
  let out = ""
  let inString = false
  let stringQuote = ""
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]

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
        // Preserve escaped character verbatim.
        if (i + 1 < text.length) {
          out += text[i + 1]
          i++
        }
      } else if (ch === stringQuote) {
        inString = false
      }
      continue
    }

    // Not in a string or comment.
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

  // Remove trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, "$1")
}

/** Shape of the optional "watchdog" block in the config file. */
interface RawWatchdogBlock {
  enabled?: unknown
  intervalMs?: unknown
  intervalMinutes?: unknown
  idleGraceMs?: unknown
  maxWakes?: unknown
  pollFallbackMs?: unknown
}

/**
 * Load watchdog config from `<directory>/continuous-code.config.jsonc` (if
 * present). Reads the optional `"watchdog"` block, merging over DEFAULT_CONFIG.
 * Accepts `intervalMinutes` (converted to ms). Honors the
 * OPENCODE_CONTINUOUS_WATCHDOG env override ("0"/"false" disables,
 * "1"/"true" enables). Robust to a missing/malformed file — never throws.
 */
export function loadWatchdogConfig(directory: string): WatchdogConfig {
  const merged: WatchdogConfig = { ...DEFAULT_CONFIG }

  const configPath = join(directory, "continuous-code.config.jsonc")
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8")
      const parsed = JSON.parse(stripJsonc(raw)) as {
        watchdog?: RawWatchdogBlock
      }
      const block = parsed.watchdog
      if (block && typeof block === "object") {
        if (typeof block.enabled === "boolean") merged.enabled = block.enabled
        if (typeof block.intervalMs === "number" && block.intervalMs > 0) {
          merged.intervalMs = block.intervalMs
        }
        if (
          typeof block.intervalMinutes === "number" &&
          block.intervalMinutes > 0
        ) {
          // intervalMinutes wins when present (the documented knob).
          merged.intervalMs = Math.round(block.intervalMinutes * 60_000)
        }
        if (typeof block.idleGraceMs === "number" && block.idleGraceMs >= 0) {
          merged.idleGraceMs = block.idleGraceMs
        }
        if (typeof block.maxWakes === "number" && block.maxWakes >= 0) {
          merged.maxWakes = Math.floor(block.maxWakes)
        }
        if (
          typeof block.pollFallbackMs === "number" &&
          block.pollFallbackMs > 0
        ) {
          merged.pollFallbackMs = block.pollFallbackMs
        }
      }
    } catch {
      // Malformed config: fall back to defaults silently.
      return { ...DEFAULT_CONFIG }
    }
  }

  // Env override of the enabled flag (highest precedence).
  const envEnabled = parseBoolEnv(process.env.OPENCODE_CONTINUOUS_WATCHDOG)
  if (envEnabled !== undefined) merged.enabled = envEnabled

  return merged
}
