import type { Hooks, PluginInput } from "@opencode-ai/plugin"

/**
 * Injects agent-only orchestration instructions into the orchestrator agent's
 * system prompt.
 *
 * The orchestrator agent's permission block in opencode.json already denies direct
 * tool use (read, grep, glob, bash, etc.). This hook supplements that enforcement by
 * telling the LLM *why* those tools are denied and which subagent to delegate to
 * instead.
 *
 * IMPORTANT: This MUST only inject into the project's `orchestrator` agent. The
 * native OpenCode `build`/`plan` primary modes are left 100% untouched (reconciliation
 * R10) — they must keep their stock behavior, so they must NOT receive these
 * orchestration-only instructions. Subagents like scout, kraken, oracle etc. are
 * expected to use tools directly and are likewise skipped.
 */
export function createEnforceAgentOnly(
  client: PluginInput["client"],
): Hooks["experimental.chat.system.transform"] {
  return async (input, output) => {
    // Gate: only inject for the project's `orchestrator` agent.
    //
    // Prefer gating on the active agent name when the SDK exposes it (either on the
    // hook input directly or on the resolved session). This keeps native build/plan
    // and every other agent unaffected.
    const inputAgent = (input as { agent?: unknown }).agent
    const inputAgentName =
      typeof inputAgent === "string"
        ? inputAgent
        : (inputAgent as { name?: string } | undefined)?.name

    if (typeof inputAgentName === "string") {
      // Agent name is available directly on the input — authoritative gate.
      if (inputAgentName !== "orchestrator") {
        return
      }
    } else if (input.sessionID) {
      try {
        const result = await client.session.get({
          path: { id: input.sessionID },
        })
        const sessionData = result.data as
          | { parentID?: string; agent?: string }
          | undefined
        const sessionAgent = sessionData?.agent
        if (typeof sessionAgent === "string") {
          // Session carries an agent name — authoritative gate.
          if (sessionAgent !== "orchestrator") {
            return
          }
        } else if (sessionData?.parentID) {
          // LIMITATION: neither the hook input nor the session object exposes the
          // active agent name in this SDK version, so we cannot positively confirm
          // the `orchestrator` agent. Fall back to the parentID heuristic: skip
          // child (sub-agent) sessions and inject for primary sessions. Native
          // build/plan cannot be distinguished from orchestrator in this branch;
          // the opencode.json permission block remains the hard enforcement layer.
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
