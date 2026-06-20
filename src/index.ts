import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { createEnforceAgentOnly } from "./hooks/enforce-agent-only.js"
import { createSkillActivation } from "./hooks/skill-activation.js"
import { createCompactionHandoff } from "./hooks/compaction-handoff.js"
import { createSessionStart } from "./hooks/session-start.js"
import { createMemoryAwareness } from "./hooks/memory-awareness.js"
import { createConsensusMode } from "./hooks/consensus-mode.js"
import { handoffSave } from "./tools/handoff-save.js"
import { handoffLoad } from "./tools/handoff-load.js"
import { ledgerUpdate } from "./tools/ledger-update.js"
import { parallelDelegate } from "./tools/parallel-delegate.js"
import { createConsensusDeliberate } from "./tools/consensus-deliberate.js"
import { consensusStatus } from "./tools/consensus-status.js"
import { consensusToggle } from "./tools/consensus-toggle.js"
import { consensusModels } from "./tools/consensus-models.js"
import { consensusConfigure } from "./tools/consensus-configure.js"
import { autoconfigInspect, autoconfigApply } from "./tools/autoconfig.js"
import { memoryStore } from "./tools/memory-store.js"
import { memoryRecall } from "./tools/memory-recall.js"
import { createWatchdog } from "./watchdog/watchdog.js"

const PLUGIN_ID = "opencode-continuous"

const server: Plugin = async (input, _options) => {
  const { client, directory } = input

  const enforceAgentOnly = createEnforceAgentOnly(client)
  const sessionStartHook = createSessionStart(directory)
  const skillActivation = createSkillActivation(directory)
  const compactionHook = createCompactionHandoff(directory)
  const consensusMode = createConsensusMode(directory, client)
  const consensusDeliberate = createConsensusDeliberate(client)
  const memoryAwarenessHook = createMemoryAwareness(directory)
  const watchdog = createWatchdog(directory, client)

  return {
    // Automatic subagent-watchdog: arm a recurring timer when the orchestrator
    // spawns background subagents; nudge the idle orchestrator if they run long;
    // disarm when all subagents finish. ON BY DEFAULT (see watchdog/config.ts).
    event: async (inp) => {
      await watchdog.onEvent(inp)
    },
    "tool.execute.before": watchdog.onToolBefore,
    "tool.execute.after": watchdog.onToolAfter,

    "experimental.chat.system.transform": async (inp, out) => {
      // Inject agent-only instructions (orchestrator agent only)
      await enforceAgentOnly!(inp, out)
      // Inject handoff/ledger context on session start
      await sessionStartHook!(inp, out)
      // Inject multi-model consensus instructions when enabled (primary agent only)
      await consensusMode!(inp, out)
    },

    "chat.message": async (inp, out) => {
      // Skill activation based on keyword patterns
      await skillActivation!(inp, out)
      // Memory awareness (stub for v1)
      await memoryAwarenessHook!(inp, out)
    },

    "experimental.session.compacting": compactionHook,

    tool: {
      handoff_save: handoffSave,
      handoff_load: handoffLoad,
      ledger_update: ledgerUpdate,
      parallel_delegate: parallelDelegate,
      consensus_deliberate: consensusDeliberate,
      consensus_status: consensusStatus,
      consensus_toggle: consensusToggle,
      consensus_models: consensusModels,
      consensus_configure: consensusConfigure,
      autoconfig_inspect: autoconfigInspect,
      autoconfig_apply: autoconfigApply,
      memory_store: memoryStore,
      memory_recall: memoryRecall,
    },
  }
}

const plugin: PluginModule = {
  id: PLUGIN_ID,
  server,
}

export default plugin
