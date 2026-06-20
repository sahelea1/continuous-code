import type { Hooks } from "@opencode-ai/plugin"
import { getMemoryBackend } from "../memory/backend.js"

export function createMemoryAwareness(directory: string): Hooks["chat.message"] {
  return async (_input, output) => {
    const query = output.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text || "")
      .join(" ").trim()
    if (!query) return
    let results
    try {
      const backend = await getMemoryBackend(directory)
      if (backend.kind === "none") return
      results = await backend.recall(query, { limit: 3, textOnly: true })
    } catch { return }
    if (!results || results.length === 0) return
    const lines = results.map((r) => {
      const t = (r.metadata as any)?.learning_type ?? "learning"
      const c = r.content.length > 200 ? r.content.slice(0, 197) + "..." : r.content
      return `  -> [${t}] ${c}`
    })
    const block = ["---", `MEMORY MATCH (${results.length} from past sessions)`, "---",
      ...lines, "ACTION: If relevant, use `memory_recall` for full context before proceeding.", "---"].join("\n")
    output.parts.push({ type: "text", text: "\n\n" + block } as any)
  }
}
