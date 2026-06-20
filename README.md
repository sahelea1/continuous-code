<div align="center">

<img src="assets/logo.svg" alt="continuous-code" width="520">

### Agent-orchestrated, continuity-first development for OpenCode.

A self-contained OpenCode plugin: one delegating **orchestrator**, a fleet of specialist subagents, persistent **memory & recall**, multi-model **consensus**, and a one-command installer that auto-tunes every agent to the providers you actually have.

[![License: MIT](https://img.shields.io/badge/license-MIT-22D3A6.svg)](#license)
[![OpenCode](https://img.shields.io/badge/OpenCode-%E2%89%A5%201.14.0-4F8CFF.svg)](https://opencode.ai)
[![Standalone](https://img.shields.io/badge/install-standalone-7C5CFF.svg)](#quick-start)
[![Memory](https://img.shields.io/badge/memory-sqlite%20%7C%20postgres%20%7C%20none-5B6478.svg)](#memory--recall)

</div>

---

## Quick Start

One command. No prerequisites beyond `git`, `node`, `bash`, and one of `bun` or `npm` — it clones, builds, configures, and auto-tunes models to your host:

```bash
curl -fsSL https://raw.githubusercontent.com/sahelea1/continuous-code/prod/bootstrap.sh | bash
```

That bootstrap clones the repo into `~/.local/share/continuous-code`, seeds an editable
`continuous-code.config.jsonc`, then runs `install.sh` which builds the plugin, deploys the agents
and slash commands, provisions memory, and runs install-time autoconfig.

Prefer to drive it yourself:

```bash
git clone -b prod https://github.com/sahelea1/continuous-code.git
cd continuous-code
cp continuous-code.config.example.jsonc continuous-code.config.jsonc   # optional: edit toggles
./install.sh
opencode                                                              # in any project dir
```

> **Defaults are safe and infra-free.** With no config edits you get: all components on, SQLite
> memory (no database server), no extra services, and install-time model autoconfig. Everything
> heavier is strictly opt-in.

---

## Features

continuous-code adds a complete continuity-and-orchestration layer to OpenCode while leaving the
editor's own modes untouched.

- **Orchestrator-led delegation.** A single project agent, **`orchestrator`** (the default agent),
  decomposes your request and dispatches everything to specialist subagents via the `task` tool. It
  never reads, greps, or edits directly — every action flows through a worker.
- **Native `build` / `plan` stay 100% native.** continuous-code *adds* its own agents and never
  redefines OpenCode's built-in `build` and `plan` modes. Switch to them any time; they behave
  exactly as stock OpenCode.
- **12 specialist subagents** — `arbiter`, `architect`, `judge`, `kraken`, `memory-extractor`,
  `oracle`, `phoenix`, `plan-agent`, `scout`, `scribe`, `sleuth`, `spark` — each scoped to one job
  with least-privilege permissions.
- **7 high-effort `*-openai` variants** — `architect-openai`, `judge-openai`, `kraken-openai`,
  `oracle-openai`, `phoenix-openai`, `plan-agent-openai`, `sleuth-openai` — opt-in escalation for
  the hardest reasoning or a second opinion.
- **Persistent memory & recall.** A real TypeScript-native memory backend (SQLite by default,
  optional Postgres/pgvector, or `none`) stores session learnings and surfaces relevant ones into
  new sessions automatically. Embeddings are opt-in. See [Memory & Recall](#memory--recall).
- **Multi-model consensus.** The orchestrator can form answers by polling a panel of models across
  providers in parallel and synthesizing one consensus result, fully configured through an
  interactive `/consensus` wizard. See [Consensus](#consensus).
- **Session continuity.** YAML handoffs + markdown continuity ledgers persist state across sessions;
  the format is compatible with Continuous-Claude-v3.
- **Install-time autoconfig.** The installer detects which providers are actually authenticated on
  your host and writes the optimal model + reasoning effort for the orchestrator and every worker
  into `opencode.json` — deterministically, no LLM round-trip.
- **Two-layer enforcement.** Frontmatter permissions block direct tool use; a plugin hook rewrites
  the resulting error so the model learns to delegate, scoped to the `orchestrator` only.
- **Opportunistic CC-v3 reuse.** If a Continuous-Claude-v3 Postgres is already running, the
  installer will reuse it for memory (idempotent schema re-apply) — or you can force pure standalone.
- **Editable pre-install config.** A single commented `continuous-code.config.jsonc` controls
  component toggles, memory backend (incl. docker-vs-native Postgres), opt-in extras
  (`tldr`, local embeddings, extra MCP servers), autoconfig, and CC-v3 reuse.
- **10 slash commands** for the common pipelines — fix, build, TDD, explore, review, refactor,
  handoff, resume, consensus, autoconfig.
- **`tsc`-only build, lazy native deps.** No bundler; `better-sqlite3`/`pg` are optional and
  lazy-loaded — if they can't load, memory degrades gracefully to `none` instead of crashing.

---

## Workflows / ultracode

continuous-code ships a **dynamic multi-agent workflow engine** that mirrors Claude Code's `agent()/parallel()/pipeline()/phase()` API, grounded entirely in the OpenCode v1 SDK already in the plugin.

### Switching to workflow mode

**Option 1 — switch agent**: press `←` in OpenCode to open the agent picker and select **`ultra-orchestrator`**. It forces every substantive task through the `ultracode` tool as a structured phase DAG.

**Option 2 — inline command**: in any conversation (any agent), run:

```
/ultracode <your request>
```

This transforms the current turn into workflow mode for that request. The active agent scopes a phase DAG and calls `ultracode`. No agent switch needed.

### What happens when a workflow runs

1. The orchestrator designs a phase DAG (parallel phases, pipeline stages, or sequential) and calls `ultracode` with the spec.
2. The engine spawns real child sessions (`session.create`) and drives each agent turn via `session.prompt` — genuine concurrent fan-out, not an instruction string.
3. A **drift-watcher** subagent round-robins active children every ~90 s, reading only the last ~40 lines each (hard-capped at 40k tokens host-side), and reports or respawns drifted agents.
4. Context flows between agents as **summaries by reference** (verbatim only on explicit `@full`), so 100s of agents never accumulate a growing shared transcript.

### Live dashboard

While a workflow runs, a local web dashboard streams live phase/agent progress:

```
http://localhost:7878
```

It shows phase status (`◯ → ● → ✔`), agent rows (model / tokens / duration), and a drill-down per agent (prompt, last-3 activity, outcome). Reddish theme, animated spinner, no build step — pure HTML/CSS served by `Bun.serve`.

The dashboard is a separate, standalone local server (not embedded in OpenCode's own web UI — OpenCode's plugin API does not currently expose an extension point for that); you'll see a one-time log message with the URL the first time a workflow starts it.

### Terminal UI

Prefer a terminal view over the browser? In another terminal: `continuous-code-workflow-tui` (or
`continuous-code-workflow-tui --port 7878` if you changed the configured port) — a live terminal view
of the active workflow: phases → agents → activity/outcome, arrow keys to navigate, Enter to drill in,
Escape to go back, `q` to quit.

### Config knobs (`continuous-code.config.jsonc`)

| Key | Default | Purpose |
|---|---|---|
| `workflow.enabled` | `true` | Master on/off (env `OPENCODE_CONTINUOUS_WORKFLOW=0` also works) |
| `workflow.dashboardEnabled` | `true` | Start the local web dashboard |
| `workflow.dashboardPort` | `7878` | TCP port for the dashboard |
| `workflow.concurrency` | `0` (auto) | Max concurrent agent sessions; 0 = `min(16, max(2, cores-2))` |
| `workflow.driftEnabled` | `true` | Run the drift-watcher round-robin loop |
| `workflow.driftIntervalMs` | `90000` | Drift-watcher sweep interval (ms) |
| `workflow.driftCapTokens` | `40000` | Hard input cap per drift-watcher sweep (chars/4 estimate) |
| `workflow.perAgentContextCapTokens` | `60000` | Per-agent context injection budget (chars/4 estimate) |
| `workflow.maxAgents` | `1000` | Hard ceiling on agent sessions per workflow run |
| `workflow.storeLearnings` | `false` | Store the synthesized result as a memory learning on completion |

---

## Configuration

Everything pre-install is driven by one file at the repo root:

```bash
cp continuous-code.config.example.jsonc continuous-code.config.jsonc
```

It is **optional** — absent or empty, every value falls to its default and you get a working
minimal install. It is JSONC (`//` and `/* */` comments + trailing commas allowed) and is parsed by
`install.sh` with node (no `jq` needed). The live file is gitignored; the example stays tracked.

| Section | Key highlights | Default |
|---|---|---|
| `components` | Toggle whole subsystems: `agents`, `commands`, `plugin`, `opencodeJson`, `thoughts`, `shellAlias`, `consensus` | all `true` |
| `memory` | `mode: sqlite \| postgres \| none`; for Postgres: `provision: docker \| native \| skip`, db name/user/port, or an explicit `url` | `sqlite` |
| `extras.tldr` | `auto` (use [tldr](https://github.com/sahelea1) if already on PATH) \| `true` (install it) \| `false` | `auto` |
| `extras.localEmbeddings` | install the local embedding stack for offline semantic memory | `false` |
| `extras.mcpServers` | extra MCP servers merged verbatim into `opencode.json` | `{}` |
| `autoconfig` | `enabled`, `prefer` (provider hint), `dryRun`, `fallbackModel` | enabled |
| `reuseExistingCcV3` | reuse a detected Continuous-Claude-v3 Postgres for memory | `true` |
| `forceStandalone` | ignore all CC-v3 reuse + force standalone | `false` |

`install.sh` translates this file into the plugin's runtime config — it writes a project `memory.json`
and/or `.env` with the env vars the plugin reads. **The plugin itself never reads
`continuous-code.config.jsonc`.** Both `continuous-code.config.jsonc`, `memory.json` and `.env` are
gitignored.

Useful install flags: `--symlink` (contributor mode — link instead of copy), `--no-alias`,
`--config <path>`, `--no-autoconfig`, `--dry-run`.

### Install-time autoconfig

When enabled (the default), the installer runs a headless, deterministic selector that:

1. Inspects every provider, its auth status, available models, and reasoning-variant support.
2. Picks models by tier — **orchestrator** gets the strongest reasoning model at the highest effort;
   **heavy** workers get a strong model at `high`; **light** workers get a fast model at `low`.
3. Writes the assignments into `opencode.json` (backing up the previous file to `.bak`).

It assigns **only the project agents** — the `orchestrator` plus the 14 worker agent keys — and
**never** touches native `build`/`plan`. If no provider is authenticated it keeps the committed
`ollama-cloud/*` defaults and prints a hint so the install never fails. You can re-run it any time
with the `/autoconfagent` slash command.

---

## Memory & Recall

A self-contained, TypeScript-native long-term memory store. It records session learnings and pulls
relevant ones back into context on future runs — no external service required by default.

| Backend | When | Storage |
|---|---|---|
| **`sqlite`** (default) | zero-infra default | `~/.config/opencode/continuous/memory.db`, full-text recall via FTS5 |
| **`postgres`** | shared/team or reuse of an existing pgvector db | `archival_memory` table, FTS + optional HNSW vector index |
| **`none`** | disable entirely | no-op store, empty recall |

- **Recall is text-first.** Out of the box, recall uses BM25/FTS — fast, offline, API-key-free.
- **Embeddings are opt-in.** Providers: `none` (default), `voyage`, `openai`, `ollama`, `local`.
  When enabled, store does cosine-similarity dedup and recall blends semantic + text ranking. Against
  a shared `vector(1024)` Postgres only 1024-dim providers (e.g. `voyage`) may be enabled; `openai`
  (1536-dim) is SQLite-only. The installer enforces this.
- **CC-v3 compatible.** The `archival_memory` schema mirrors Continuous-Claude-v3, so an existing
  CC-v3 Postgres satisfies it as-is and can be reused opportunistically.
- **Graceful degradation.** `better-sqlite3` / `pg` are optional, lazy-loaded deps. If a native
  module can't load, memory disables itself with a one-line warning instead of crashing the plugin.

How it surfaces:

- **`memory_store`** tool — persist a learning (`content`, `type`, `context`, `tags`, `confidence`).
- **`memory_recall`** tool — search learnings by text/semantic query.
- **`memory-awareness` hook** — on each message, silently injects a `MEMORY MATCH` block of relevant
  past learnings so the model benefits without being asked.
- **`memory-extractor` agent** — mines a finished session for durable learnings and stores them
  (falling back to writing `thoughts/ledgers/` if the backend is `none`).
- **`compaction-handoff` hook** — best-effort persists session context as a learning when the context
  window compacts.

Runtime config lives in an optional project `memory.json` plus env vars
(`MEMORY_BACKEND`, `MEMORY_DB_PATH`, `MEMORY_POSTGRES_URL`/`CONTINUOUS_CODE_DB_URL`,
`MEMORY_EMBEDDINGS`, `MEMORY_DEDUP_THRESHOLD`, `MEMORY_RECALL_LIMIT`, …) — all written for you by
the installer.

---

## Consensus

An opt-in deliberation layer. When enabled, the orchestrator forms substantive answers by querying a
**panel** of models — across providers, in parallel — and producing one combined answer. Exactly one
panel member is the **main** model: it synthesizes the result, breaks ties, and may override dissent.

- **Single instance, no recursion.** Only the primary orchestrator runs consensus; subagents it
  spawns are ordinary single-model workers and cannot call `consensus_deliberate`.
- **Two synthesis modes.** `main-judge` (client-side fan-out + main-model synthesis, works across
  providers) or `fusion` (native OpenRouter Fusion, all members must be OpenRouter).
- **Cross-provider panels.** Mix OpenRouter and ollama-cloud members, each with its own reasoning
  effort (`none`–`xhigh`).
- **Keys from env only.** Each provider names an `apiKeyEnv` (e.g. `OPENROUTER_API_KEY`); keys are
  never stored in `consensus.json`.

You never hand-edit `consensus.json` — the interactive **`/consensus`** wizard and tools write it for
you. The wizard covers the basics (enable/disable, list/search models, add/remove panel members,
set-main, per-model reasoning, synthesis mode) **and** advanced settings:

| Tool | Purpose |
|---|---|
| `consensus_deliberate` | Get a combined consensus answer from the panel |
| `consensus_status` | Inspect config, panel, and provider-key availability |
| `consensus_toggle` | Enable / disable consensus mode |
| `consensus_configure` | Enable/disable, add/remove members, set main/synthesis/reasoning, plus advanced: `temperature`, `maxTokens`, `agreementThreshold`, `timeoutMs`, `requireParameters`, custom `providers` |
| `consensus_models` | List/search panel-eligible models |

```
/consensus                          # interactive setup
/consensus on | off                 # enable / disable
/consensus add <slug> [reasoning]   # add a panel member
/consensus main <id>                # set the dominant model
/consensus synthesis main-judge|fusion
```

---

## Agents & Commands

continuous-code ships **1 project orchestrator + 12 worker subagents + 7 `*-openai` variants**.
OpenCode's native `build`, `plan`, `general`, and `explore` modes are left to OpenCode and are not
redefined by this project.

### Agents

| Agent | Tier | Role | OpenAI variant |
|---|---|---|---|
| **orchestrator** *(default)* | Orchestrator | Decomposes & delegates all work; never acts directly | — |
| scout | Light | Read files, search code, map structure | — |
| spark | Light | Small one-file fixes / quick edits | — |
| arbiter | Light | Run tests, verify pass/fail | — |
| scribe | Light | Handoffs, ledgers, docs | — |
| memory-extractor | Light | Mine session learnings into memory | — |
| oracle | Heavy | External research & documentation | oracle-openai |
| sleuth | Heavy | Bug investigation, root-cause | sleuth-openai |
| kraken | Heavy | Implementation, TDD loops | kraken-openai |
| judge | Heavy | Code review & quality gate | judge-openai |
| plan-agent | Heavy | Break a feature into a plan | plan-agent-openai |
| phoenix | Heavy | Refactor / migration planning | phoenix-openai |
| architect | Heavy | System & integration design | architect-openai |

The `*-openai` variants run at high reasoning effort and are used only when a standard worker is
insufficient. You never invoke agents directly — the orchestrator dispatches them.

### Slash commands

| Command | Pipeline |
|---|---|
| `/fix` | sleuth investigates → spark/kraken fixes → arbiter verifies → handoff |
| `/build` | architect/plan-agent plans → kraken implements → arbiter tests → judge reviews |
| `/tdd` | plan-agent defines tests → arbiter runs red → kraken goes green → arbiter confirms |
| `/explore` | parallel scouts explore from multiple angles → findings synthesized (uses `tldr` if enabled) |
| `/review` | scout + judge + arbiter review in parallel → unified findings |
| `/refactor` | phoenix plans → kraken implements → judge reviews → arbiter verifies (uses `tldr` if enabled) |
| `/handoff` | scribe writes a YAML handoff + updates the continuity ledger |
| `/resume` | scribe loads the latest handoff → restores context → routes to the right agent |
| `/consensus` | interactive multi-model consensus configuration & control |
| `/autoconfagent` | detect authenticated providers → auto-assign optimal models + effort to the orchestrator and workers |

### Hooks

| Hook | Purpose |
|---|---|
| `enforce-agent-only` | Rewrites denied-tool errors to name the right subagent (scoped to `orchestrator`) |
| `session-start` | Initializes session state & continuity context |
| `skill-activation` | Detects intent keywords and routes to the right pipeline |
| `compaction-handoff` | Auto-saves a handoff (and a best-effort learning) when context compacts |
| `memory-awareness` | Injects relevant past learnings (`MEMORY MATCH`) into each message |
| `consensus-mode` | Injects consensus instructions into the orchestrator when consensus is enabled |

### Custom tools

`handoff_save` · `handoff_load` · `ledger_update` · `parallel_delegate` ·
`memory_store` · `memory_recall` ·
`consensus_deliberate` · `consensus_status` · `consensus_toggle` · `consensus_configure` · `consensus_models` ·
`autoconfig_inspect` · `autoconfig_apply`

---

## Requirements

- **[OpenCode](https://opencode.ai) ≥ 1.14.0**
- **git**, **node ≥ 18**, and **bash**
- **`npm` or `bun`** (the installer uses whichever is present)
- **Docker** — *optional*, only for `memory.mode = postgres` with `provision: docker`
- **No API keys required** for the default setup (SQLite memory, text-only recall, free
  ollama-cloud/Z.AI models). Provider keys are needed only for the providers you choose to use.

The plugin builds with `tsc` only (no bundler). Native memory deps (`better-sqlite3`, `pg`) are
optional and lazy-loaded.

---

## Uninstall

```bash
./uninstall.sh
```

This removes the agent and command files that were installed into `~/.config/opencode/`, and offers
to bring down the standalone Postgres container (`docker compose -f db/docker-compose.yml down`) and
remove the generated `.env`. It does **not** remove:

- `opencode.json` (your project config)
- `thoughts/` (your session data)
- the SQLite memory file at `~/.config/opencode/continuous/memory.db`
- `dist/` (built plugin output)

The installer-added shell alias is not removed automatically — delete the `continuous-code`/`opencode`
alias block from your `~/.bashrc` or `~/.zshrc` if you no longer want it.

---

## License

MIT — see the repository for details. Project home:
[github.com/sahelea1/continuous-code](https://github.com/sahelea1/continuous-code).
