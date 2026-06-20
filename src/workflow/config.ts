/**
 * Configuration loading for the workflow engine.
 *
 * Pure logic only — no `@opencode-ai/plugin` import. Reads the optional
 * `"workflow"` block from `continuous-code.config.jsonc` in the project
 * directory, merging over DEFAULT_WORKFLOW_CONFIG. Honors the
 * OPENCODE_CONTINUOUS_WORKFLOW env override ("0"/"false" disables,
 * "1"/"true" enables). Never throws: a missing or malformed config file
 * always falls back to DEFAULT_WORKFLOW_CONFIG.
 *
 * The `stripJsonc` and `parseBoolEnv` helpers are copied verbatim from
 * src/watchdog/config.ts — intentionally kept in sync rather than shared so
 * this module stays dependency-free.
 */
import { readFileSync, existsSync } from "fs"
import { join } from "path"

export interface WorkflowConfig {
  /** Master on/off switch. ON BY DEFAULT. */
  enabled: boolean
  /** Whether to start the local Bun.serve dashboard. ON BY DEFAULT. */
  dashboardEnabled: boolean
  /** TCP port for the workflow web dashboard. */
  dashboardPort: number
  /**
   * Max concurrent agent sessions the engine may run at once.
   * 0 = auto: min(16, max(2, cpuCores - 2)).
   */
  concurrency: number
  /** Whether to run the drift-watcher round-robin loop. ON BY DEFAULT. */
  driftEnabled: boolean
  /** How often the drift-watcher sweeps active children (ms). */
  driftIntervalMs: number
  /**
   * Hard cap (chars/4 token estimate) on the input the drift-watcher may
   * receive per sweep. Enforced host-side by trimming before sending.
   * Absolute ceiling is 40_000: user config may only lower this value, never
   * raise it above 40_000 (clamped on merge).
   */
  driftCapTokens: number
  /**
   * Per-agent context injection budget (chars/4 token estimate). Artifact
   * summaries are trimmed oldest-first (non-@full) when this ceiling is hit.
   */
  perAgentContextCapTokens: number
  /** Hard ceiling on the total number of agent sessions per workflow run. */
  maxAgents: number
  /**
   * If true, on workflow.done the synthesized result is stored as a
   * WORKING_SOLUTION learning via the memory backend. OFF BY DEFAULT.
   */
  storeLearnings: boolean
}

export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  enabled: true,
  dashboardEnabled: true,
  dashboardPort: 7878,
  concurrency: 0,
  driftEnabled: true,
  driftIntervalMs: 90_000,
  driftCapTokens: 40_000,
  perAgentContextCapTokens: 60_000,
  maxAgents: 1_000,
  storeLearnings: false,
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

/** Shape of the optional "workflow" block in the config file. */
interface RawWorkflowBlock {
  enabled?: unknown
  dashboardEnabled?: unknown
  dashboardPort?: unknown
  concurrency?: unknown
  driftEnabled?: unknown
  driftIntervalMs?: unknown
  driftCapTokens?: unknown
  perAgentContextCapTokens?: unknown
  maxAgents?: unknown
  storeLearnings?: unknown
}

/**
 * Load workflow config from `<directory>/continuous-code.config.jsonc` (if
 * present). Reads the optional `"workflow"` block, merging over
 * DEFAULT_WORKFLOW_CONFIG. Honors the OPENCODE_CONTINUOUS_WORKFLOW env
 * override ("0"/"false" disables, "1"/"true" enables). Robust to a
 * missing/malformed file — never throws.
 */
export function loadWorkflowConfig(directory: string): WorkflowConfig {
  const merged: WorkflowConfig = { ...DEFAULT_WORKFLOW_CONFIG }

  const configPath = join(directory, "continuous-code.config.jsonc")
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8")
      const parsed = JSON.parse(stripJsonc(raw)) as {
        workflow?: RawWorkflowBlock
      }
      const block = parsed.workflow
      if (block && typeof block === "object") {
        if (typeof block.enabled === "boolean") {
          merged.enabled = block.enabled
        }
        if (typeof block.dashboardEnabled === "boolean") {
          merged.dashboardEnabled = block.dashboardEnabled
        }
        if (
          typeof block.dashboardPort === "number" &&
          block.dashboardPort > 0 &&
          block.dashboardPort <= 65535
        ) {
          merged.dashboardPort = Math.floor(block.dashboardPort)
        }
        if (
          typeof block.concurrency === "number" &&
          block.concurrency >= 0
        ) {
          merged.concurrency = Math.floor(block.concurrency)
        }
        if (typeof block.driftEnabled === "boolean") {
          merged.driftEnabled = block.driftEnabled
        }
        if (
          typeof block.driftIntervalMs === "number" &&
          block.driftIntervalMs > 0
        ) {
          merged.driftIntervalMs = block.driftIntervalMs
        }
        if (
          typeof block.driftCapTokens === "number" &&
          block.driftCapTokens > 0
        ) {
          // Hard ceiling is 40k (see WorkflowConfig.driftCapTokens doc); the
          // config-file knob can only ever LOWER the cap below 40k, never
          // raise it above.
          merged.driftCapTokens = Math.min(40_000, Math.floor(block.driftCapTokens))
        }
        if (
          typeof block.perAgentContextCapTokens === "number" &&
          block.perAgentContextCapTokens > 0
        ) {
          merged.perAgentContextCapTokens = Math.floor(
            block.perAgentContextCapTokens,
          )
        }
        if (
          typeof block.maxAgents === "number" &&
          block.maxAgents > 0
        ) {
          merged.maxAgents = Math.floor(block.maxAgents)
        }
        if (typeof block.storeLearnings === "boolean") {
          merged.storeLearnings = block.storeLearnings
        }
      }
    } catch {
      // Malformed config: fall back to defaults silently.
      return { ...DEFAULT_WORKFLOW_CONFIG }
    }
  }

  // Env override of the enabled flag (highest precedence).
  const envEnabled = parseBoolEnv(
    process.env.OPENCODE_CONTINUOUS_WORKFLOW,
  )
  if (envEnabled !== undefined) merged.enabled = envEnabled

  return merged
}
