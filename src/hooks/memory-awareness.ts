import type { Hooks } from "@opencode-ai/plugin"
import { existsSync } from "fs"
import { join, resolve } from "path"

/**
 * Stub hook for memory awareness integration.
 *
 * When fully implemented, this will:
 * 1. Run FTS5 queries against the memory database on each user message
 * 2. Optionally use embedding-based semantic search
 * 3. Score results by relevance and inject them into the conversation
 *
 * For v1 this is a no-op that checks for the memory database file.
 * Memory integration will be completed in a future phase.
 */
export const memoryAwareness: Hooks["chat.message"] = async (_input, _output) => {
  const home = process.env.HOME || process.env.USERPROFILE || "~"
  const dbPath = resolve(
    join(home, ".config", "opencode", "continuous", "memory.db"),
  )
  if (!existsSync(dbPath)) return

  // TODO: Implement FTS search against memory.db
  // For v1, this is a stub. Memory integration requires:
  // 1. SQLite FTS5 queries against the memory database
  // 2. Embedding-based semantic search (optional)
  // 3. Relevance scoring and result injection
}
