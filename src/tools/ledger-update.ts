import { tool } from "@opencode-ai/plugin"
import { writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"

export const ledgerUpdate = tool({
  description: "Create or update a continuity ledger at thoughts/ledgers/CONTINUITY_<topic>.md",
  args: {
    topic: tool.schema.string().describe("Topic name for the ledger (e.g. 'auth-system')"),
    goal: tool.schema.string().describe("The overall goal"),
    completed: tool.schema.array(tool.schema.string()).default([]).describe("Completed items"),
    in_progress: tool.schema.array(tool.schema.string()).default([]).describe("In-progress items"),
    blockers: tool.schema.array(tool.schema.string()).default([]).describe("Current blockers"),
  },
  async execute(args, context) {
    const ledgersDir = join(context.directory, "thoughts", "ledgers")

    if (!existsSync(ledgersDir)) {
      mkdirSync(ledgersDir, { recursive: true })
    }

    const slug = args.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    const filePath = join(ledgersDir, `CONTINUITY_${slug}.md`)
    const now = new Date().toISOString()

    const content = [
      `# Session: ${args.topic}`,
      `Updated: ${now}`,
      "",
      "## Goal",
      args.goal,
      "",
      "## Completed",
      ...args.completed.map(item => `- [x] ${item}`),
      "",
      "## In Progress",
      ...args.in_progress.map(item => `- [ ] ${item}`),
      "",
      "## Blockers",
      ...(args.blockers.length > 0 ? args.blockers.map(item => `- ${item}`) : ["- None"]),
      "",
    ].join("\n")

    writeFileSync(filePath, content, "utf-8")

    context.metadata({
      title: `Ledger updated: ${args.topic}`,
      metadata: { path: filePath }
    })

    return {
      title: `Ledger: ${args.topic}`,
      output: `Continuity ledger written to ${filePath}`,
      metadata: { path: filePath },
    }
  },
})
