import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { DEFAULT_CONFIG } from "../consensus/config.js"
import type { ConsensusConfig } from "../consensus/types.js"

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

    let config: ConsensusConfig
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, "utf-8")) as ConsensusConfig
      } catch {
        // Start from defaults (which contain only plain data, no functions).
        config = { ...DEFAULT_CONFIG, panel: [...DEFAULT_CONFIG.panel] }
      }
    } else {
      config = { ...DEFAULT_CONFIG, panel: [...DEFAULT_CONFIG.panel] }
    }

    config.enabled = args.enabled
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8")

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
