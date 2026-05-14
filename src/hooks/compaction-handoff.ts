import type { Hooks } from "@opencode-ai/plugin"
import { writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import { stringify } from "yaml"

/**
 * When OpenCode compacts a session, this hook saves a YAML handoff file
 * so that context survives across compaction boundaries.
 *
 * The handoff follows the CC-v3 format defined in RESEARCH.md section 6.
 * Location: thoughts/shared/handoffs/<session-slug>/<ISO-timestamp>.yaml
 */
export function createCompactionHandoff(directory: string): Hooks["experimental.session.compacting"] {
  return async (input, output) => {
    const sessionSlug = input.sessionID.slice(0, 12)
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const handoffDir = join(directory, "thoughts", "shared", "handoffs", sessionSlug)

    if (!existsSync(handoffDir)) {
      mkdirSync(handoffDir, { recursive: true })
    }

    // Build handoff from compaction context.
    // output.context contains strings that other hooks/the system have added;
    // we capture them as a rough record of what was done this session.
    const handoff = {
      goal: "Session compacted -- see context below for details",
      now: "Context was compacted to free up token space",
      test: "",
      done_this_session: output.context.slice(0, 10),
      blockers: [] as string[],
      questions: [] as string[],
      decisions: [] as string[],
      findings: [] as string[],
      worked: [] as string[],
      failed: [] as string[],
      next: ["Continue from where compaction occurred"],
      files: [] as string[],
    }

    const yamlContent = stringify(handoff)
    const handoffPath = join(handoffDir, `${timestamp}.yaml`)
    writeFileSync(handoffPath, yamlContent, "utf-8")

    // Append a continuation note into the compaction context so the LLM
    // knows a handoff was persisted.
    output.context.push(`A handoff was saved to ${handoffPath}. Continue from where you left off.`)
  }
}
