import { tool } from "@opencode-ai/plugin"
import { readFileSync, readdirSync, existsSync, statSync } from "fs"
import { join } from "path"
import { parse } from "yaml"

export const handoffLoad = tool({
  description: "Load the most recent session handoff, or a specific one by session name",
  args: {
    session_name: tool.schema.string().optional().describe("Session name to load (loads latest if omitted)"),
  },
  async execute(args, context) {
    const handoffsDir = join(context.directory, "thoughts", "shared", "handoffs")

    if (!existsSync(handoffsDir)) {
      return {
        title: "No handoffs found",
        output: "No thoughts/shared/handoffs/ directory exists. No previous handoffs available.",
        metadata: { found: false },
      }
    }

    let targetDir: string | null = null

    if (args.session_name) {
      const specific = join(handoffsDir, args.session_name)
      if (existsSync(specific)) {
        targetDir = specific
      } else {
        return {
          title: "Handoff not found",
          output: `No handoff found for session "${args.session_name}". Available sessions: ${readdirSync(handoffsDir).join(", ")}`,
          metadata: { found: false },
        }
      }
    } else {
      // Find the session with the most recent handoff
      let latestTime = 0
      const sessions = readdirSync(handoffsDir)

      for (const session of sessions) {
        const sessionDir = join(handoffsDir, session)
        const stat = statSync(sessionDir)
        if (!stat.isDirectory()) continue

        const files = readdirSync(sessionDir).filter(f => f.endsWith(".yaml"))
        for (const file of files) {
          const fileStat = statSync(join(sessionDir, file))
          if (fileStat.mtimeMs > latestTime) {
            latestTime = fileStat.mtimeMs
            targetDir = sessionDir
          }
        }
      }
    }

    if (!targetDir) {
      return {
        title: "No handoffs found",
        output: "No handoff files found in thoughts/shared/handoffs/",
        metadata: { found: false },
      }
    }

    // Get the latest YAML file in the target session directory
    const files = readdirSync(targetDir)
      .filter(f => f.endsWith(".yaml"))
      .sort()

    if (files.length === 0) {
      return {
        title: "Empty handoff directory",
        output: `Directory ${targetDir} exists but contains no YAML files.`,
        metadata: { found: false },
      }
    }

    const latestFile = files[files.length - 1]
    const filePath = join(targetDir, latestFile)
    const content = readFileSync(filePath, "utf-8")
    const parsed = parse(content)

    context.metadata({
      title: `Loaded handoff: ${parsed.goal || "unknown"}`,
      metadata: { path: filePath }
    })

    return {
      title: `Handoff: ${parsed.goal || "unknown"}`,
      output: `Loaded from: ${filePath}\n\n${content}`,
      metadata: { path: filePath, found: true, parsed },
    }
  },
})
