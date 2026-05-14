import { tool } from "@opencode-ai/plugin"

export const parallelDelegate = tool({
  description: "Spawn multiple subagents in parallel and return all their results. Use for /explore and /review workflows.",
  args: {
    tasks: tool.schema.array(
      tool.schema.object({
        agent: tool.schema.string().describe("Subagent name (e.g. 'scout', 'oracle', 'judge')"),
        prompt: tool.schema.string().describe("Task prompt for this subagent"),
        description: tool.schema.string().optional().describe("Short description of this task"),
      })
    ).describe("List of (agent, prompt) pairs to execute in parallel"),
  },
  async execute(args, context) {
    // Note: In OpenCode, the task tool handles subagent invocation.
    // This tool provides a way to express parallel intent.
    // The actual parallelism depends on OpenCode's task scheduling.

    // For now, return the task descriptions formatted for the LLM
    // to issue multiple task tool calls in parallel.
    const taskList = args.tasks.map((t, i) =>
      `### Task ${i + 1}: ${t.description || t.agent}\n- **Agent**: ${t.agent}\n- **Prompt**: ${t.prompt}`
    ).join("\n\n")

    context.metadata({
      title: `Parallel delegation: ${args.tasks.length} tasks`,
      metadata: { count: args.tasks.length, agents: args.tasks.map(t => t.agent) }
    })

    return {
      title: `Parallel delegation: ${args.tasks.length} tasks`,
      output: `Execute these ${args.tasks.length} tasks in parallel using the task tool. Send ALL task tool calls in a single response so they run concurrently:\n\n${taskList}`,
      metadata: { count: args.tasks.length },
    }
  },
})
