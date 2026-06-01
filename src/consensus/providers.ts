/**
 * OpenAI-compatible chat completion client for consensus providers.
 *
 * Pure logic only — no `@opencode-ai/plugin` import. Uses global `fetch`.
 */
import type { ProviderConfig, ReasoningEffort } from "./types.js"

export interface ChatCompleteArgs {
  provider: ProviderConfig
  apiKey?: string
  model: string
  messages: { role: string; content: string }[]
  reasoning?: ReasoningEffort
  reasoningMaxTokens?: number
  maxTokens: number
  temperature: number
  timeoutMs: number
  /** Whether this provider supports the OpenRouter `reasoning` object. */
  supportsReasoning: boolean
  /**
   * Opt-in: when true, set `provider.require_parameters` so OpenRouter only
   * routes to endpoints that support all passed params (e.g. `reasoning`).
   * Defaults to false so unsupported params are dropped gracefully.
   */
  requireParameters?: boolean
}

export interface ChatCompleteResult {
  content: string
  reasoning?: string
  finishReason?: string
  raw: any
}

/**
 * Perform a single OpenAI-compatible chat completion.
 * Includes the OpenRouter `reasoning` object only when supported AND an
 * effort is provided.
 */
export async function chatComplete(
  args: ChatCompleteArgs,
): Promise<ChatCompleteResult> {
  const {
    provider,
    apiKey,
    model,
    messages,
    reasoning,
    reasoningMaxTokens,
    maxTokens,
    temperature,
    timeoutMs,
    supportsReasoning,
    requireParameters,
  } = args

  const body: Record<string, any> = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
  }

  if (supportsReasoning && reasoning) {
    const reasoningObj: Record<string, any> = { effort: reasoning }
    if (typeof reasoningMaxTokens === "number") {
      reasoningObj.max_tokens = reasoningMaxTokens
    }
    body.reasoning = reasoningObj
    // Opt-in only: require_parameters forces OpenRouter to fail (404) for
    // endpoints that don't support `reasoning`. By default we leave it off so
    // unsupported params are dropped and the model still answers.
    if (requireParameters === true) {
      body.provider = { require_parameters: true }
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`
  }
  // OpenRouter-recommended attribution headers.
  if (provider.baseURL.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://github.com/opencode-continuous"
    headers["X-Title"] = "opencode-continuous"
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetch(`${provider.baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
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
      `chat completion failed: ${response.status} ${response.statusText}: ${truncated}`,
    )
  }

  const raw = await response.json()
  const message = raw?.choices?.[0]?.message ?? {}
  const content = typeof message.content === "string" ? message.content : ""
  const reasoningText =
    typeof message.reasoning === "string" ? message.reasoning : undefined
  const finishReason: string | undefined =
    typeof raw?.choices?.[0]?.finish_reason === "string"
      ? raw.choices[0].finish_reason
      : undefined

  return { content, reasoning: reasoningText, finishReason, raw }
}
