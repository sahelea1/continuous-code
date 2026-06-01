/**
 * Client-side "main-judge" deliberation: fan out to all panel models in
 * parallel, then have the main (dominant) model synthesize one answer.
 *
 * Pure logic only — no `@opencode-ai/plugin` import.
 */
import type {
  ConsensusConfig,
  ConsensusResult,
  ModelResponse,
  PanelMember,
} from "./types.js"
import { getMain, resolveApiKey } from "./config.js"
import { chatComplete } from "./providers.js"

const JUDGE_SYSTEM_PROMPT = `You are the MAIN (dominant) model in a multi-model consensus panel. You are given the user's request and independent answers from each panel model (including your own). Produce ONE final answer that represents the consensus. Where the models agree, reflect that. Where they disagree, you are the tie-breaker — you MAY override the minority, or even the majority, when you judge it correct, but keep the final answer focused and useful. After the final answer, output exactly two trailing lines:
---AGREEMENT: <number 0 to 1>
---OVERRIDE: <yes or no>`

/** Build the user message from optional context + the prompt. */
function buildUserMessage(prompt: string, context?: string): string {
  if (context && context.trim().length > 0) {
    return `## Context\n\n${context}\n\n## Request\n\n${prompt}`
  }
  return prompt
}

/** Call a single panel member, capturing timing and success/error. */
async function callMember(
  config: ConsensusConfig,
  member: PanelMember,
  userMessage: string,
): Promise<ModelResponse> {
  const start = Date.now()
  const provider = config.providers[member.provider]
  const supportsReasoning = member.provider === "openrouter"

  if (!provider) {
    return {
      member,
      ok: false,
      error: `unknown provider '${member.provider}'`,
      latencyMs: Date.now() - start,
    }
  }

  try {
    const apiKey = resolveApiKey(provider)
    const result = await chatComplete({
      provider,
      apiKey,
      model: member.model,
      messages: [{ role: "user", content: userMessage }],
      reasoning: member.reasoning,
      reasoningMaxTokens: member.reasoningMaxTokens,
      maxTokens: config.maxTokens,
      temperature: member.temperature ?? config.temperature,
      timeoutMs: config.timeoutMs,
      supportsReasoning,
      requireParameters: config.requireParameters,
    })
    // Treat empty/whitespace-only content as a failure: some models return
    // finish_reason:"length" with content:null which maps to "" here.
    if (!result.content || result.content.trim().length === 0) {
      return {
        member,
        ok: false,
        error: `empty response (finish_reason=${result.finishReason ?? "unknown"})`,
        finishReason: result.finishReason,
        latencyMs: Date.now() - start,
      }
    }
    return {
      member,
      ok: true,
      content: result.content,
      reasoning: result.reasoning,
      finishReason: result.finishReason,
      latencyMs: Date.now() - start,
    }
  } catch (err) {
    return {
      member,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    }
  }
}

/** Clamp a number into [0, 1]. */
function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/**
 * Parse the two trailing marker lines from the judge output.
 * Returns the stripped consensus text plus parsed agreement/override.
 */
function parseMarkers(
  text: string,
  fallbackAgreement: number,
): { consensus: string; agreement: number; override: boolean } {
  const lines = text.split("\n")
  let agreement: number | undefined
  let override = false
  const keep: string[] = []

  for (const line of lines) {
    const agreementMatch = line.match(/^\s*---AGREEMENT:\s*([0-9]*\.?[0-9]+)/i)
    const overrideMatch = line.match(/^\s*---OVERRIDE:\s*(yes|no|true|false)/i)
    if (agreementMatch) {
      agreement = clamp01(parseFloat(agreementMatch[1]))
      continue
    }
    if (overrideMatch) {
      const v = overrideMatch[1].toLowerCase()
      override = v === "yes" || v === "true"
      continue
    }
    keep.push(line)
  }

  return {
    consensus: keep.join("\n").trim(),
    agreement: agreement ?? fallbackAgreement,
    override,
  }
}

/**
 * Run a client-side multi-model deliberation and return a single consensus.
 */
export async function deliberate(
  config: ConsensusConfig,
  prompt: string,
  opts?: { context?: string },
): Promise<ConsensusResult> {
  const userMessage = buildUserMessage(prompt, opts?.context)
  const main = getMain(config)

  const settled = await Promise.allSettled(
    config.panel.map((member) => callMember(config, member, userMessage)),
  )

  const responses: ModelResponse[] = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value
    return {
      member: config.panel[i],
      ok: false,
      error: s.reason instanceof Error ? s.reason.message : String(s.reason),
      latencyMs: 0,
    }
  })

  const okResponses = responses.filter((r) => r.ok)
  const failed = responses.filter((r) => !r.ok)

  if (okResponses.length === 0) {
    const detail = failed
      .map((r) => `${r.member.id}: ${r.error ?? "unknown error"}`)
      .join("; ")
    throw new Error(`all panel models failed: ${detail}`)
  }

  const fallbackAgreement = okResponses.length / responses.length

  // Single-member panel: no synthesis needed.
  if (config.panel.length === 1) {
    const only = okResponses[0]
    return {
      consensus: only.content ?? "",
      main: main.id,
      mainOverrode: false,
      agreement: 1,
      responses,
      notes: `single-model panel (1 ok, 0 failed)`,
    }
  }

  // Build the judge user message from each successful model's answer.
  const sections = okResponses.map(
    (r) => `### Model ${r.member.id} (${r.member.model}):\n${r.content ?? ""}`,
  )
  let judgeUser = `Original request:\n\n${userMessage}\n\nIndependent panel answers:\n\n${sections.join(
    "\n\n",
  )}`
  if (failed.length > 0) {
    const failedNote = failed
      .map((r) => `${r.member.id} (${r.member.model}): ${r.error ?? "error"}`)
      .join("; ")
    judgeUser += `\n\nNote — the following models failed to respond and are excluded: ${failedNote}`
  }

  const mainProvider = config.providers[main.provider]
  const mainApiKey = resolveApiKey(mainProvider)
  const judge = await chatComplete({
    provider: mainProvider,
    apiKey: mainApiKey,
    model: main.model,
    messages: [
      { role: "system", content: JUDGE_SYSTEM_PROMPT },
      { role: "user", content: judgeUser },
    ],
    reasoning: main.reasoning,
    reasoningMaxTokens: main.reasoningMaxTokens,
    maxTokens: config.maxTokens,
    temperature: main.temperature ?? config.temperature,
    timeoutMs: config.timeoutMs,
    supportsReasoning: main.provider === "openrouter",
    requireParameters: config.requireParameters,
  })

  const parsed = parseMarkers(judge.content, fallbackAgreement)

  let consensus = parsed.consensus
  let notes = `${okResponses.length} ok, ${failed.length} failed`

  // The panel produced content, so the consensus must never be empty. If the
  // judge returned an empty/whitespace answer, fall back to the main member's
  // own panel response, else the first ok response's content.
  if (!consensus || consensus.trim().length === 0) {
    const mainResponse = okResponses.find((r) => r.member.id === main.id)
    const fallback =
      (mainResponse?.content && mainResponse.content.trim().length > 0
        ? mainResponse.content
        : undefined) ?? okResponses[0]?.content ?? ""
    consensus = fallback
    notes += "; judge returned empty — used panel fallback"
  }

  return {
    consensus,
    main: main.id,
    mainOverrode: parsed.override,
    agreement: parsed.agreement,
    responses,
    notes,
  }
}
