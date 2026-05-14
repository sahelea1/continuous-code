import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { createEnforceAgentOnly } from "./hooks/enforce-agent-only.js"
import { createSkillActivation } from "./hooks/skill-activation.js"
import { createCompactionHandoff } from "./hooks/compaction-handoff.js"
import { createSessionStart } from "./hooks/session-start.js"
import { memoryAwareness } from "./hooks/memory-awareness.js"
import { handoffSave } from "./tools/handoff-save.js"
import { handoffLoad } from "./tools/handoff-load.js"
import { ledgerUpdate } from "./tools/ledger-update.js"
import { parallelDelegate } from "./tools/parallel-delegate.js"

const PLUGIN_ID = "opencode-continuous"

const server: Plugin = async (input, _options) => {
  const { client, directory } = input

  const enforceAgentOnly = createEnforceAgentOnly(client)
  const sessionStartHook = createSessionStart(directory)
  const skillActivation = createSkillActivation(directory)
  const compactionHook = createCompactionHandoff(directory)

  return {
    "experimental.chat.system.transform": async (inp, out) => {
      // Inject agent-only instructions (build agent only)
      await enforceAgentOnly!(inp, out)
      // Inject handoff/ledger context on session start
      await sessionStartHook!(inp, out)
    },

    "chat.message": async (inp, out) => {
      // Skill activation based on keyword patterns
      await skillActivation!(inp, out)
      // Memory awareness (stub for v1)
      await memoryAwareness!(inp, out)
    },

    "experimental.session.compacting": compactionHook,

    tool: {
      handoff_save: handoffSave,
      handoff_load: handoffLoad,
      ledger_update: ledgerUpdate,
      parallel_delegate: parallelDelegate,
    },
  }
}

const plugin: PluginModule = {
  id: PLUGIN_ID,
  server,
}

export default plugin
