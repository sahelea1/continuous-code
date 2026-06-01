/**
 * Pure type definitions for the Multi-Model Consensus feature.
 *
 * IMPORTANT: This module (and all of src/consensus/*) MUST NOT import
 * `@opencode-ai/plugin`. It is intended to be unit-testable standalone using
 * only `fs`, `path`, and the global `fetch`.
 */

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"

export interface PanelMember {
  /** Stable short identifier used in output labels (e.g. "opus", "grok"). */
  id: string
  /** Provider key into ConsensusConfig.providers (e.g. "openrouter"). */
  provider: string
  /** Model slug for the provider (e.g. "anthropic/claude-opus-4.6"). */
  model: string
  /** Per-model reasoning effort (only applied for OpenRouter). */
  reasoning?: ReasoningEffort
  /** Optional cap on reasoning tokens (OpenRouter only). */
  reasoningMaxTokens?: number
  /** Exactly one panel member should be the dominant "main" model. */
  main?: boolean
  /** Optional relative weight (reserved for future weighting heuristics). */
  weight?: number
  /** Optional per-model temperature override. */
  temperature?: number
}

export interface ProviderConfig {
  /** OpenAI-compatible base URL (e.g. "https://openrouter.ai/api/v1"). */
  baseURL: string
  /** Environment variable name holding the API key for this provider. */
  apiKeyEnv?: string
}

export interface ConsensusConfig {
  enabled: boolean
  panel: PanelMember[]
  providers: Record<string, ProviderConfig>
  synthesis: "main-judge" | "fusion"
  maxTokens: number
  temperature: number
  agreementThreshold: number
  timeoutMs: number
  /**
   * When true, OpenRouter only routes to endpoints supporting all passed
   * params (e.g. `reasoning`) and fails hard (404) otherwise. When
   * false/undefined (default), unsupported params are dropped gracefully.
   */
  requireParameters?: boolean
}

export interface ModelResponse {
  member: PanelMember
  ok: boolean
  content?: string
  reasoning?: string
  error?: string
  latencyMs: number
  /** The provider-reported finish_reason for this response, if any. */
  finishReason?: string
}

export interface ConsensusResult {
  /** The final combined consensus answer text. */
  consensus: string
  /** The id of the main (dominant) panel member. */
  main: string
  /** Whether the main model overrode dissent in the final answer. */
  mainOverrode: boolean
  /** Agreement score in [0, 1]. */
  agreement: number
  /** Every panel member's individual response. */
  responses: ModelResponse[]
  /** Human-readable notes summarizing the run. */
  notes: string
}
