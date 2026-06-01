/**
 * Native OpenRouter "Fusion" deliberation path.
 *
 * Fusion runs all analysis models + a judge model server-side in a single
 * OpenRouter request via the `openrouter:fusion` tool. It only works for
 * OpenRouter-hosted models, so this path requires every panel member to use
 * the "openrouter" provider.
 *
 * Pure logic only — no `@opencode-ai/plugin` import. Uses global `fetch`.
 */
import type {
  ConsensusConfig,
  ConsensusResult,
  ModelResponse,
} from "./types.js"
import { getMain, resolveApiKey } from "./config.js"
import { withConsensusLock } from "./lock.js"

/**
 * Run native OpenRouter Fusion and return a single consensus.
 * Throws if any panel member is not on the "openrouter" provider.
 *
 * Serialized via withConsensusLock so only one deliberation/fusion runs at a
 * time within the single consensus instance.
 */
export async function fusionDeliberate(
  config: ConsensusConfig,
  prompt: string,
): Promise<ConsensusResult> {
  return withConsensusLock(() => fusionDeliberateImpl(config, prompt))
}

async function fusionDeliberateImpl(
  config: ConsensusConfig,
  prompt: string,
): Promise<ConsensusResult> {
  const nonOpenRouter = config.panel.filter((m) => m.provider !== "openrouter")
  if (nonOpenRouter.length > 0) {
    const offenders = nonOpenRouter.map((m) => `${m.id} (${m.provider})`).join(", ")
    throw new Error(
      `native fusion requires all panel members to use the "openrouter" provider; offending members: ${offenders}`,
    )
  }

  const main = getMain(config)
  const provider = config.providers["openrouter"]
  if (!provider) {
    throw new Error('native fusion requires an "openrouter" provider entry in consensus.json')
  }
  const apiKey = resolveApiKey(provider)

  // analysis_models: all panel slugs, capped at 8 per the Fusion limit.
  const analysisModels = config.panel.map((m) => m.model).slice(0, 8)

  const fusionTool: Record<string, any> = {
    type: "openrouter:fusion",
    parameters: {
      analysis_models: analysisModels,
      model: main.model,
      max_completion_tokens: config.maxTokens,
    },
  }
  if (main.reasoning) {
    fusionTool.parameters.reasoning = { effort: main.reasoning }
    if (typeof main.reasoningMaxTokens === "number") {
      fusionTool.parameters.reasoning.max_tokens = main.reasoningMaxTokens
    }
  }

  const body: Record<string, any> = {
    model: main.model,
    messages: [{ role: "user", content: prompt }],
    tools: [fusionTool],
    tool_choice: "required",
    temperature: config.temperature,
    provider: { require_parameters: true },
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/opencode-continuous",
    "X-Title": "opencode-continuous",
  }
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)

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
      `fusion request failed: ${response.status} ${response.statusText}: ${truncated}`,
    )
  }

  const raw = await response.json()
  const message = raw?.choices?.[0]?.message ?? {}

  // The Fusion result is attached to the message as `analysis`. Be defensive
  // about its shape; fall back to plain content if it's missing.
  const analysis = message.analysis ?? raw?.analysis
  let consensusText = ""

  if (analysis && Array.isArray(analysis.consensus)) {
    consensusText = analysis.consensus
      .map((c: any) => (typeof c === "string" ? c : c?.text ?? JSON.stringify(c)))
      .join("\n")
      .trim()
  } else if (analysis && typeof analysis.consensus === "string") {
    consensusText = analysis.consensus.trim()
  }

  if (!consensusText) {
    consensusText =
      typeof message.content === "string" ? message.content.trim() : ""
  }

  // Reconstruct per-model responses from the fusion `responses[]` if present.
  const fusionResponses: any[] = Array.isArray(message.responses)
    ? message.responses
    : Array.isArray(raw?.responses)
      ? raw.responses
      : Array.isArray(analysis?.responses)
        ? analysis.responses
        : []

  let responses: ModelResponse[]
  if (fusionResponses.length > 0) {
    responses = fusionResponses.map((r: any, i: number) => {
      const member = config.panel[i] ?? config.panel[0]
      const content =
        typeof r === "string"
          ? r
          : r?.content ?? r?.message?.content ?? r?.response ?? ""
      return {
        member,
        ok: true,
        content: typeof content === "string" ? content : JSON.stringify(content),
        latencyMs: 0,
      }
    })
  } else {
    // No per-model breakdown: synthesize placeholder ok responses.
    responses = config.panel.map((member) => ({
      member,
      ok: true,
      content: undefined,
      latencyMs: 0,
    }))
  }

  return {
    consensus: consensusText,
    main: main.id,
    mainOverrode: false,
    agreement: 0.8,
    responses,
    notes: "native fusion",
  }
}
