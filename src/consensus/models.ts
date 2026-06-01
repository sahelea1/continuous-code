/**
 * List/search AI models from an OpenAI-compatible provider (e.g. OpenRouter).
 *
 * Pure logic only — no `@opencode-ai/plugin` import. Uses global `fetch`.
 */

export interface ModelListEntry {
  id: string
  name?: string
  /** USD price per prompt token (parsed from pricing.prompt). */
  promptPrice?: number
  /** USD price per completion token (parsed from pricing.completion). */
  completionPrice?: number
  contextLength?: number
  supportsReasoning?: boolean
}

export interface ListModelsOptions {
  baseURL: string
  apiKey?: string
  search?: string
  limit?: number
  timeoutMs?: number
}

/** Parse a numeric price; returns undefined if unparseable. */
function parsePrice(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const n = parseFloat(String(value))
  return Number.isFinite(n) ? n : undefined
}

/**
 * GET `${baseURL}/models` and return a ranked, optionally filtered list.
 *
 * The endpoint is public — `Authorization` is sent only if `apiKey` is given.
 * Adds OpenRouter attribution headers when the baseURL targets openrouter.ai.
 * Sorted by (promptPrice + completionPrice) ascending; capped to `limit`.
 */
export async function listModels(
  opts: ListModelsOptions,
): Promise<ModelListEntry[]> {
  const { baseURL, apiKey, search, limit = 40, timeoutMs = 30000 } = opts

  const headers: Record<string, string> = {}
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`
  if (baseURL.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://github.com/opencode-continuous"
    headers["X-Title"] = "opencode-continuous"
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetch(`${baseURL}/models`, {
      method: "GET",
      headers,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    let text = ""
    try {
      text = await response.text()
    } catch {
      text = "<no body>"
    }
    const truncated = text.length > 500 ? `${text.slice(0, 500)}…` : text
    throw new Error(
      `models listing failed: ${response.status} ${response.statusText}: ${truncated}`,
    )
  }

  const raw = await response.json()
  const data: any[] = Array.isArray(raw?.data) ? raw.data : []

  let entries: ModelListEntry[] = data.map((m: any) => {
    const pricing = m?.pricing ?? {}
    return {
      id: typeof m?.id === "string" ? m.id : String(m?.id ?? ""),
      name: typeof m?.name === "string" ? m.name : undefined,
      promptPrice: parsePrice(pricing.prompt),
      completionPrice: parsePrice(pricing.completion),
      contextLength:
        typeof m?.context_length === "number" ? m.context_length : undefined,
      supportsReasoning:
        Array.isArray(m?.supported_parameters) &&
        m.supported_parameters.includes("reasoning"),
    }
  })

  if (search && search.trim().length > 0) {
    const needle = search.trim().toLowerCase()
    entries = entries.filter((e) => {
      const id = e.id.toLowerCase()
      const name = (e.name ?? "").toLowerCase()
      return id.includes(needle) || name.includes(needle)
    })
  }

  // Sort by total price ascending; entries with no price sort last.
  const totalPrice = (e: ModelListEntry): number => {
    const p = e.promptPrice
    const c = e.completionPrice
    if (p === undefined && c === undefined) return Number.POSITIVE_INFINITY
    return (p ?? 0) + (c ?? 0)
  }
  entries.sort((a, b) => totalPrice(a) - totalPrice(b))

  return entries.slice(0, limit)
}
