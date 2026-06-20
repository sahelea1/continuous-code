/**
 * Configuration loading & validation for the Multi-Model Consensus feature.
 *
 * Pure logic only — no `@opencode-ai/plugin` import.
 */
import { readFileSync, writeFileSync, existsSync } from "fs"
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

/**
 * Persist the consensus config to `<directory>/consensus.json`.
 * Writes only the persistable fields, pretty-printed (2-space) + trailing
 * newline. All programmatic writers share this single serializer so the file
 * is never hand-edited.
 */
export function saveConsensusConfig(
  directory: string,
  config: ConsensusConfig,
): void {
  const persistable = {
    enabled: config.enabled,
    synthesis: config.synthesis,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    agreementThreshold: config.agreementThreshold,
    timeoutMs: config.timeoutMs,
    requireParameters: config.requireParameters,
    providers: config.providers,
    panel: config.panel,
  }
  const configPath = join(directory, "consensus.json")
  writeFileSync(configPath, JSON.stringify(persistable, null, 2) + "\n", "utf-8")
}

/**
 * Derive a stable short id from a model slug: the last `/`-segment,
 * lowercased, with non-alphanumerics collapsed to `-`.
 */
export function deriveId(slug: string): string {
  const last = slug.split("/").pop() ?? slug
  return last.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

/** Shallow-clone a config so pure helpers never mutate their input. */
function cloneConfig(config: ConsensusConfig): ConsensusConfig {
  return {
    ...config,
    panel: config.panel.map((m) => ({ ...m })),
    providers: { ...config.providers },
  }
}

/**
 * Add or update a panel member (matched by `id`). Returns a new config.
 * - If `member.id` is empty, derive it from `member.model`; on collision with
 *   a DIFFERENT model slug, suffix `-2`, `-3`, …
 * - If the resulting member is the only one, it becomes `main`.
 * - The panel is normalized so at most one member is `main`.
 */
export function upsertPanelMember(
  config: ConsensusConfig,
  member: PanelMember,
): ConsensusConfig {
  const next = cloneConfig(config)
  const incoming: PanelMember = { ...member }

  if (!incoming.id || incoming.id.trim().length === 0) {
    const base = deriveId(incoming.model)
    let candidate = base || "model"
    let n = 1
    // Bump suffix while the id is taken by a member with a DIFFERENT model.
    while (
      next.panel.some(
        (m) => m.id === candidate && m.model !== incoming.model,
      )
    ) {
      n += 1
      candidate = `${base || "model"}-${n}`
    }
    incoming.id = candidate
  }

  const idx = next.panel.findIndex((m) => m.id === incoming.id)
  if (idx >= 0) {
    next.panel[idx] = { ...next.panel[idx], ...incoming }
  } else {
    next.panel.push(incoming)
  }

  if (next.panel.length === 1) {
    next.panel[0] = { ...next.panel[0], main: true }
  }

  next.panel = normalizePanel(next.panel)
  return next
}

/**
 * Remove a panel member by id or model slug. Returns a new config.
 * If the removed member was `main` and the panel is still non-empty, the first
 * remaining member is promoted to `main`.
 */
export function removePanelMember(
  config: ConsensusConfig,
  idOrModel: string,
): ConsensusConfig {
  const next = cloneConfig(config)
  const removed = next.panel.find(
    (m) => m.id === idOrModel || m.model === idOrModel,
  )
  next.panel = next.panel.filter(
    (m) => !(m.id === idOrModel || m.model === idOrModel),
  )
  if (removed?.main && next.panel.length > 0) {
    next.panel = next.panel.map((m, i) => ({ ...m, main: i === 0 }))
  }
  next.panel = normalizePanel(next.panel)
  return next
}

/**
 * Set the `main` flag on the member matching `id` and unset all others.
 * Throws if `id` is not found. Returns a new config.
 */
export function setMainMember(
  config: ConsensusConfig,
  id: string,
): ConsensusConfig {
  const next = cloneConfig(config)
  if (!next.panel.some((m) => m.id === id)) {
    throw new Error(`No panel member with id '${id}'.`)
  }
  next.panel = next.panel.map((m) => ({ ...m, main: m.id === id }))
  return next
}

/**
 * Set the global temperature (0–2). Returns a new config.
 * Throws if the value is out of range.
 */
export function setTemperature(
  config: ConsensusConfig,
  temperature: number,
): ConsensusConfig {
  if (typeof temperature !== "number" || temperature < 0 || temperature > 2) {
    throw new Error(`Temperature must be a number in [0, 2]; got ${temperature}.`)
  }
  return { ...cloneConfig(config), temperature }
}

/**
 * Set the global maxTokens (positive integer). Returns a new config.
 * Throws if the value is not a positive integer.
 */
export function setMaxTokens(
  config: ConsensusConfig,
  maxTokens: number,
): ConsensusConfig {
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new Error(`maxTokens must be a positive integer; got ${maxTokens}.`)
  }
  return { ...cloneConfig(config), maxTokens }
}

/**
 * Set the agreement threshold (0–1). Returns a new config.
 * Throws if the value is out of range.
 */
export function setAgreementThreshold(
  config: ConsensusConfig,
  agreementThreshold: number,
): ConsensusConfig {
  if (
    typeof agreementThreshold !== "number" ||
    agreementThreshold < 0 ||
    agreementThreshold > 1
  ) {
    throw new Error(
      `agreementThreshold must be a number in [0, 1]; got ${agreementThreshold}.`,
    )
  }
  return { ...cloneConfig(config), agreementThreshold }
}

/**
 * Set the timeout in milliseconds (positive integer). Returns a new config.
 * Throws if the value is not a positive integer.
 */
export function setTimeoutMs(
  config: ConsensusConfig,
  timeoutMs: number,
): ConsensusConfig {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`timeoutMs must be a positive integer; got ${timeoutMs}.`)
  }
  return { ...cloneConfig(config), timeoutMs }
}

/**
 * Set the requireParameters flag. Returns a new config.
 */
export function setRequireParameters(
  config: ConsensusConfig,
  requireParameters: boolean,
): ConsensusConfig {
  return { ...cloneConfig(config), requireParameters }
}

/**
 * Add or update a custom provider entry (matched by `key`). Returns a new config.
 * Both `baseURL` and `apiKeyEnv` are optional on update (existing values kept if omitted).
 * `baseURL` is required when adding a new provider.
 */
export function upsertProvider(
  config: ConsensusConfig,
  key: string,
  update: { baseURL?: string; apiKeyEnv?: string },
): ConsensusConfig {
  if (!key || key.trim().length === 0) {
    throw new Error("Provider key must be a non-empty string.")
  }
  const next = cloneConfig(config)
  const existing = next.providers[key]
  if (!existing && !update.baseURL) {
    throw new Error(`Provider '${key}' is new — a baseURL is required.`)
  }
  next.providers[key] = {
    baseURL: update.baseURL ?? existing.baseURL,
    apiKeyEnv: update.apiKeyEnv ?? existing?.apiKeyEnv,
  }
  return next
}
