/**
 * LIVE consensus tests (gated on OPENROUTER_API_KEY). Cost-conscious:
 * tiny prompts, max_tokens <= 64, cheapest paid models, <= 4 calls total.
 *
 * Run with:
 *   OPENROUTER_API_KEY=... node --test tests/consensus/live.test.mjs
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { chatComplete } from "../../dist/consensus/providers.js"
import { deliberate } from "../../dist/consensus/deliberate.js"
import { listModels } from "../../dist/consensus/models.js"

const API_KEY = process.env.OPENROUTER_API_KEY
const BASE_URL = "https://openrouter.ai/api/v1"
const PROVIDER = { baseURL: BASE_URL, apiKeyEnv: "OPENROUTER_API_KEY" }

// Fallback candidate slugs if the listing call fails (likely-cheap models).
const FALLBACK_SLUGS = [
  "openai/gpt-4o-mini",
  "google/gemini-2.0-flash-001",
  "mistralai/mistral-nemo",
  "meta-llama/llama-3.1-8b-instruct",
]

/** Heuristic: is a model a usable text chat model (not embed/image/etc)? */
function isUsableChatModel(m) {
  const id = (m.id || "").toLowerCase()
  const name = (m.name || "").toLowerCase()
  if (/embed|whisper|tts|moderation|image|vision-only|video|rerank/.test(id)) {
    return false
  }
  if (/embedding|moderation/.test(name)) return false
  const modality = m?.architecture?.modality || ""
  // Want text output. OpenRouter modality looks like "text->text" or "text+image->text".
  if (modality && !/->\s*text/.test(modality) && !/text$/.test(modality)) {
    return false
  }
  return true
}

/** Numeric per-token price (prompt+completion). Returns Infinity if unusable. */
function priceOf(m) {
  const p = m?.pricing || {}
  const prompt = parseFloat(p.prompt)
  const completion = parseFloat(p.completion)
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return Infinity
  // Skip free / zero-price models (rate-limited, can be flaky for tests).
  if (prompt <= 0 && completion <= 0) return Infinity
  return prompt + completion
}

/**
 * Fetch and rank the cheapest paid usable chat models by (prompt+completion)
 * price ascending.
 *
 * We no longer filter to reasoning-capable models: the consensus client now
 * sets `provider.require_parameters` only when `requireParameters:true` is
 * passed (default off). With it off, OpenRouter gracefully drops unsupported
 * params (e.g. `reasoning`) instead of 404ing, so any cheap chat model works
 * even though the config passes reasoning:"low".
 */
async function pickCheapModels(count) {
  try {
    const res = await fetch(`${BASE_URL}/models`)
    if (!res.ok) throw new Error(`models listing ${res.status}`)
    const json = await res.json()
    const list = Array.isArray(json?.data) ? json.data : []
    const ranked = list
      .filter(isUsableChatModel)
      .map((m) => ({ id: m.id, price: priceOf(m) }))
      .filter((m) => Number.isFinite(m.price) && !String(m.id).endsWith(":free"))
      .sort((a, b) => a.price - b.price)
    const slugs = ranked.slice(0, count).map((m) => m.id)
    if (slugs.length >= count) {
      console.log(
        `[live] cheapest models: ${ranked
          .slice(0, count)
          .map((m) => `${m.id} ($${m.price}/tok)`)
          .join(", ")}`,
      )
      return slugs
    }
    console.log("[live] listing yielded too few; using fallback slugs")
    return FALLBACK_SLUGS.slice(0, count)
  } catch (err) {
    console.log(
      `[live] models listing failed (${err?.message ?? err}); using fallback slugs`,
    )
    return FALLBACK_SLUGS.slice(0, count)
  }
}

if (!API_KEY) {
  test("live consensus tests", { skip: "OPENROUTER_API_KEY not set" }, () => {})
  console.log("[live] OPENROUTER_API_KEY not set — skipping all live tests.")
} else {
  // Pick models once, shared across tests (free listing call).
  let cheapPromise = pickCheapModels(2)

  // FREE: no completion tokens, no cost — just the public /models endpoint.
  test("Test 0: listModels returns non-empty array of {id} (FREE)", async () => {
    const models = await listModels({
      baseURL: BASE_URL,
      apiKey: API_KEY,
      search: "claude",
      limit: 5,
    })
    console.log(`[live] listModels matched ${models.length} for "claude"`)
    assert.ok(Array.isArray(models), "returns an array")
    assert.ok(models.length > 0, "non-empty")
    for (const m of models) {
      assert.equal(typeof m.id, "string")
      assert.ok(m.id.length > 0, "id non-empty")
    }
  })

  test("Test 1: single chatComplete returns non-empty content", async () => {
    const [cheapest] = await cheapPromise
    console.log(`[live] Test 1 model: ${cheapest}`)
    const result = await chatComplete({
      provider: PROVIDER,
      apiKey: API_KEY,
      model: cheapest,
      messages: [{ role: "user", content: "Reply with the single word: ping" }],
      maxTokens: 16,
      temperature: 0,
      supportsReasoning: true,
      reasoning: "low",
      reasoningMaxTokens: undefined,
      timeoutMs: 60000,
    })
    console.log(`[live] Test 1 content: ${JSON.stringify(result.content)}`)
    assert.equal(typeof result.content, "string")
    assert.ok(result.content.length > 0, "content should be non-empty")
  })

  test("Test 2: deliberate over a 2-model panel", async () => {
    const [m1, m2] = await cheapPromise
    console.log(`[live] Test 2 panel: main=${m1}, second=${m2}`)
    const config = {
      enabled: true,
      synthesis: "main-judge",
      maxTokens: 64,
      temperature: 0,
      agreementThreshold: 0.6,
      timeoutMs: 60000,
      providers: {
        openrouter: {
          baseURL: BASE_URL,
          apiKeyEnv: "OPENROUTER_API_KEY",
        },
      },
      panel: [
        {
          id: "main",
          provider: "openrouter",
          model: m1,
          reasoning: "low",
          main: true,
        },
        {
          id: "second",
          provider: "openrouter",
          model: m2,
          reasoning: "low",
        },
      ],
    }

    const result = await deliberate(config, "What is 2+2? Answer with just the number.")

    console.log(`[live] consensus: ${JSON.stringify(result.consensus)}`)
    console.log(
      `[live] per-model: ${result.responses
        .map(
          (r) =>
            `${r.member.id}=${r.ok ? "ok" : `FAIL(${r.error})`}` +
            (r.ok ? ` content=${JSON.stringify(r.content)}` : ""),
        )
        .join(" | ")}`,
    )
    console.log(
      `[live] agreement=${result.agreement} override=${result.mainOverrode} main=${result.main} notes=${result.notes}`,
    )

    assert.equal(typeof result.consensus, "string")
    assert.ok(result.consensus.length > 0, "consensus non-empty")
    assert.equal(result.responses.length, 2, "two responses")
    assert.ok(
      result.responses.some((r) => r.ok),
      "at least one response ok",
    )
    assert.equal(result.main, config.panel[0].id, "main == first member id")
    assert.equal(typeof result.agreement, "number")
    assert.ok(
      result.agreement >= 0 && result.agreement <= 1,
      "agreement in [0,1]",
    )
  })
}
