import { tool } from "@opencode-ai/plugin"
import { getMemoryBackend } from "../memory/backend.js"

export const memoryStore = tool({
  description: "Store a session learning in the memory backend (SQLite/Postgres) for future semantic/text recall. No-op with a clear message when memory backend is 'none'.",
  args: {
    content: tool.schema.string().describe("The learning content (one or more sentences)"),
    type: tool.schema.string().optional().describe("Learning type: FAILED_APPROACH|WORKING_SOLUTION|USER_PREFERENCE|CODEBASE_PATTERN|ARCHITECTURAL_DECISION|ERROR_FIX|OPEN_THREAD"),
    context: tool.schema.string().optional().describe("What this learning relates to"),
    tags: tool.schema.array(tool.schema.string()).default([]).describe("Tags for categorization"),
    confidence: tool.schema.string().optional().describe("high|medium|low"),
    session_id: tool.schema.string().optional().describe("Session identifier (defaults to a stable per-session id)"),
    agent_id: tool.schema.string().optional().describe("Agent identifier"),
  },
  async execute(args, context) {
    const backend = await getMemoryBackend(context.directory)
    const res = await backend.store({
      session_id: args.session_id || "opencode",
      agent_id: args.agent_id,
      content: args.content,
      metadata: {
        ...(args.type ? { learning_type: args.type } : {}),
        ...(args.context ? { context: args.context } : {}),
        ...(args.tags.length ? { tags: args.tags } : {}),
        ...(args.confidence ? { confidence: args.confidence } : {}),
      },
    })
    const title = res.stored
      ? (res.skipped ? `Memory skipped (${res.reason})` : `Memory stored (${res.backend})`)
      : `Memory not stored (backend=${res.backend})`
    context.metadata({ title, metadata: { ...res } as any })
    return { title, output: JSON.stringify(res), metadata: { ...res } as any }
  },
})
