import { tool } from "@opencode-ai/plugin"
import {
  loadConsensusConfig,
  saveConsensusConfig,
  upsertPanelMember,
  removePanelMember,
  setMainMember,
  setTemperature,
  setMaxTokens,
  setAgreementThreshold,
  setTimeoutMs,
  setRequireParameters,
  upsertProvider,
} from "../consensus/config.js"
import type { ConsensusConfig, ReasoningEffort } from "../consensus/types.js"

const ACTIONS = [
  "enable",
  "disable",
  "add",
  "remove",
  "set-main",
  "set-synthesis",
  "set-reasoning",
  "clear",
  "set-temperature",
  "set-max-tokens",
  "set-agreement-threshold",
  "set-timeout",
  "set-require-parameters",
  "set-provider",
] as const

const REASONING_VALUES: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]

/** Render the current panel as human-readable lines. */
function renderPanel(config: ConsensusConfig): string {
  if (config.panel.length === 0) return "  (empty)"
  return config.panel
    .map((m) => {
      const reasoning = m.reasoning ?? "none"
      const mainTag = m.main ? " [MAIN]" : ""
      return `  - ${m.id}: ${m.provider}/${m.model} (reasoning: ${reasoning})${mainTag}`
    })
    .join("\n")
}

/** Build a result summary including the resulting state. */
function summarize(config: ConsensusConfig, action: string): string {
  return [
    `Action: ${action}`,
    `Enabled: ${config.enabled ? "yes" : "no"}`,
    `Synthesis: ${config.synthesis}`,
    `Temperature: ${config.temperature}`,
    `Max tokens: ${config.maxTokens}`,
    `Agreement threshold: ${config.agreementThreshold}`,
    `Timeout: ${config.timeoutMs}ms`,
    `Require parameters: ${config.requireParameters ? "yes" : "no"}`,
    "Panel:",
    renderPanel(config),
  ].join("\n")
}

