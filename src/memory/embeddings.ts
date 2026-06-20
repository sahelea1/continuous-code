/**
 * Embedding provider abstraction.
 *
 * Default = `none` (text-only recall, no API key, no infra). Opt-in HTTP
 * providers (`voyage`, `openai`, `ollama`) go over `fetch()` with a 30s
 * AbortController timeout and throw `EmbeddingError` on failure. `local` is a
 * stub that throws "not implemented".
 *
 * No new runtime deps. Callers MUST treat embed failures as non-fatal: store
 * still writes a row with NULL embedding; recall falls back to text mode.
 */
import type { EmbeddingConfig } from "./config.js"

export interface Embedder {
  readonly provider: string
  readonly dimension: number // 0 for none
  /** Returns null when provider is "none" (text-only mode). */
  embed(text: string): Promise<number[] | null>
}

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EmbeddingError"
  }
}

const TIMEOUT_MS = 30_000

/** Run a fetch with a 30s AbortController timeout, mapping failures to EmbeddingError. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  provider: string,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new EmbeddingError(
        `${provider} embeddings request timed out after ${TIMEOUT_MS}ms`,
      )
    }
    throw new EmbeddingError(
      `${provider} embeddings request failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  } finally {
    clearTimeout(timer)
  }
}

/** No-op embedder (default). dimension 0, embed() -> null. */
class NoneEmbedder implements Embedder {
  readonly provider = "none"
  readonly dimension = 0
  async embed(_text: string): Promise<number[] | null> {
    return null
  }
}

/** Voyage AI — voyage-3 emits 1024-dim vectors (pg vector(1024)-compatible). */
class VoyageEmbedder implements Embedder {
  readonly provider = "voyage"
  readonly dimension: number
  private readonly model: string
  private readonly apiKeyEnv: string

  constructor(cfg: EmbeddingConfig) {
    this.model = cfg.model || "voyage-3"
    this.apiKeyEnv = cfg.apiKeyEnv || "VOYAGE_API_KEY"
    this.dimension = cfg.dimension ?? 1024
  }

  async embed(text: string): Promise<number[]> {
    const key = process.env[this.apiKeyEnv]
    if (!key) {
      throw new EmbeddingError(
        `voyage embeddings: missing API key (env ${this.apiKeyEnv})`,
      )
    }
    const res = await fetchWithTimeout(
      "https://api.voyageai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ input: text, model: this.model }),
      },
      "voyage",
    )
    if (!res.ok) {
      throw new EmbeddingError(
        `voyage embeddings HTTP ${res.status}: ${await safeText(res)}`,
      )
    }
    const json = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>
    }
    const vec = json.data?.[0]?.embedding
    if (!Array.isArray(vec)) {
      throw new EmbeddingError("voyage embeddings: malformed response (no data[0].embedding)")
    }
    return vec
  }
}

/** OpenAI / openai-compatible — text-embedding-3-small is 1536-dim. */
class OpenAIEmbedder implements Embedder {
  readonly provider = "openai"
  readonly dimension: number
  private readonly model: string
  private readonly apiKeyEnv: string
  private readonly baseURL: string

  constructor(cfg: EmbeddingConfig) {
    this.model = cfg.model || "text-embedding-3-small"
    this.apiKeyEnv = cfg.apiKeyEnv || "OPENAI_API_KEY"
    this.baseURL = (cfg.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "")
    this.dimension = cfg.dimension ?? 1536
  }

  async embed(text: string): Promise<number[]> {
    const key = process.env[this.apiKeyEnv]
    if (!key) {
      throw new EmbeddingError(
        `openai embeddings: missing API key (env ${this.apiKeyEnv})`,
      )
    }
    const res = await fetchWithTimeout(
      `${this.baseURL}/embeddings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ input: text, model: this.model }),
      },
      "openai",
    )
    if (!res.ok) {
      throw new EmbeddingError(
        `openai embeddings HTTP ${res.status}: ${await safeText(res)}`,
      )
    }
    const json = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>
    }
    const vec = json.data?.[0]?.embedding
    if (!Array.isArray(vec)) {
      throw new EmbeddingError("openai embeddings: malformed response (no data[0].embedding)")
    }
    return vec
  }
}

/** Ollama (local server). Model required; dimension inferred from response. */
class OllamaEmbedder implements Embedder {
  readonly provider = "ollama"
  readonly dimension: number
  private readonly model: string
  private readonly baseURL: string

  constructor(cfg: EmbeddingConfig) {
    this.model = cfg.model || ""
    this.baseURL = (cfg.baseURL || "http://localhost:11434").replace(/\/+$/, "")
    this.dimension = cfg.dimension ?? 0
  }

  async embed(text: string): Promise<number[]> {
    if (!this.model) {
      throw new EmbeddingError(
        "ollama embeddings: model is required (e.g. nomic-embed-text)",
      )
    }
    const res = await fetchWithTimeout(
      `${this.baseURL}/api/embeddings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
      },
      "ollama",
    )
    if (!res.ok) {
      throw new EmbeddingError(
        `ollama embeddings HTTP ${res.status}: ${await safeText(res)}`,
      )
    }
    const json = (await res.json()) as { embedding?: number[] }
    const vec = json.embedding
    if (!Array.isArray(vec)) {
      throw new EmbeddingError("ollama embeddings: malformed response (no embedding)")
    }
    return vec
  }
}

/** Local embeddings are out of scope for the default build (opt-in stub). */
class LocalEmbedder implements Embedder {
  readonly provider = "local"
  readonly dimension: number
  constructor(cfg: EmbeddingConfig) {
    this.dimension = cfg.dimension ?? 0
  }
  async embed(_text: string): Promise<number[]> {
    throw new EmbeddingError(
      "local embeddings not implemented (opt-in, out of scope)",
    )
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text()
    return t.length > 300 ? t.slice(0, 300) + "..." : t
  } catch {
    return "(no body)"
  }
}

/**
 * Factory. Never throws on construction. "local" returns an embedder whose
 * embed() rejects with a clear "not implemented" error.
 */
export function getEmbedder(cfg: EmbeddingConfig): Embedder {
  switch (cfg.provider) {
    case "voyage":
      return new VoyageEmbedder(cfg)
    case "openai":
      return new OpenAIEmbedder(cfg)
    case "ollama":
      return new OllamaEmbedder(cfg)
    case "local":
      return new LocalEmbedder(cfg)
    case "none":
    default:
      return new NoneEmbedder()
  }
}
