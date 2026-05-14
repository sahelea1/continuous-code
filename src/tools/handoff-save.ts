import { tool } from "@opencode-ai/plugin"
import { writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import { stringify } from "yaml"

export const handoffSave = tool({
  description: "Save a session handoff in CC-v3 YAML format to thoughts/shared/handoffs/",
  args: {
    session_name: tool.schema.string().describe("Short slug for this session (e.g. 'auth-middleware')"),
    goal: tool.schema.string().describe("What the session aimed to accomplish"),
    now: tool.schema.string().describe("Current state / what was being worked on"),
    test: tool.schema.string().optional().describe("Command to run tests"),
    done_this_session: tool.schema.array(tool.schema.string()).default([]).describe("Items completed"),
    blockers: tool.schema.array(tool.schema.string()).default([]).describe("Current blockers"),
    questions: tool.schema.array(tool.schema.string()).default([]).describe("Open questions"),
    decisions: tool.schema.array(tool.schema.string()).default([]).describe("Decisions made"),
    findings: tool.schema.array(tool.schema.string()).default([]).describe("Discoveries"),
    worked: tool.schema.array(tool.schema.string()).default([]).describe("Approaches that succeeded"),
    failed: tool.schema.array(tool.schema.string()).default([]).describe("Approaches that didn't work"),
    next: tool.schema.array(tool.schema.string()).default([]).describe("Next steps"),
    files: tool.schema.array(tool.schema.string()).default([]).describe("Files touched"),
  },
  async execute(args, context) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const handoffDir = join(context.directory, "thoughts", "shared", "handoffs", args.session_name)

    if (!existsSync(handoffDir)) {
      mkdirSync(handoffDir, { recursive: true })
    }

    const handoff = {
      goal: args.goal,
      now: args.now,
      test: args.test || "",
      done_this_session: args.done_this_session,
      blockers: args.blockers,
      questions: args.questions,
      decisions: args.decisions,
      findings: args.findings,
      worked: args.worked,
      failed: args.failed,
      next: args.next,
      files: args.files,
    }

    const yamlContent = stringify(handoff)
    const filePath = join(handoffDir, `${timestamp}.yaml`)
    writeFileSync(filePath, yamlContent, "utf-8")

    context.metadata({
      title: `Handoff saved: ${args.session_name}`,
      metadata: { path: filePath }
    })

    return {
      title: `Handoff saved: ${args.session_name}`,
      output: `Handoff written to ${filePath}`,
      metadata: { path: filePath, session_name: args.session_name },
    }
  },
})
