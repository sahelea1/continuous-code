import { tool } from "@opencode-ai/plugin"
import { getMemoryBackend } from "../memory/backend.js"

export const memoryRecall = tool({
  description: "Recall relevant session learnings from the memory backend by text/semantic search. Returns [] when backend is 'none' or empty.",
  args: {
    query: tool.schema.string().describe("Search query / current task keywords"),
    limit: tool.schema.number().default(5).describe("Max results"),
    text_only: tool.schema.boolean().optional().describe("Force text-only (BM25/FTS) search"),
  },
  async execute(args, context) {
    const backend = await getMemoryBackend(context.directory)
    const results = await backend.recall(args.query, { limit: args.limit, textOnly: args.text_only })
    const lines = results.map((r, i) =>
      `${i + 1}. [${(r.metadata as any)?.learning_type ?? "learning"} | score ${r.score.toFixed(3)}] ${r.content}`)
    const output = results.length ? lines.join("\n") : "No relevant memories found."
    context.metadata({ title: `Recall: ${results.length} result(s)`, metadata: { count: results.length } })
    return { title: `Recall: ${results.length} result(s)`, output, metadata: { count: results.length, results } as any }
  },
})
