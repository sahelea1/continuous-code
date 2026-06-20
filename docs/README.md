# continuous-code Docs

continuous-code is a self-contained OpenCode plugin that adds agent-orchestration, persistent memory, multi-model consensus, and session continuity to any OpenCode project.

**Install (one command):**

```bash
curl -fsSL https://raw.githubusercontent.com/sahelea1/continuous-code/prod/bootstrap.sh | bash
```

See [README](../README.md) for the full feature overview and quick-start guide.

---

## Contents

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | How the plugin is structured: plugin entry point, subsystem map, request lifecycle from user prompt to final reply |
| [agents.md](agents.md) | All 22 agents — roles, permissions, models, and when the orchestrator picks each one |
| [memory.md](memory.md) | Persistent memory and recall: backends (SQLite, Postgres, none), embeddings, dedup, RRF search, and the memory-awareness hook |
| [workflows.md](workflows.md) | The ultracode multi-agent workflow engine: WorkflowSpec, phase modes (single/parallel/pipeline), drift-watcher, live dashboard, and terminal UI |
| [installation.md](installation.md) | Installer flags, config keys (`continuous-code.config.jsonc`), memory provisioning, autoconfig, extras, and uninstall |
| [usage.md](usage.md) | Day-to-day usage: slash commands, agent selection, consensus wizard, handoffs, and resume |
