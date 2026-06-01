/**
 * Configuration loading & validation for the Multi-Model Consensus feature.
 *
 * Pure logic only — no `@opencode-ai/plugin` import.
 */
import { readFileSync, existsSync } from "fs"
import { join } from "path"
import type {
  ConsensusConfig,
  PanelMember,
  ProviderConfig,
} from "./types.js"

export const DEFAULT_CONFIG: ConsensusConfig = {
  enabled: false,
  panel: [],
  synthesis: "main-judge",
  maxTokens: 1024,
  temperature: 0.3,
  agreementThreshold: 0.6,
  timeoutMs: 60000,
  requireParameters: false,
  providers: {
    openrouter: {
      baseURL: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
    },
    "ollama-cloud": {
      baseURL: "https://ollama.com/v1",
      apiKeyEnv: "OLLAMA_API_KEY",
    },
  },
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
 * Ensure exactly one panel member is flagged `main`.
 * - If none are flagged, mark the first member main.
 * - If multiple are flagged, keep the first main and unset the rest.
 */
function normalizePanel(panel: PanelMember[]): PanelMember[] {
  if (panel.length === 0) return panel
  let seenMain = false
  const normalized = panel.map((m) => {
    if (m.main) {
      if (!seenMain) {
        seenMain = true
        return { ...m, main: true }
      }
      return { ...m, main: false }
    }
    return { ...m, main: false }
  })
  if (!seenMain) {
    normalized[0] = { ...normalized[0], main: true }
  }
  return normalized
}

/**
 * Load consensus config from `<directory>/consensus.json` (if present),
 * deep-merging over DEFAULT_CONFIG. Never throws for disabled / empty panel.
 */
export function loadConsensusConfig(directory: string): ConsensusConfig {
  const merged: ConsensusConfig = {
    ...DEFAULT_CONFIG,
    panel: [...DEFAULT_CONFIG.panel],
    providers: { ...DEFAULT_CONFIG.providers },
  }

  const configPath = join(directory, "consensus.json")
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<ConsensusConfig>

      if (typeof raw.enabled === "boolean") merged.enabled = raw.enabled
      if (raw.synthesis === "main-judge" || raw.synthesis === "fusion") {
        merged.synthesis = raw.synthesis
      }
      if (typeof raw.maxTokens === "number") merged.maxTokens = raw.maxTokens
      if (typeof raw.temperature === "number") merged.temperature = raw.temperature
      if (typeof raw.agreementThreshold === "number") {
        merged.agreementThreshold = raw.agreementThreshold
      }
      if (typeof raw.timeoutMs === "number") merged.timeoutMs = raw.timeoutMs
      if (typeof raw.requireParameters === "boolean") {
        merged.requireParameters = raw.requireParameters
      }
      if (Array.isArray(raw.panel)) merged.panel = raw.panel as PanelMember[]

      // User providers merge with (and override) default providers.
      if (raw.providers && typeof raw.providers === "object") {
        merged.providers = {
          ...DEFAULT_CONFIG.providers,
          ...(raw.providers as Record<string, ProviderConfig>),
        }
      }
    } catch {
      // Malformed config: fall back to defaults silently.
    }
  }

  // Env override of enabled flag.
  const envEnabled = parseBoolEnv(process.env.CONSENSUS_ENABLED)
  if (envEnabled !== undefined) merged.enabled = envEnabled

  merged.panel = normalizePanel(merged.panel)
  return merged
}

/**
 * Validate config for an actual deliberation run.
 * Returns an error string if invalid, else null.
 */
export function validateForRun(config: ConsensusConfig): string | null {
  if (!config.enabled) return "Consensus mode is disabled."
  if (!config.panel || config.panel.length === 0) {
    return "Consensus panel is empty — add at least one model to consensus.json."
  }
  const mains = config.panel.filter((m) => m.main)
  if (mains.length !== 1) {
    return "Consensus panel must have exactly one 'main' model."
  }
  for (const member of config.panel) {
    if (!config.providers[member.provider]) {
      return `Panel member '${member.id}' references unknown provider '${member.provider}'.`
    }
  }
  return null
}

/** Read the API key for a provider from its configured env var. */
export function resolveApiKey(provider: ProviderConfig): string | undefined {
  if (!provider.apiKeyEnv) return undefined
  return process.env[provider.apiKeyEnv]
}

/** Get the main (dominant) panel member. Assumes config was normalized. */
export function getMain(config: ConsensusConfig): PanelMember {
  const main = config.panel.find((m) => m.main)
  if (main) return main
  if (config.panel.length > 0) return config.panel[0]
  throw new Error("Consensus panel is empty — no main model available.")
}
