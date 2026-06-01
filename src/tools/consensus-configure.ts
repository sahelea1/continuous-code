import { tool } from "@opencode-ai/plugin"
import {
  loadConsensusConfig,
  saveConsensusConfig,
  upsertPanelMember,
  removePanelMember,
  setMainMember,
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
    "Panel:",
    renderPanel(config),
  ].join("\n")
}

export const consensusConfigure = tool({
  description:
    "Manage multi-model consensus configuration programmatically (no hand-editing files): enable/disable, add/remove panel models, set the main model, synthesis mode, and per-model reasoning effort.",
  args: {
    action: tool.schema
      .string()
      .describe(
        "One of: enable | disable | add | remove | set-main | set-synthesis | set-reasoning | clear",
      ),
    model: tool.schema
      .string()
      .optional()
      .describe("Model slug (for add/remove), e.g. 'anthropic/claude-opus-4.6'"),
    provider: tool.schema
      .string()
      .optional()
      .describe("Provider key (default 'openrouter')"),
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
