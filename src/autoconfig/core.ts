/**
 * Pure logic for the /autoconfagent feature: provider/model inspection and
 * safe writing of per-agent model + reasoning-effort choices into the host's
 * opencode.json.
 *
 * IMPORTANT: This module MUST NOT import `@opencode-ai/plugin`. Like
 * `src/consensus/*`, it is intended to be unit-testable standalone using only
 * `fs`, `path`, `os`, and (optionally) `child_process`. The tool wrappers in
 * `src/tools/autoconfig.ts` call into this module.
 *
 * Effort model: OpenCode expresses per-agent reasoning effort through the
 * AgentConfig `variant` field (https://opencode.ai/config.json). Reasoning
 * capable models declare `variants: { low, medium, high, max }` on the
 * provider. There is NO separate `reasoningEffort`/`effort` field, so we map a
 * human "effort" onto the `variant` string. "xhigh" (no native variant) is
 * clamped to "max".
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
} from "fs"
import { join } from "path"
import { homedir } from "os"
import { execFileSync } from "child_process"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Effort = "low" | "medium" | "high" | "max" | "xhigh"

export interface InspectedModel {
  id: string
  reasoning: boolean
  variants: string[]
}

export interface InspectedProvider {
  id: string
  /** Display name when known. */
  name?: string
  /** Whether this provider has stored credentials in auth.json. */
  authenticated: boolean
  /** Where this provider/model info came from. */
  source: string
  /** Optional OpenAI-compatible base URL when declared. */
  baseURL?: string
  models: InspectedModel[]
}

export interface CurrentAgent {
  model?: string
  variant?: string
}

export interface InspectResult {
  providers: InspectedProvider[]
  /** Resolved opencode.json that apply would target by default. */
  currentConfigPath: string | null
  /** Agent -> {model, variant} read from the resolved config. */
  currentAgents: Record<string, CurrentAgent>
  /** Non-fatal notes (e.g. "opencode models CLI unavailable"). */
  notes: string[]
}

export interface Assignment {
  model: string
  effort?: Effort
  variant?: string
}

export interface ApplyInput {
  assignments: Record<string, Assignment>
  configPath?: string
  /**
   * Working directory used for config-path resolution and provider/model
   * capability inspection. Must mirror the cwd passed to `inspect()` so apply
   * targets the SAME file inspect reported. Defaults to `process.cwd()`.
   */
  cwd?: string
}

export interface ChangeRecord {
  agent: string
  oldModel?: string
  newModel: string
  oldVariant?: string
  newVariant?: string
  created: boolean
}

export interface ApplyResult {
  ok: boolean
  configPath?: string
  backupPath?: string
  changes: ChangeRecord[]
  error?: string
  /** Non-fatal advisories (unknown model id, effort ignored for non-reasoning model). */
  warnings?: string[]
  /** When ok=false due to invalid providers, the offending agent->model pairs. */
  invalidAssignments?: Array<{ agent: string; model: string; provider: string }>
  /** When ok=false due to invalid providers, the list of valid provider ids. */
  validProviders?: string[]
}

// ---------------------------------------------------------------------------
// JSONC helpers
// ---------------------------------------------------------------------------

/**
 * Strip `//` line comments and block comments from a JSONC string while
 * preserving comment-like characters that appear inside string literals
 * (e.g. URLs such as "https://...").
 */
export function stripJsonComments(input: string): string {
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
        // Preserve escaped character verbatim.
        out += next ?? ""
        i++
        continue
      }
      if (ch === stringQuote) {
        inString = false
      }
      continue
    }

    // Not currently in a string or comment.
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
function stripTrailingCommas(input: string): string {
  return input.replace(/,(\s*[}\]])/g, "$1")
}

/** Parse a JSON or JSONC string, returning null on failure. */
export function parseJsonc(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    // Fall through to lenient parse.
  }
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(text)))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Effort <-> variant mapping
// ---------------------------------------------------------------------------

/**
 * Map a human "effort" onto OpenCode's AgentConfig `variant` vocabulary
 * (low | medium | high | max). "xhigh" has no native variant and is clamped
 * to "max" (the strongest available).
 */
