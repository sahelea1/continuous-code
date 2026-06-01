import { tool } from "@opencode-ai/plugin"
import { loadConsensusConfig, resolveApiKey } from "../consensus/config.js"
import { listModels } from "../consensus/models.js"

/** Format a per-Mtok price label from a per-token price. */
function pricePerMtok(perToken?: number): string {
  if (perToken === undefined) return "?"
  const perM = perToken * 1_000_000
  // Trim trailing zeros for readability.
  return `$${Number(perM.toFixed(4))}`
}

export const consensusModels = tool({
  description:
    "List/search AI models available for the consensus panel (from the configured providers, e.g. OpenRouter).",
  args: {
    search: tool.schema
      .string()
      .optional()
      .describe("Case-insensitive substring filter on model slug/name (e.g. 'claude', 'grok')"),
    limit: tool.schema
      .number()
      .optional()
      .describe("Maximum number of models to return (default 30)"),
  },
  async execute(args, context) {
    const config = loadConsensusConfig(context.directory)
    const provider = config.providers["openrouter"]
    if (!provider) {
      return {
        title: "No openrouter provider configured",
        output:
          "No `openrouter` provider is configured in consensus.json. Known providers: " +
          Object.keys(config.providers).join(", "),
      }
    }

    const apiKey = resolveApiKey(provider)
    const limit = typeof args.limit === "number" ? args.limit : 30

    let models
    try {
      models = await listModels({
        baseURL: provider.baseURL,
        apiKey,
        search: args.search,
        limit,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        title: "Model listing failed",
        output: `Could not list models from ${provider.baseURL}: ${message}`,
      }
    }

    if (models.length === 0) {
      return {
        title: "No models found",
        output: args.search
          ? `No models matched "${args.search}".`
          : "No models returned by the provider.",
      }
    }

    const lines = models.map((m) => {
      const prompt = pricePerMtok(m.promptPrice)
      const completion = pricePerMtok(m.completionPrice)
      const ctx = m.contextLength ? `ctx ${m.contextLength}` : "ctx ?"
      const reasoning = m.supportsReasoning ? "reasoning:yes" : "reasoning:no"
      return `${m.id} — ${prompt}/${completion} per Mtok — ${ctx} — ${reasoning}`
    })

    const output =
      lines.join("\n") +
      `\n\nTo add one to the panel: \`consensus_configure action=add model=<slug>\`` +
      ` (optionally \`reasoning=<none|minimal|low|medium|high|xhigh>\`).`

    context.metadata({
      title: `Models (${models.length})`,
      metadata: { count: models.length, search: args.search ?? null },
    })

    return {
      title: `Models (${models.length})${args.search ? ` matching "${args.search}"` : ""}`,
      output,
    }
  },
})
