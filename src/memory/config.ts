/**
 * Configuration loading & normalization for the Memory / Recall subsystem.
 *
 * Pure logic only — no `@opencode-ai/plugin` import (mirrors
 * `src/consensus/config.ts`). Loads `<directory>/memory.json` (optional),
 * merges over DEFAULT_MEMORY_CONFIG, then applies env overrides. Resolves the
 * sqlite db path and the postgres connection URL by the locked priority
 * (reconciliation R2).
 */
import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export type MemoryBackendKind = "sqlite" | "postgres" | "none"
export type EmbeddingProviderKind =
  | "none"
  | "voyage"
  | "openai"
  | "ollama"
  | "local"

export interface EmbeddingConfig {
  provider: EmbeddingProviderKind // default "none"
  model?: string // provider-specific; default per provider (see §6)
  apiKeyEnv?: string // env var holding the API key
  baseURL?: string // for ollama / openai-compatible endpoints
  dimension?: number // expected dim; default per provider
}

export interface MemoryConfig {
  backend: MemoryBackendKind // default "sqlite"
  sqlitePath: string // resolved absolute path to memory.db
  postgresUrl?: string // resolved pg connection string (when backend=postgres)
  dedupThreshold: number // default 0.85
  recallLimit: number // default 5
  embeddings: EmbeddingConfig
}

/**
 * Resolve `~/.config/opencode/continuous/memory.db`.
 * Honors `$XDG_CONFIG_HOME`, falling back to `$HOME`/`$USERPROFILE` (via os.homedir()).
 */
export function resolveSqlitePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base =
    xdg && xdg.trim().length > 0 ? xdg : join(homedir(), ".config")
  return join(base, "opencode", "continuous", "memory.db")
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  backend: "sqlite",
  sqlitePath: resolveSqlitePath(),
  postgresUrl: undefined,
  dedupThreshold: 0.85,
  recallLimit: 5,
  embeddings: {
    provider: "none",
    model: undefined,
    apiKeyEnv: undefined,
    baseURL: undefined,
    dimension: undefined,
  },
}

/**
 * Postgres URL priority (first defined wins) — reconciliation R2:
 *  1. env MEMORY_POSTGRES_URL
 *  2. env CONTINUOUS_CODE_DB_URL
 *  3. env CONTINUOUS_CLAUDE_DB_URL   (CC-v3 compat)
 *  4. env DATABASE_URL               (CC-v3 compat)
 *  5. memory.json "postgresUrl"
 *  returns undefined if none set.
 */
export function resolvePostgresUrl(
  cfg?: Partial<MemoryConfig>,
): string | undefined {
  const candidates = [
    process.env.MEMORY_POSTGRES_URL,
    process.env.CONTINUOUS_CODE_DB_URL,
    process.env.CONTINUOUS_CLAUDE_DB_URL,
    process.env.DATABASE_URL,
    cfg?.postgresUrl,
  ]
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim()
  }
  return undefined
}

const VALID_BACKENDS: MemoryBackendKind[] = ["sqlite", "postgres", "none"]
const VALID_PROVIDERS: EmbeddingProviderKind[] = [
  "none",
  "voyage",
  "openai",
  "ollama",
  "local",
]

function isBackendKind(v: unknown): v is MemoryBackendKind {
  return typeof v === "string" && (VALID_BACKENDS as string[]).includes(v)
}

function isProviderKind(v: unknown): v is EmbeddingProviderKind {
  return typeof v === "string" && (VALID_PROVIDERS as string[]).includes(v)
}

/**
 * Load memory.json from `directory` (if present), merge DEFAULT_MEMORY_CONFIG,
 * then apply env overrides.
 *
 * Env overrides:
 *   MEMORY_BACKEND          -> backend  (sqlite|postgres|none; invalid -> default + warn)
 *   MEMORY_DB_PATH          -> sqlitePath
 *   MEMORY_EMBEDDINGS       -> embeddings.provider
 *   MEMORY_EMBEDDINGS_MODEL -> embeddings.model
 *   MEMORY_DEDUP_THRESHOLD  -> dedupThreshold (float)
 *   MEMORY_RECALL_LIMIT     -> recallLimit (int)
 *
 * Does NOT infer backend from a stray postgres URL — the installer is
 * responsible for writing backend:"postgres" into memory.json when it detects a
 * reusable db (reconciliation R2).
 */
