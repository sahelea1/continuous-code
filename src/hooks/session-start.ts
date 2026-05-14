import type { Hooks } from "@opencode-ai/plugin"
import { readFileSync, readdirSync, existsSync, statSync } from "fs"
import { join } from "path"

/**
 * Scan the handoffs directory tree and return the most recently modified
 * YAML handoff file, or null if none exist.
 */
function findLatestHandoff(directory: string): string | null {
  const handoffsDir = join(directory, "thoughts", "shared", "handoffs")
  if (!existsSync(handoffsDir)) return null

  let latestFile: string | null = null
  let latestTime = 0

  let sessions: string[]
  try {
    sessions = readdirSync(handoffsDir)
  } catch {
    return null
  }

  for (const session of sessions) {
    const sessionDir = join(handoffsDir, session)
    try {
      const stat = statSync(sessionDir)
      if (!stat.isDirectory()) continue

      const files = readdirSync(sessionDir).filter((f) => f.endsWith(".yaml"))
      for (const file of files) {
        const filePath = join(sessionDir, file)
        const fileStat = statSync(filePath)
        if (fileStat.mtimeMs > latestTime) {
          latestTime = fileStat.mtimeMs
          latestFile = filePath
        }
      }
    } catch {
      continue
    }
  }

  return latestFile
}

/**
 * Find the most recently modified continuity ledger file.
 */
function findLatestLedger(directory: string): string | null {
  const ledgersDir = join(directory, "thoughts", "ledgers")
  if (!existsSync(ledgersDir)) return null

  let files: string[]
  try {
    files = readdirSync(ledgersDir).filter(
      (f) => f.startsWith("CONTINUITY_") && f.endsWith(".md"),
    )
  } catch {
    return null
  }

  if (files.length === 0) return null

  let latestFile: string | null = null
  let latestTime = 0

  for (const file of files) {
    const filePath = join(ledgersDir, file)
    try {
      const stat = statSync(filePath)
      if (stat.mtimeMs > latestTime) {
        latestTime = stat.mtimeMs
        latestFile = filePath
      }
    } catch {
      continue
    }
  }

  return latestFile
}

/**
 * On session start (system prompt transform), inject the latest handoff
 * and continuity ledger into the system prompt so the LLM has prior context.
 */
export function createSessionStart(directory: string): Hooks["experimental.chat.system.transform"] {
  return async (_input, output) => {
    const parts: string[] = []

    // Find and inject latest handoff
    const handoffPath = findLatestHandoff(directory)
    if (handoffPath) {
      try {
        const content = readFileSync(handoffPath, "utf-8")
        parts.push(
          `## Previous Session Handoff\n\nLoaded from: ${handoffPath}\n\n\`\`\`yaml\n${content}\n\`\`\``,
        )
      } catch {
        // Silently skip if file becomes unreadable between discovery and read.
      }
    }

    // Find and inject latest ledger
    const ledgerPath = findLatestLedger(directory)
    if (ledgerPath) {
      try {
        const content = readFileSync(ledgerPath, "utf-8")
        parts.push(
          `## Continuity Ledger\n\nLoaded from: ${ledgerPath}\n\n${content}`,
        )
      } catch {
        // Silently skip.
      }
    }

    if (parts.length > 0) {
      output.system.push(parts.join("\n\n---\n\n"))
    }
  }
}