export function effortToVariant(effort: Effort): string {
  switch (effort) {
    case "low":
      return "low"
    case "medium":
      return "medium"
    case "high":
      return "high"
    case "max":
    case "xhigh":
      return "max"
    default:
      return "medium"
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the opencode config file to read/write, in priority order:
 *   explicit configPath > $cwd/opencode.json > ~/.config/opencode/opencode.json
 *   > ~/.config/opencode/opencode.jsonc
 * Returns the first existing candidate, or (when none exist) the highest
 * priority writable default so apply can create it.
 */
export function resolveConfigPath(opts: {
  explicit?: string
  cwd?: string
  home?: string
}): { path: string | null; existed: boolean } {
  const home = opts.home ?? homedir()
  const cwd = opts.cwd ?? process.cwd()

  const candidates: string[] = []
  if (opts.explicit) candidates.push(opts.explicit)
  candidates.push(join(cwd, "opencode.json"))
  candidates.push(join(home, ".config", "opencode", "opencode.json"))
  candidates.push(join(home, ".config", "opencode", "opencode.jsonc"))

  for (const c of candidates) {
    if (existsSync(c)) return { path: c, existed: true }
  }
  // Nothing exists. If an explicit path was given, prefer that (apply will
  // create it); otherwise default to the project-local opencode.json.
  const fallback = opts.explicit ?? candidates[1] ?? null
  return { path: fallback, existed: false }
}

// ---------------------------------------------------------------------------
// auth.json
// ---------------------------------------------------------------------------

/**
 * Read authenticated provider IDs from ~/.local/share/opencode/auth.json.
 * Only the KEYS (provider ids) are returned — secret values are never read
 * out of this function.
 */
export function readAuthProviders(home: string = homedir()): string[] {
  const authPath = join(home, ".local", "share", "opencode", "auth.json")
  if (!existsSync(authPath)) return []
  const parsed = parseJsonc(readFileSync(authPath, "utf-8"))
  if (!parsed || typeof parsed !== "object") return []
  return Object.keys(parsed as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// Provider declarations from config files
// ---------------------------------------------------------------------------

interface DeclaredModel {
  reasoning: boolean
  variants: string[]
}

interface DeclaredProvider {
  name?: string
  baseURL?: string
  models: Record<string, DeclaredModel>
}

/** Extract a provider block from a parsed opencode config object. */
function extractProviders(
  configObj: unknown,
): Record<string, DeclaredProvider> {
  const result: Record<string, DeclaredProvider> = {}
  if (!configObj || typeof configObj !== "object") return result
  const provider = (configObj as Record<string, unknown>)["provider"]
  if (!provider || typeof provider !== "object") return result

  for (const [pid, pval] of Object.entries(
    provider as Record<string, unknown>,
  )) {
    if (!pval || typeof pval !== "object") continue
    const pobj = pval as Record<string, unknown>
    const declared: DeclaredProvider = { models: {} }

    if (typeof pobj["name"] === "string") declared.name = pobj["name"] as string
    const options = pobj["options"]
    if (options && typeof options === "object") {
      const base = (options as Record<string, unknown>)["baseURL"]
      if (typeof base === "string") declared.baseURL = base
    }

    const models = pobj["models"]
    if (models && typeof models === "object") {
      for (const [mid, mval] of Object.entries(
        models as Record<string, unknown>,
      )) {
        const mobj =
          mval && typeof mval === "object"
            ? (mval as Record<string, unknown>)
            : {}
        const reasoning = mobj["reasoning"] === true
        const variantsObj = mobj["variants"]
        const variants =
          variantsObj && typeof variantsObj === "object"
            ? Object.keys(variantsObj as Record<string, unknown>)
            : []
        declared.models[mid] = { reasoning, variants }
      }
    }
    result[pid] = declared
  }
  return result
}

/** Read agent -> {model, variant} from a parsed config object. */
export function extractCurrentAgents(
  configObj: unknown,
): Record<string, CurrentAgent> {
  const out: Record<string, CurrentAgent> = {}
  if (!configObj || typeof configObj !== "object") return out
  const agent = (configObj as Record<string, unknown>)["agent"]
  if (!agent || typeof agent !== "object") return out
  for (const [name, aval] of Object.entries(
    agent as Record<string, unknown>,
  )) {
    if (!aval || typeof aval !== "object") continue
    const aobj = aval as Record<string, unknown>
    const entry: CurrentAgent = {}
    if (typeof aobj["model"] === "string") entry.model = aobj["model"] as string
    if (typeof aobj["variant"] === "string")
      entry.variant = aobj["variant"] as string
    out[name] = entry
  }
  return out
}

// ---------------------------------------------------------------------------
// Built-in fallback provider map
// ---------------------------------------------------------------------------

/**
 * Well-known providers with representative current models so the LLM always
 * has sensible options even when CLI/config enumeration is thin. Reasoning
 * flags and variants reflect OpenCode's effort-via-variant model.
 */
const REASONING_VARIANTS = ["low", "medium", "high", "max"]

export const FALLBACK_PROVIDERS: Record<
  string,
  { name: string; baseURL?: string; models: InspectedModel[] }
> = {
  anthropic: {
    name: "Anthropic",
    models: [
      { id: "claude-opus-4-8", reasoning: true, variants: REASONING_VARIANTS },
      { id: "claude-sonnet-4-6", reasoning: true, variants: REASONING_VARIANTS },
      { id: "claude-haiku-4-6", reasoning: true, variants: REASONING_VARIANTS },
    ],
  },
  openai: {
    name: "OpenAI",
    models: [
      { id: "gpt-5.4", reasoning: true, variants: REASONING_VARIANTS },
      { id: "gpt-5.4-mini", reasoning: true, variants: REASONING_VARIANTS },
      { id: "o4", reasoning: true, variants: REASONING_VARIANTS },
    ],
  },
  google: {
    name: "Google",
    models: [
      { id: "gemini-3-pro", reasoning: true, variants: REASONING_VARIANTS },
      { id: "gemini-3-flash", reasoning: true, variants: REASONING_VARIANTS },
    ],
  },
  openrouter: {
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    models: [
      {
        id: "anthropic/claude-opus-4-8",
        reasoning: true,
        variants: REASONING_VARIANTS,
      },
      {
        id: "anthropic/claude-sonnet-4-6",
        reasoning: true,
        variants: REASONING_VARIANTS,
      },
      { id: "openai/gpt-5.4", reasoning: true, variants: REASONING_VARIANTS },
    ],
  },
  "ollama-cloud": {
    name: "Ollama Cloud",
    baseURL: "https://ollama.com/v1",
    models: [
      { id: "deepseek-v4-pro", reasoning: true, variants: REASONING_VARIANTS },
      {
        id: "deepseek-v4-flash",
        reasoning: false,
        variants: [],
      },
    ],
  },
  "zai-coding-plan": {
    name: "Z.AI Coding Plan",
    baseURL: "https://api.z.ai/api/coding/paas/v4",
    models: [
      { id: "glm-5.2", reasoning: true, variants: REASONING_VARIANTS },
      { id: "glm-5.1", reasoning: true, variants: REASONING_VARIANTS },
    ],
  },
}

// ---------------------------------------------------------------------------
// CLI enumeration (best-effort)
// ---------------------------------------------------------------------------

/**
 * Run `opencode models` to enumerate "provider/model" slugs. Returns a map of
 * provider id -> model ids. Best-effort: returns {} when the CLI is missing or
 * errors (callers add a note).
 */
export function enumerateModelsViaCli(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  let stdout = ""
  try {
    stdout = execFileSync("opencode", ["models"], {
      encoding: "utf-8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch {
    return out
  }
  for (const raw of stdout.split("\n")) {
    const line = raw.trim()
    if (!line || !line.includes("/")) continue
    const slash = line.indexOf("/")
    const provider = line.slice(0, slash)
    const model = line.slice(slash + 1)
    if (!provider || !model) continue
    if (!out[provider]) out[provider] = []
    if (!out[provider].includes(model)) out[provider].push(model)
  }
  return out
}

// ---------------------------------------------------------------------------
// Inspect
// ---------------------------------------------------------------------------

function mergeModels(
  target: InspectedModel[],
  additions: InspectedModel[],
): void {
  for (const m of additions) {
    const existing = target.find((t) => t.id === m.id)
    if (!existing) {
      target.push({ ...m, variants: [...m.variants] })
      continue
    }
    // Prefer reasoning=true and a richer variant list.
    existing.reasoning = existing.reasoning || m.reasoning
    for (const v of m.variants) {
      if (!existing.variants.includes(v)) existing.variants.push(v)
    }
  }
}

export interface InspectOptions {
  home?: string
  cwd?: string
  /** Inject a CLI enumerator (for testing); defaults to the real one. */
  cliEnumerator?: () => Record<string, string[]>
  /** Skip the CLI call entirely (defaults false). */
  skipCli?: boolean
}

/**
 * Detect the host's available providers and models, merging (and
 * de-duplicating) across auth.json, declared config providers, the
 * `opencode models` CLI, and the built-in fallback map.
 */
export function inspect(opts: InspectOptions = {}): InspectResult {
  const home = opts.home ?? homedir()
  const cwd = opts.cwd ?? process.cwd()
  const notes: string[] = []

  // 1. Authenticated providers from auth.json.
  const authProviders = new Set(readAuthProviders(home))

  // 2. Declared providers from project + user config files.
  const declaredSources: Array<{ path: string; label: string }> = [
    { path: join(cwd, "opencode.json"), label: "project opencode.json" },
    {
      path: join(home, ".config", "opencode", "opencode.json"),
      label: "user opencode.json",
    },
    {
      path: join(home, ".config", "opencode", "opencode.jsonc"),
      label: "user opencode.jsonc",
    },
  ]

  const merged = new Map<string, InspectedProvider>()

  const ensure = (id: string, source: string): InspectedProvider => {
    let p = merged.get(id)
    if (!p) {
      p = {
        id,
        authenticated: authProviders.has(id),
        source,
        models: [],
      }
      merged.set(id, p)
    } else if (!p.source.includes(source)) {
      p.source = `${p.source}, ${source}`
    }
    if (authProviders.has(id)) p.authenticated = true
    return p
  }

  for (const { path, label } of declaredSources) {
    if (!existsSync(path)) continue
    const parsed = parseJsonc(readFileSync(path, "utf-8"))
    if (!parsed) {
      notes.push(`Could not parse ${label} at ${path}`)
      continue
    }
    const declared = extractProviders(parsed)
    for (const [pid, dp] of Object.entries(declared)) {
      const prov = ensure(pid, label)
      if (dp.name && !prov.name) prov.name = dp.name
      if (dp.baseURL && !prov.baseURL) prov.baseURL = dp.baseURL
      const models: InspectedModel[] = Object.entries(dp.models).map(
        ([mid, m]) => ({ id: mid, reasoning: m.reasoning, variants: m.variants }),
      )
      mergeModels(prov.models, models)
    }
  }

  // 3. CLI enumeration (best-effort).
  if (!opts.skipCli) {
    const enumerator = opts.cliEnumerator ?? enumerateModelsViaCli
    const cliModels = enumerator()
    if (Object.keys(cliModels).length === 0) {
      notes.push(
        "`opencode models` returned nothing (CLI unavailable or empty) — relying on config + fallback.",
      )
    }
    for (const [pid, modelIds] of Object.entries(cliModels)) {
      const prov = ensure(pid, "opencode models CLI")
      mergeModels(
        prov.models,
        modelIds.map((id) => ({ id, reasoning: false, variants: [] })),
      )
    }
  }

  // 4. Built-in fallback map — fills gaps and adds options for known providers.
  for (const [pid, fb] of Object.entries(FALLBACK_PROVIDERS)) {
    // Only inject fallback providers that the host plausibly has: either
    // authenticated, already declared/enumerated, or always-available list.
    const known = merged.has(pid) || authProviders.has(pid)
    const prov = ensure(pid, known ? "fallback" : "fallback (built-in)")
    if (fb.name && !prov.name) prov.name = fb.name
    if (fb.baseURL && !prov.baseURL) prov.baseURL = fb.baseURL
    mergeModels(prov.models, fb.models)
  }

  // 5. Current resolved config + agents.
  const resolved = resolveConfigPath({ cwd, home })
  let currentAgents: Record<string, CurrentAgent> = {}
  if (resolved.path && existsSync(resolved.path)) {
    const parsed = parseJsonc(readFileSync(resolved.path, "utf-8"))
    if (parsed) {
      currentAgents = extractCurrentAgents(parsed)
    } else {
      notes.push(`Could not parse resolved config at ${resolved.path}`)
    }
  }

  // Sort: authenticated first, then alphabetical.
  const providers = [...merged.values()].sort((a, b) => {
    if (a.authenticated !== b.authenticated) return a.authenticated ? -1 : 1
    return a.id.localeCompare(b.id)
  })

  return {
    providers,
    currentConfigPath: resolved.path,
    currentAgents,
    notes,
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Resolve the desired variant for an assignment: an explicit `variant` wins,
 * otherwise derive it from `effort`. Returns undefined when neither is given
 * (model has no reasoning effort to set).
 */
function resolveVariant(a: Assignment): string | undefined {
  if (a.variant) return a.variant
  if (a.effort) return effortToVariant(a.effort)
  return undefined
}

/**
 * Capability lookup derived from an InspectResult: the set of known provider
 * ids and, per provider, each model's reasoning capability.
 */
interface CapabilityMap {
  /** All known provider ids (authenticated, declared, enumerated, or fallback). */
  providers: Set<string>
  /**
   * provider id -> (model id -> reasoning?). A missing model id means the model
   * was not enumerated (capability unknown), NOT that it lacks reasoning.
   */
  models: Map<string, Map<string, boolean>>
}

/** Build a {@link CapabilityMap} from an inspect result. */
function buildCapabilityMap(result: InspectResult): CapabilityMap {
  const providers = new Set<string>()
  const models = new Map<string, Map<string, boolean>>()
  for (const p of result.providers) {
    providers.add(p.id)
    const m = new Map<string, boolean>()
    for (const model of p.models) {
      m.set(model.id, model.reasoning)
    }
    models.set(p.id, m)
  }
  return { providers, models }
}

/** Parse the provider id (substring before the first `/`) of a model slug. */
function providerOf(model: string): string {
  const slash = model.indexOf("/")
  return slash >= 0 ? model.slice(0, slash) : model
}

/**
 * Apply per-agent model + effort/variant assignments to the target
 * opencode.json. Preserves all other content, creates missing agent entries,
 * and writes a `.bak` backup (only if one does not already exist) before
 * overwriting. On parse failure the original file is left untouched and
 * `{ ok: false, error }` is returned. Assignments whose provider id is not
 * among the host's known providers are rejected wholesale (no write, no
 * backup). Unknown-but-plausible model ids and effort on non-reasoning models
 * produce non-fatal `warnings` and still apply.
 */
export function applyAssignments(input: ApplyInput): ApplyResult {
  const resolved = resolveConfigPath({
    explicit: input.configPath,
    cwd: input.cwd,
  })
  const path = resolved.path
  if (!path) {
    return {
      ok: false,
      changes: [],
      error: "Could not resolve a target opencode config path.",
    }
  }

  // Capability map for provider/model validation (fast: no subprocess).
  const capabilities = buildCapabilityMap(
    inspect({ cwd: input.cwd, skipCli: true }),
  )

  // FIX 3: reject the whole apply when any assignment targets an unknown
  // provider. Mirror the up-front validation style in consensus-configure.ts.
  const invalidAssignments: Array<{
    agent: string
    model: string
    provider: string
  }> = []
  for (const [name, assignment] of Object.entries(input.assignments)) {
    if (!assignment || typeof assignment.model !== "string" || !assignment.model) {
      continue
    }
    const provider = providerOf(assignment.model)
    if (!capabilities.providers.has(provider)) {
      invalidAssignments.push({ agent: name, model: assignment.model, provider })
    }
  }
  if (invalidAssignments.length > 0) {
    const validProviders = [...capabilities.providers].sort()
    const pairs = invalidAssignments
      .map((x) => `${x.agent} -> ${x.model}`)
      .join(", ")
    return {
      ok: false,
      configPath: path,
      changes: [],
      error:
        `Unknown provider(s) for assignment(s): ${pairs}. ` +
        `Valid provider ids: ${validProviders.join(", ")}. ` +
        "Refusing to write. Run autoconfig_inspect to see available providers/models.",
      invalidAssignments,
      validProviders,
    }
  }

  // Read + parse existing config (create skeleton if missing).
  let configObj: Record<string, unknown>
  if (existsSync(path)) {
    const text = readFileSync(path, "utf-8")
    const parsed = parseJsonc(text)
    if (parsed === null || typeof parsed !== "object") {
      return {
        ok: false,
        configPath: path,
        changes: [],
        error: `Target config at ${path} is not valid JSON/JSONC; refusing to write to avoid corruption.`,
      }
    }
    configObj = parsed as Record<string, unknown>
  } else {
    configObj = { $schema: "https://opencode.ai/config.json" }
  }

  // Ensure agent block exists.
  if (!configObj["agent"] || typeof configObj["agent"] !== "object") {
    configObj["agent"] = {}
  }
  const agents = configObj["agent"] as Record<string, unknown>

  const changes: ChangeRecord[] = []
  const warnings: string[] = []

  for (const [name, assignment] of Object.entries(input.assignments)) {
    if (!assignment || typeof assignment.model !== "string" || !assignment.model) {
      // Skip malformed assignment but keep going.
      continue
    }
    let newVariant = resolveVariant(assignment)

    // Look up the model's enumerated capability (may be unknown).
    const provider = providerOf(assignment.model)
    const modelId = assignment.model.slice(provider.length + 1)
    const providerModels = capabilities.models.get(provider)
    const reasoningCapability = providerModels?.has(modelId)
      ? providerModels.get(modelId)
      : undefined

    // FIX 3 (non-fatal): provider known but specific model id not enumerated.
    if (providerModels !== undefined && reasoningCapability === undefined) {
      warnings.push(
        `${name}: model '${assignment.model}' is not in the enumerated list for provider '${provider}' (applied anyway — enumeration may be incomplete).`,
      )
    }

    // FIX 4: never write a variant for a model known to be non-reasoning.
    if (newVariant !== undefined && reasoningCapability === false) {
      warnings.push(
        `${name}: effort ignored — ${assignment.model} is not reasoning-capable.`,
      )
      newVariant = undefined
    }

    const existing =
      agents[name] && typeof agents[name] === "object"
        ? (agents[name] as Record<string, unknown>)
        : undefined

    const oldModel =
      existing && typeof existing["model"] === "string"
        ? (existing["model"] as string)
        : undefined
    const oldVariant =
      existing && typeof existing["variant"] === "string"
        ? (existing["variant"] as string)
        : undefined

    const created = existing === undefined
    const target: Record<string, unknown> = existing ?? {}
    target["model"] = assignment.model
    if (newVariant !== undefined) {
      target["variant"] = newVariant
    }
    agents[name] = target

    changes.push({
      agent: name,
      oldModel,
      newModel: assignment.model,
      oldVariant,
      newVariant,
      created,
    })
  }

  // Backup then write. FIX 2: only create the `.bak` if it does NOT already
  // exist, so a second run never clobbers the pristine backup.
  let backupPath: string | undefined
  try {
    if (existsSync(path)) {
      backupPath = `${path}.bak`
      if (!existsSync(backupPath)) {
        copyFileSync(path, backupPath)
      }
    }
    writeFileSync(path, JSON.stringify(configObj, null, 2) + "\n", "utf-8")
  } catch (err) {
    return {
      ok: false,
      configPath: path,
      changes,
      error: `Failed to write config: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }

  return {
    ok: true,
    configPath: path,
    backupPath,
    changes,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
