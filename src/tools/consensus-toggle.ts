import { tool } from "@opencode-ai/plugin"
import { join } from "path"
import { loadConsensusConfig, saveConsensusConfig } from "../consensus/config.js"

export const consensusToggle = tool({
  description:
    "Enable or disable multi-model consensus mode by writing the `enabled` flag to consensus.json. Creates the file from defaults if it does not exist.",
  args: {
    enabled: tool.schema
      .boolean()
      .describe("Whether consensus mode should be enabled (true) or disabled (false)"),
  },
  async execute(args, context) {
    const configPath = join(context.directory, "consensus.json")

    const config = loadConsensusConfig(context.directory)
    config.enabled = args.enabled
    saveConsensusConfig(context.directory, config)

    context.metadata({
      title: `Consensus mode ${args.enabled ? "enabled" : "disabled"}`,
      metadata: { enabled: args.enabled, path: configPath },
    })

    return {
      title: `Consensus mode ${args.enabled ? "enabled" : "disabled"}`,
      output: `Consensus mode is now ${
        args.enabled ? "ENABLED" : "DISABLED"
      }. Wrote enabled=${args.enabled} to ${configPath}.`,
      metadata: { enabled: args.enabled, path: configPath },
    }
  },
})
