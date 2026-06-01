import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { loadConsensusConfig } from "../consensus/config.js"

/**
 * Injects multi-model consensus instructions into the PRIMARY (orchestrator)
 * agent's system prompt when consensus mode is enabled.
 *
 * Mirrors enforce-agent-only.ts: gated to the primary agent only (child/
 * sub-agent sessions, identified by parentID, are skipped). When consensus
 * mode is disabled this hook injects nothing.
 */
export function createConsensusMode(
  directory: string,
  client: PluginInput["client"],
): Hooks["experimental.chat.system.transform"] {
  return async (input, output) => {
    // Gate: only inject for the primary (orchestrator) agent.
    if (input.sessionID) {
      try {
        const result = await client.session.get({
          path: { id: input.sessionID },
        })
        if (result.data && result.data.parentID) {
          return
        }
      } catch {
        // If session lookup fails, fall through and inject anyway.
      }
    }

    const config = loadConsensusConfig(directory)
    if (!config.enabled) return

    const main = config.panel.find((m) => m.main)
    const panelLines = config.panel
      .map((m) => {
        const reasoning = m.reasoning ?? "none"
        const mainTag = m.main ? " — MAIN (dominant, tie-breaker)" : ""
        return `- \`${m.id}\`: ${m.provider}/${m.model} (reasoning: ${reasoning})${mainTag}`
      })
      .join("\n")

    output.system.push(`
## Multi-Model Consensus Mode (ACTIVE)

Your substantive answers must represent the **combined judgment of the panel**, not a single model's perspective. To form any substantive answer, plan, decision, or analysis you MUST call the \`consensus_deliberate\` tool and base your reply on the consensus it returns.

The panel runs multiple models in parallel (across providers) and produces ONE combined answer. Synthesis mode: \`${config.synthesis}\`.

### Panel
${panelLines}

The MAIN model${main ? ` (\`${main.id}\`)` : ""} is dominant: it breaks ties and MAY override dissent (minority or even majority) when it judges that correct.

### Execution constraint
You may ONLY think, spawn/monitor/manage subagents, manage clients, and read files yourself. ALL other tool usage and ALL file edits MUST be delegated to subagents via the \`task\` tool.

### Inspection / control
Use \`consensus_status\` to inspect the current panel and provider key availability, and \`consensus_toggle\` to enable/disable consensus mode.
`)
  }
}
