import type { Hooks, PluginInput } from "@opencode-ai/plugin"

/**
 * Injects agent-only orchestration instructions into the build agent's system prompt.
 *
 * The build agent's permission block in opencode.json already denies direct tool use
 * (read, grep, glob, bash, etc.). This hook supplements that enforcement by telling
 * the LLM *why* those tools are denied and which subagent to delegate to instead.
 *
 * IMPORTANT: This only injects into the build (primary) agent's system prompt.
 * Subagents like scout, kraken, oracle etc. are expected to use tools directly.
 */
export function createEnforceAgentOnly(
  client: PluginInput["client"],
): Hooks["experimental.chat.system.transform"] {
  return async (input, output) => {
    // Gate: only inject for the primary (build) agent.
    // When sessionID is available, resolve the current agent.
    if (input.sessionID) {
      try {
        const result = await client.session.get({
          path: { id: input.sessionID },
        })
        // Session type does not carry an agent field in the current SDK.
        // Skip injection for child (sub-agent) sessions identified by parentID.
        if (result.data && result.data.parentID) {
          return
        }
      } catch {
        // If session lookup fails, fall through and inject anyway.
        // Better to over-instruct than to silently skip.
      }
    }

    output.system.push(`
## Agent-Only Execution Model

You are the orchestrator. You MUST NOT use tools directly. Instead, delegate ALL work to specialized subagents via the \`task\` tool:

| Task | Subagent |
|------|----------|
| Read files, search code, explore structure | scout |
| External research, docs, web | oracle |
| Bug investigation | sleuth |
| Implementation (TDD) | kraken |
| Quick fixes | spark |
| Run/write tests | arbiter |
| Code review | judge |
| Plan implementation | plan-agent |
| Plan refactoring | phoenix |
| Design architecture | architect |
| Write handoffs/docs | scribe |
| Extract learnings | memory-extractor |

If you try to use read, grep, glob, bash, edit, write, webfetch, or websearch directly, the permission system will deny your request. Use the task tool to delegate to the appropriate subagent.

For parallel work, use the parallel_delegate tool to spawn multiple subagents simultaneously.
`)
  }
}
