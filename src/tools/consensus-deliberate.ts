import { tool } from "@opencode-ai/plugin"
import { loadConsensusConfig, validateForRun } from "../consensus/config.js"
import { deliberate } from "../consensus/deliberate.js"
import { fusionDeliberate } from "../consensus/fusion.js"
import type { ConsensusResult } from "../consensus/types.js"

export const consensusDeliberate = tool({
  description:
    "Get a combined consensus answer from the configured multi-model panel. Use this for any substantive answer, plan, decision, or analysis when consensus mode is enabled.",
  args: {
    prompt: tool.schema
      .string()
      .describe("The request, question, plan, decision, or analysis to deliberate on"),
    context: tool.schema
      .string()
      .optional()
      .describe("Optional supporting context (code, prior findings, constraints) for the panel"),
  },
  async execute(args, context) {
    const config = loadConsensusConfig(context.directory)

    if (!config.enabled) {
      return {
        title: "Consensus mode disabled",
        output:
          "Consensus mode is disabled. Enable it by setting `enabled: true` in consensus.json or by calling the consensus_toggle tool.",
      }
    }

    const validationError = validateForRun(config)
    if (validationError) {
      return {
        title: "Consensus config error",
        output: validationError,
      }
    }

    const allOpenRouter = config.panel.every((m) => m.provider === "openrouter")
    const useFusion = config.synthesis === "fusion" && allOpenRouter

    let result: ConsensusResult
    try {
      result = useFusion
        ? await fusionDeliberate(config, args.prompt)
        : await deliberate(config, args.prompt, { context: args.context })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        title: "Consensus failed",
        output: `Consensus deliberation failed: ${message}`,
      }
    }

    const failed = result.responses.filter((r) => !r.ok).map((r) => r.member.id)
    const modelIds = result.responses.map((r) => r.member.id)
    const perModel = result.responses
      .map((r) => `${r.member.id}=${r.ok ? "ok" : "fail"}`)
      .join(", ")
    const agreementStr = result.agreement.toFixed(2)

    const output =
      result.consensus +
      `\n\n---\n_Consensus panel (main: ${result.main}): ${modelIds.length} models, agreement ${agreementStr}, override ${
        result.mainOverrode ? "yes" : "no"
      }._\n_Per-model: ${perModel}._`

    context.metadata({
      title: `Consensus (${modelIds.length} models, agreement ${agreementStr})`,
      metadata: {
        agreement: result.agreement,
        main: result.main,
        mainOverrode: result.mainOverrode,
        models: modelIds,
        failed,
      },
    })

    return {
      title: `Consensus (${modelIds.length} models, agreement ${agreementStr})`,
      output,
      metadata: {
        agreement: result.agreement,
        main: result.main,
        mainOverrode: result.mainOverrode,
        models: modelIds,
        failed,
      },
    }
  },
})
