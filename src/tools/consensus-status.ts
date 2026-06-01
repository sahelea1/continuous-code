import { tool } from "@opencode-ai/plugin"
import { loadConsensusConfig } from "../consensus/config.js"

export const consensusStatus = tool({
  description:
    "Show the current multi-model consensus configuration: enabled state, synthesis mode, the panel, the main model, and which provider API keys are present in the environment (never the key values).",
  args: {},
  async execute(_args, context) {
    const config = loadConsensusConfig(context.directory)

    const lines: string[] = []
    lines.push(`Enabled: ${config.enabled ? "yes" : "no"}`)
    lines.push(`Synthesis mode: ${config.synthesis}`)
    lines.push(
      `Limits: maxTokens=${config.maxTokens}, temperature=${config.temperature}, timeoutMs=${config.timeoutMs}, agreementThreshold=${config.agreementThreshold}`,
    )

    const main = config.panel.find((m) => m.main)
    lines.push(`Main model: ${main ? `${main.id} (${main.provider}/${main.model})` : "(none — panel empty)"}`)

    lines.push("")
    lines.push("Panel:")
    if (config.panel.length === 0) {
      lines.push("  (empty — add models to the `panel` array in consensus.json)")
    } else {
      for (const m of config.panel) {
        const flags = [
          m.main ? "MAIN" : null,
          m.reasoning ? `reasoning=${m.reasoning}` : "reasoning=none",
        ]
          .filter(Boolean)
          .join(", ")
        lines.push(`  - ${m.id}: ${m.provider}/${m.model} [${flags}]`)
      }
    }

    lines.push("")
    lines.push("Provider API keys:")
    for (const [name, provider] of Object.entries(config.providers)) {
      if (!provider.apiKeyEnv) {
        lines.push(`  - ${name}: no apiKeyEnv configured`)
        continue
      }
      const present = !!process.env[provider.apiKeyEnv]
      lines.push(`  - ${name}: ${provider.apiKeyEnv} ${present ? "set" : "missing"}`)
    }

    const output = lines.join("\n")

    context.metadata({
      title: `Consensus status: ${config.enabled ? "enabled" : "disabled"}`,
      metadata: {
        enabled: config.enabled,
        synthesis: config.synthesis,
        panelSize: config.panel.length,
        main: main?.id,
      },
    })

    return {
      title: `Consensus status: ${config.enabled ? "enabled" : "disabled"}`,
      output,
    }
  },
})