export function loadMemoryConfig(directory: string): MemoryConfig {
  const merged: MemoryConfig = {
    ...DEFAULT_MEMORY_CONFIG,
    embeddings: { ...DEFAULT_MEMORY_CONFIG.embeddings },
  }

  const configPath = join(directory, "memory.json")
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(
        readFileSync(configPath, "utf-8"),
      ) as Partial<MemoryConfig>

      if (isBackendKind(raw.backend)) merged.backend = raw.backend
      if (typeof raw.sqlitePath === "string" && raw.sqlitePath.trim()) {
        merged.sqlitePath = expandHome(raw.sqlitePath.trim())
      }
      if (typeof raw.postgresUrl === "string" && raw.postgresUrl.trim()) {
        merged.postgresUrl = raw.postgresUrl.trim()
      }
      if (typeof raw.dedupThreshold === "number") {
        merged.dedupThreshold = raw.dedupThreshold
      }
      if (typeof raw.recallLimit === "number") {
        merged.recallLimit = raw.recallLimit
      }
      if (raw.embeddings && typeof raw.embeddings === "object") {
        const e = raw.embeddings as Partial<EmbeddingConfig>
        if (isProviderKind(e.provider)) merged.embeddings.provider = e.provider
        if (typeof e.model === "string") merged.embeddings.model = e.model
        if (typeof e.apiKeyEnv === "string") {
          merged.embeddings.apiKeyEnv = e.apiKeyEnv
        }
        if (typeof e.baseURL === "string") merged.embeddings.baseURL = e.baseURL
        if (typeof e.dimension === "number") {
          merged.embeddings.dimension = e.dimension
        }
      }
    } catch {
      // Malformed config: fall back to defaults silently.
    }
  }

  // --- Env overrides ---
  const envBackend = process.env.MEMORY_BACKEND
  if (envBackend !== undefined && envBackend.trim().length > 0) {
    const v = envBackend.trim().toLowerCase()
    if (isBackendKind(v)) {
      merged.backend = v
    } else {
      console.warn(
        `[memory] invalid MEMORY_BACKEND="${envBackend}" (expected sqlite|postgres|none) — keeping "${merged.backend}".`,
      )
    }
  }

  const envDbPath = process.env.MEMORY_DB_PATH
  if (envDbPath !== undefined && envDbPath.trim().length > 0) {
    merged.sqlitePath = expandHome(envDbPath.trim())
  }

  const envEmb = process.env.MEMORY_EMBEDDINGS
  if (envEmb !== undefined && envEmb.trim().length > 0) {
    const v = envEmb.trim().toLowerCase()
    if (isProviderKind(v)) {
      merged.embeddings.provider = v
    } else {
      console.warn(
        `[memory] invalid MEMORY_EMBEDDINGS="${envEmb}" (expected none|voyage|openai|ollama|local) — keeping "${merged.embeddings.provider}".`,
      )
    }
  }

  const envEmbModel = process.env.MEMORY_EMBEDDINGS_MODEL
  if (envEmbModel !== undefined && envEmbModel.trim().length > 0) {
    merged.embeddings.model = envEmbModel.trim()
  }

  const envDedup = process.env.MEMORY_DEDUP_THRESHOLD
  if (envDedup !== undefined && envDedup.trim().length > 0) {
    const n = Number.parseFloat(envDedup)
    if (Number.isFinite(n)) merged.dedupThreshold = n
  }

  const envLimit = process.env.MEMORY_RECALL_LIMIT
  if (envLimit !== undefined && envLimit.trim().length > 0) {
    const n = Number.parseInt(envLimit, 10)
    if (Number.isFinite(n) && n > 0) merged.recallLimit = n
  }

  // Resolve the effective postgres URL by priority (R2). Note: this does NOT
  // change the backend selector — that stays whatever was explicitly set.
  const pgUrl = resolvePostgresUrl(merged)
  if (pgUrl) merged.postgresUrl = pgUrl

  return merged
}

/** Expand a leading `~` / `~/` to the user's home directory. */
function expandHome(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}