export const consensusConfigure = tool({
  description:
    "Manage multi-model consensus configuration programmatically (no hand-editing files): enable/disable, add/remove panel models, set the main model, synthesis mode, per-model reasoning effort, and advanced settings (temperature, maxTokens, agreementThreshold, timeoutMs, requireParameters, custom providers).",
  args: {
    action: tool.schema
      .string()
      .describe(
        "One of: enable | disable | add | remove | set-main | set-synthesis | set-reasoning | clear | set-temperature | set-max-tokens | set-agreement-threshold | set-timeout | set-require-parameters | set-provider",
      ),
    model: tool.schema
      .string()
      .optional()
      .describe("Model slug (for add/remove), e.g. 'anthropic/claude-opus-4.6'"),
    provider: tool.schema
      .string()
      .optional()
      .describe("Provider key (for add: default 'openrouter'; for set-provider: the key to add/update)"),
    id: tool.schema
      .string()
      .optional()
      .describe("Panel member id (for remove/set-main/set-reasoning)"),
    reasoning: tool.schema
      .string()
      .optional()
      .describe("Reasoning effort: none|minimal|low|medium|high|xhigh"),
    synthesis: tool.schema
      .string()
      .optional()
      .describe("Synthesis mode: main-judge | fusion"),
    value: tool.schema
      .number()
      .optional()
      .describe(
        "Numeric value for set-temperature (0–2), set-max-tokens (positive int), set-agreement-threshold (0–1), or set-timeout (positive int ms).",
      ),
    enabled: tool.schema
      .boolean()
      .optional()
      .describe("Boolean flag for set-require-parameters (true|false)."),
    baseURL: tool.schema
      .string()
      .optional()
      .describe("Base URL for set-provider (required when adding a new provider)."),
    apiKeyEnv: tool.schema
      .string()
      .optional()
      .describe("Env var name holding the API key for set-provider."),
  },
  async execute(args, context) {
    const action = (args.action ?? "").trim()
    if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
      return {
        title: "Unknown action",
        output: `Unknown action '${args.action}'. Valid actions: ${ACTIONS.join(", ")}.`,
      }
    }

    // Validate reasoning value up front when provided.
    if (
      args.reasoning !== undefined &&
      !REASONING_VALUES.includes(args.reasoning as ReasoningEffort)
    ) {
      return {
        title: "Invalid reasoning value",
        output: `Invalid reasoning '${args.reasoning}'. Allowed: ${REASONING_VALUES.join(", ")}.`,
      }
    }

    let config = loadConsensusConfig(context.directory)

    switch (action) {
      case "enable":
        config.enabled = true
        break

      case "disable":
        config.enabled = false
        break

      case "add": {
        if (!args.model) {
          return {
            title: "Missing model",
            output: "`add` requires a `model` slug.",
          }
        }
        const provider = args.provider ?? "openrouter"
        if (!config.providers[provider]) {
          return {
            title: "Unknown provider",
            output: `Unknown provider '${provider}'. Known providers: ${Object.keys(
              config.providers,
            ).join(", ")}.`,
          }
        }
        config = upsertPanelMember(config, {
          id: args.id ?? "",
          provider,
          model: args.model,
          reasoning: args.reasoning as ReasoningEffort | undefined,
        })
        break
      }

      case "remove": {
        const idOrModel = args.id ?? args.model
        if (!idOrModel) {
          return {
            title: "Missing id/model",
            output: "`remove` requires an `id` or a `model` slug.",
          }
        }
        config = removePanelMember(config, idOrModel)
        break
      }

      case "set-main": {
        if (!args.id) {
          return {
            title: "Missing id",
            output: "`set-main` requires an `id`.",
          }
        }
        try {
          config = setMainMember(config, args.id)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return {
            title: "Member not found",
            output: `${message} Current panel:\n${renderPanel(config)}`,
          }
        }
        break
      }

      case "set-synthesis": {
        if (args.synthesis !== "main-judge" && args.synthesis !== "fusion") {
          return {
            title: "Invalid synthesis",
            output: "`set-synthesis` requires `synthesis` to be 'main-judge' or 'fusion'.",
          }
        }
        config.synthesis = args.synthesis
        break
      }

      case "set-reasoning": {
        if (!args.id || args.reasoning === undefined) {
          return {
            title: "Missing id/reasoning",
            output: "`set-reasoning` requires both `id` and `reasoning`.",
          }
        }
        const idx = config.panel.findIndex((m) => m.id === args.id)
        if (idx < 0) {
          return {
            title: "Member not found",
            output: `No panel member with id '${args.id}'. Current panel:\n${renderPanel(config)}`,
          }
        }
        config.panel[idx] = {
          ...config.panel[idx],
          reasoning: args.reasoning as ReasoningEffort,
        }
        break
      }

      case "clear":
        config.panel = []
        break

      case "set-temperature": {
        if (args.value === undefined) {
          return {
            title: "Missing value",
            output: "`set-temperature` requires a numeric `value` in [0, 2].",
          }
        }
        try {
          config = setTemperature(config, args.value)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return { title: "Invalid temperature", output: message }
        }
        break
      }

      case "set-max-tokens": {
        if (args.value === undefined) {
          return {
            title: "Missing value",
            output: "`set-max-tokens` requires a positive integer `value`.",
          }
        }
        try {
          config = setMaxTokens(config, args.value)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return { title: "Invalid maxTokens", output: message }
        }
        break
      }

      case "set-agreement-threshold": {
        if (args.value === undefined) {
          return {
            title: "Missing value",
            output: "`set-agreement-threshold` requires a numeric `value` in [0, 1].",
          }
        }
        try {
          config = setAgreementThreshold(config, args.value)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return { title: "Invalid agreementThreshold", output: message }
        }
        break
      }

      case "set-timeout": {
        if (args.value === undefined) {
          return {
            title: "Missing value",
            output: "`set-timeout` requires a positive integer `value` (milliseconds).",
          }
        }
        try {
          config = setTimeoutMs(config, args.value)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return { title: "Invalid timeoutMs", output: message }
        }
        break
      }

      case "set-require-parameters": {
        if (args.enabled === undefined) {
          return {
            title: "Missing enabled",
            output: "`set-require-parameters` requires a boolean `enabled` flag.",
          }
        }
        config = setRequireParameters(config, args.enabled)
        break
      }

      case "set-provider": {
        const providerKey = args.provider
        if (!providerKey) {
          return {
            title: "Missing provider",
            output: "`set-provider` requires a `provider` key.",
          }
        }
        try {
          config = upsertProvider(config, providerKey, {
            baseURL: args.baseURL,
            apiKeyEnv: args.apiKeyEnv,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return { title: "Provider error", output: message }
        }
        break
      }
    }

    saveConsensusConfig(context.directory, config)

    const main = config.panel.find((m) => m.main)
    context.metadata({
      title: `Consensus configured: ${action}`,
      metadata: {
        action,
        enabled: config.enabled,
        synthesis: config.synthesis,
        panelSize: config.panel.length,
        main: main?.id,
      },
    })

    return {
      title: `Consensus configured: ${action}`,
      output: summarize(config, action),
    }
  },
})
