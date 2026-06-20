# Architecture

This document explains how `continuous-code` is structured, how its subsystems interact, and what happens from the moment a user sends a message to when results appear. It is the entry point for developers who want to understand, extend, or debug the system.

**Related docs:** [README](../README.md) · [Memory & Recall](memory.md) · [Agents](agents.md) · [Workflows / Ultracode](workflows.md) · [Consensus](usage.md#consensus-mode) · [Install & Config](installation.md)

---

## Table of Contents

- [Two-Layer Design](#two-layer-design)
- [Component Map](#component-map)
- [Plugin Entry Point](#plugin-entry-point)
- [Subsystems](#subsystems)
  - [Orchestration and Agents](#orchestration-and-agents)
  - [Memory](#memory)
  - [Workflows / Ultracode](#workflows--ultracode)
  - [Consensus](#consensus)
  - [Watchdog](#watchdog)
  - [Install and Autoconfig](#install-and-autoconfig)
  - [Hooks](#hooks)
- [Request Lifecycle](#request-lifecycle)
- [Two-Layer Delegation Enforcement](#two-layer-delegation-enforcement)
- [Data Exchange Paths](#data-exchange-paths)
- [Where to Go Next](#where-to-go-next)

---

## Two-Layer Design

`continuous-code` is an **OpenCode plugin** (package name `opencode-continuous`). It never modifies OpenCode's source. Instead it sits entirely above the OpenCode SDK layer, adding:

```
┌────────────────────────────────────────────────────────────┐
│                  OpenCode host process                      │
│  ┌──────────────────────────────────────────────────────┐  │
│  │          continuous-code plugin layer                 │  │
│  │  agents/ · commands/ · src/ · opencode.json          │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │           OpenCode core (untouched)                   │  │
│  │  native build / plan / web UI / LSP / file I/O       │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

OpenCode's native `build` and `plan` primary modes are left **completely stock**. `continuous-code` adds its own default agent (`orchestrator`) and its own agent fleet on top, and never redefines anything OpenCode already provides.

---

## Component Map

The diagram below shows every major component and the primary data flows between them.

```
User prompt
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ OpenCode host                                                        │
│                                                                      │
│  ┌─────────────────┐   system-prompt    ┌──────────────────────┐   │
│  │  Plugin hooks   │──────transform────▶│  orchestrator agent  │   │
│  │                 │                    │  (all tools: deny)   │   │
│  │ enforce-agent   │◀───── agent id ────│  200-step budget     │   │
│  │ memory-aware    │                    └──────────┬───────────┘   │
│  │ compaction      │                               │ task tool      │
│  │ session-start   │                               │ (parallel ok)  │
│  │ skill-activ.    │                               ▼                │
│  │ consensus-mode  │             ┌─────────────────────────────┐   │
│  └─────────────────┘             │      Worker subagents       │   │
│                                  │                             │   │
│  ┌─────────────────┐             │  scout   sleuth  oracle     │   │
│  │  Plugin tools   │◀────────────│  kraken  spark   arbiter    │   │
│  │                 │             │  judge   phoenix  architect  │   │
│  │ memory_store    │             │  plan-agent  scribe         │   │
│  │ memory_recall   │             │  memory-extractor           │   │
│  │ parallel_del.   │             └──────────┬──────────────────┘   │
│  │ ultracode       │                        │                       │
│  │ handoff_save/ld │                        ▼                       │
│  │ ledger_update   │             ┌─────────────────────────────┐   │
│  │ consensus_*     │             │   File system / memory      │   │
│  │ autoconfig_*    │             │                             │   │
│  └─────────────────┘             │  thoughts/shared/handoffs/  │   │
│                                  │  thoughts/ledgers/          │   │
│  ┌─────────────────┐             │  memory.db (sqlite)         │   │
│  │ Workflow engine │             │  memory.json / .env         │   │
│  │ (ultracode)     │             └─────────────────────────────┘   │
│  │                 │                                                │
│  │ WorkflowEngine  │  ┌───────────────┐  ┌──────────────────────┐ │
│  │ ContextStore    │  │  Dashboard    │  │  Terminal UI          │ │
│  │ DriftWatcher    │  │  (Bun HTTP)   │  │  continuous-code-     │ │
│  │ WorkflowRegistry│  │  :7878        │  │  workflow-tui (bin)   │ │
│  │ uiBus (SSE)     │  └───────────────┘  └──────────────────────┘ │
│  └─────────────────┘                                                │
│                                                                      │
│  ┌─────────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Memory backend │  │  Consensus   │  │  Watchdog            │  │
│  │  sqlite/pg/none │  │  multi-model │  │  idle nudge loop     │  │
│  └─────────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Plugin Entry Point

**`src/index.ts`** is the single file OpenCode loads when it discovers the `opencode-continuous` plugin entry in `opencode.json`. It is responsible for wiring together every subsystem:

- Registers all **tools** (memory_store, memory_recall, parallel_delegate, ultracode, handoff_save, handoff_load, ledger_update, consensus_configure, consensus_status, consensus_models, consensus_toggle, consensus_deliberate, autoconfig_inspect, autoconfig_apply).
- Registers all **hooks** (enforce-agent-only, memory-awareness, compaction-handoff, session-start, skill-activation, consensus-mode).
- Passes `context.directory` as the root for all per-project state (memory.json, continuous-code.config.jsonc, thoughts/).

Nothing in `src/index.ts` performs work at load time beyond wiring — backends, watchers, and the dashboard server are all lazy-initialized on first use.

---

## Subsystems

### Orchestration and Agents

The fleet has 22 agents across three tiers.

#### Orchestrators

| Agent | Role | Tools |
|---|---|---|
| `orchestrator` | Default primary agent. Decomposes tasks, spawns subagents, synthesizes results. Never touches files. | All denied (read/edit/write/bash/grep/glob/list/webfetch/websearch) |
| `ultra-orchestrator` | Workflow-DAG variant. Expresses all work as a `WorkflowSpec` passed to the `ultracode` tool. | All denied except `ultracode` |
| `drift-watcher` | Round-robin drift monitor for workflow children. Reads a 40-line snapshot, returns `DriftVerdict` JSON. | All denied; 8-step budget |

#### Worker Fleet

| Agent | Model | Permissions | Primary Use |
|---|---|---|---|
| `scout` | deepseek-v4-flash | read/grep/glob/list/bash | Codebase exploration, file search |
| `kraken` | deepseek-v4-pro | read/edit/write/bash/grep/glob | TDD implementation; checkpoint/resume |
| `spark` | deepseek-v4-flash | read/edit/write/bash | Lightweight quick fixes; escalates to kraken |
| `architect` | deepseek-v4-pro | read-only | Feature and integration design |
| `plan-agent` | deepseek-v4-pro | read-only | Implementation plan generation |
| `sleuth` | deepseek-v4-pro | read-only | Bug investigation, root cause analysis |
| `arbiter` | deepseek-v4-flash | bash/write (no edit) | Test execution and validation |
| `judge` | deepseek-v4-pro | read-only (no bash) | Code review and quality assessment |
| `oracle` | deepseek-v4-pro | read/webfetch/websearch | External research |
| `phoenix` | deepseek-v4-pro | read-only | Refactoring and migration planning |
| `scribe` | deepseek-v4-flash | read/write (no bash/edit) | Handoffs, ledgers, documentation |
| `memory-extractor` | deepseek-v4-flash | read/memory_store tool | Extract learnings from session JSONL |

#### OpenAI Escalation Variants

Seven agents have an `-openai` variant with model `openai/gpt-5.4` at `variant: xhigh`. These are **opt-in** — the orchestrator names them explicitly (e.g., `kraken-openai`) when it needs higher reasoning or a second opinion.

| Variant | Base |
|---|---|
| `kraken-openai` | kraken |
| `judge-openai` | judge |
| `architect-openai` | architect |
| `oracle-openai` | oracle |
| `sleuth-openai` | sleuth |
| `phoenix-openai` | phoenix |
| `plan-agent-openai` | plan-agent |

All `-openai` variants have the same system prompt and permission set as their base counterpart. Only the model and variant differ.

#### Parallel Dispatch

`src/tools/parallel-delegate.ts` provides the `parallel_delegate` tool. It accepts a list of `{agent, prompt, description}` objects and formats them as instructions telling the LLM to issue all `task` tool calls in a **single response**. This lets OpenCode's scheduler run them concurrently rather than sequentially.

---

### Memory

Persistent learning storage across sessions. Implemented in `src/memory/`.

**Backends** (selected at install time via `memory.json`):

| Backend | Storage | When to use |
|---|---|---|
| `sqlite` | `~/.config/opencode/continuous/memory.db` | Default; zero infrastructure |
| `postgres` | pgvector container or CC-v3 server | Opt-in; enables HNSW vector index |
| `none` | — | Explicitly disabled |

The `getMemoryBackend(directory)` factory is process-wide cached and **never throws** — failures degrade silently to `NoneBackend`.

**Recall modes:**

| Mode | Algorithm |
|---|---|
| Embeddings off | BM25 full-text (SQLite FTS5 / PostgreSQL `ts_rank`) |
| Embeddings on | RRF blend of BM25 + cosine vector search (k=60) |

**Deduplication:** before any insert, the backend searches for near-duplicates. In SQLite it scans up to 2000 recent embedded rows in JS using cosine similarity; in Postgres it issues a single `ORDER BY embedding <=> $1::vector LIMIT 1` query. If the best match exceeds `dedupThreshold` (default 0.85) the insert is skipped.

**Memory awareness hook:** `src/hooks/memory-awareness.ts` fires on every `chat.message` output event. It runs a text-only recall (limit 3) and, when results exist, appends a `MEMORY MATCH` block to the model's reply — surfacing past learnings automatically without any explicit recall call.

The two plugin tools exposed to agents:

| Tool | Function |
|---|---|
| `memory_store` | Stores a learning with type, context, tags, and confidence |
| `memory_recall` | Queries the backend; returns ranked results |

See [Memory & Recall](memory.md) for configuration keys, embedding providers, and the CC-v3 isolation model.

---

### Workflows / Ultracode

A declarative multi-agent orchestration engine built on the OpenCode v1 SDK. Entry point: the `ultracode` tool (`src/tools/ultracode.ts`).

#### Core Concepts

**WorkflowSpec** — a JSON structure passed to the `ultracode` tool describing ordered phases, each with a mode and agent nodes.

**Phase modes:**

| Mode | Concurrency model |
|---|---|
| `single` | One agent turn |
| `parallel` | `Promise.allSettled` hard barrier — all agents must complete before the phase advances |
| `pipeline` | Streaming scheduler — item N+1 enters stage 1 as soon as item N exits stage 1; no inter-stage barrier |

**ContextStore** (`src/workflow/context-store.ts`) — per-run, in-memory, content-addressed `Map<label, Artifact>`. Downstream agents reference upstream results with ref strings:

| Ref form | Resolved content |
|---|---|
| `label` | 40-line head/tail summary of the artifact |
| `@full:label` | Full verbatim text (never trimmed from budget) |
| `phase:N` | Summaries of all artifacts from phase N |

Per-agent context is capped at `perAgentContextCapTokens` (default 60k); summaries are dropped oldest-first when over budget; `@full` refs are always protected.

**DriftWatcher** (`src/workflow/drift-watcher.ts`) — an unref-ed `setInterval` (default 90s) that round-robins over active child sessions. Each sweep:

1. Snapshots the last 40 lines of the swept child's most recent assistant text.
2. Hard-truncates the assembled watcher prompt to `driftCapTokens - 5000` (hard max 40k tokens).
3. Runs a fresh `drift-watcher` agent session.
4. Acts on the returned `DriftVerdict`:
   - `drifted: false` → no action
   - `severity: "report"` → blackboard note + nudge the orchestrator session (no abort)
   - `severity: "respawn"` → abort the swept child, re-run the node with `clearerPrompt` appended

Per-node respawn is capped at `maxRespawns` (default 2); after that, detections degrade to `report`. The `verdict.target` field from the LLM is deliberately ignored — the system always acts on the **actually swept child**, preventing hallucinated target IDs from aborting the wrong session.

**Dashboard** (`src/workflow/dashboard.ts`) — a Bun.serve HTTP server (lazy-started on first workflow run; no-ops if Bun is absent).

| Route | Response |
|---|---|
| `GET /` | `assets/workflow-dashboard.html` |
| `GET /events` | SSE stream of `WorkflowEvent` objects |
| `GET /state` | JSON snapshot of the 500-event ring buffer |

The dashboard is **not** embeddable in the OpenCode web UI (CSP blocks iframes; the plugin Hook API exposes no route hook). It is a standalone process on its own port, discovered via a one-time log line in the OpenCode session.

**Terminal UI** — `bin/continuous-code-workflow-tui` (installed via `package.json` bin). A zero-dependency Node/Bun CLI that connects to `GET /state` for seed data and `GET /events` for the SSE stream. Three drill levels: phases list → agents list → agent detail. Navigation: arrow keys + enter/esc + `q` to quit. Color palette: active agents in ANSI 256 color 203 (reddish), done in 114 (green), pending in 95 (muted grey-red), spinner in 215 (gold).

#### Invoking Workflows

Two entry points:

- `/ultracode` slash command (`commands/ultracode.md`) — prompt-injection that instructs the current agent to scope a DAG and call the `ultracode` tool.
- `ultra-orchestrator` agent — select this agent in OpenCode; it autonomously designs `WorkflowSpec` DAGs and routes every substantive task through the `ultracode` tool.

See [Workflows / Ultracode](workflows.md) for the full `WorkflowSpec` schema, config keys, and TUI usage.

---

### Consensus

`src/consensus/` — multi-model consensus: poll a configurable panel of models across providers in parallel, then synthesize one answer.

Key files:

| File | Purpose |
|---|---|
| `src/consensus/config.ts` | Loads `consensus.json`; enforces single-main invariant; merges over `DEFAULT_CONFIG` |
| `src/consensus/types.ts` | `PanelMember`, `ConsensusConfig`, `ModelResponse`, `ConsensusResult` |
| `src/consensus/deliberate.ts` | Orchestrates the parallel poll + synthesis |
| `src/consensus/fusion.ts` | Synthesis strategies |

Managed entirely through the `/consensus` slash command (`commands/consensus.md`) and the `consensus_*` tools — no hand-editing of `consensus.json` is needed.

See [Consensus](usage.md#consensus-mode) for panel configuration, synthesis modes, and provider setup.

---

### Watchdog

`src/watchdog/watchdog.ts` — guards against an idle orchestrator session when background subagents are still running.

- Arms itself on the first `task_spawn` event; disarms when all child IDs are cleared.
- Fires a nudge prompt into the orchestrator session every `intervalMs` (default 20 minutes).
- Hard cap: `maxWakes` (default 6) consecutive nudges per orchestrator session, then stops to prevent infinite loops.
- Requires `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` (set by the shell alias the installer writes).

Controlled by the `watchdog` block in `continuous-code.config.jsonc` or by `OPENCODE_CONTINUOUS_WATCHDOG=0|1` at runtime.

---

### Install and Autoconfig

The install flow is a two-script pipeline.

```
curl | bash
    │
    ▼
bootstrap.sh
  ├─ clone/update prod branch → ~/.local/share/continuous-code
  ├─ seed continuous-code.config.jsonc from example
  └─ exec install.sh
         │
         ▼
    install.sh
      ├─ read continuous-code.config.jsonc (via scripts/jsonc.mjs)
      ├─ npm/bun install + tsc build
      ├─ deploy agents/*.md → ~/.config/opencode/agents/
      ├─ deploy commands/*.md → ~/.config/opencode/commands/
      ├─ write opencode.json (with .bak if existing)
      ├─ write consensus.json
      ├─ create thoughts/ skeleton
      ├─ write memory.json + .env
      ├─ run node dist/autoconfig/cli.js apply  ← headless, no LLM
      └─ append shell alias to ~/.zshrc / ~/.bashrc
```

**Autoconfig** (`src/autoconfig/core.ts` + `src/autoconfig/cli.ts`) runs at install time. It:

1. Reads `~/.local/share/opencode/auth.json` for authenticated provider keys.
2. Calls `opencode models` CLI (8s timeout) to enumerate available models.
3. Runs `planAssignments()` — a deterministic, LLM-free function that picks strong/mid/fast models from the ranked provider list.
4. Writes per-agent `model`/`variant` into `opencode.json`.
5. Falls back to `ollama-cloud/deepseek-v4-pro` for all agents when no provider is authenticated.

Agent tiers used by autoconfig:

| Tier | Agents |
|---|---|
| Orchestrator | `orchestrator` |
| Heavy (deepest reasoning) | `oracle`, `sleuth`, `kraken`, `judge`, `plan-agent`, `phoenix`, `architect`, `general` |
| Light (fast, low-stakes) | `scout`, `spark`, `arbiter`, `scribe`, `memory-extractor`, `explore` |

The `/autoconfagent` slash command (`commands/autoconfagent.md`) re-runs this at any time via the `autoconfig_inspect` → `autoconfig_apply` tools, without touching the shell.

**Postgres isolation:** if the container `continuous-claude-postgres` (CC-v3) is detected on port 5432, the installer reuses that server but creates an isolated `continuous_code` database — it never reads from or writes to CC-v3's `continuous_claude` database. Set `reuseExistingCcV3: false` or `forceStandalone: true` in `continuous-code.config.jsonc` to prevent this.

See [Install & Config](installation.md) for all config keys and installer flags.

---

### Hooks

Six hooks registered by `src/index.ts`. Each hook name corresponds to a file in `src/hooks/`.

| Hook | Trigger | Effect |
|---|---|---|
| `enforce-agent-only` | Every system-prompt transform | Injects delegation table into the `orchestrator`'s context only; all other agents and native `build`/`plan` modes are explicitly bypassed |
| `memory-awareness` | Every `chat.message` output | Runs text-only recall (limit 3); if results exist, appends `MEMORY MATCH` block before the response reaches the user |
| `compaction-handoff` | Context compaction event | Saves a handoff snapshot to `thoughts/shared/handoffs/` before the context is trimmed |
| `session-start` | Session open | Loads any existing handoff and injects it as context |
| `skill-activation` | Tool-use event | Activates skill-specific instructions on relevant tool calls |
| `consensus-mode` | Chat message | Intercepts messages when consensus mode is active and routes to the consensus deliberation pipeline |

---

## Request Lifecycle

This is what happens from the moment a user sends a message to the orchestrator.

```
1. User sends message
       │
       ▼
2. OpenCode dispatches to `orchestrator` (default_agent in opencode.json)
       │
       ▼
3. enforce-agent-only hook fires
   └─ Injects delegation table + agent roster into orchestrator system prompt
       │
       ▼
4. memory-awareness hook fires (on assistant reply output event)
   └─ Runs recall(query, {limit:3, textOnly:true})
   └─ Appends MEMORY MATCH block if results found
       │
       ▼
5. Orchestrator thinks and decomposes task into subtasks
   └─ No tools available — thinking only
       │
       ▼
6. Orchestrator spawns subagents via `task` tool
   ├─ Independent tasks → spawned in parallel (single response, multiple task calls)
   └─ Dependent tasks → spawned sequentially after prerequisites complete
       │
       ▼
7. Worker agents execute
   ├─ Read-only agents (scout, sleuth, oracle, etc.) → return structured markdown reports
   ├─ Write agents (kraken, spark) → mutate files + write handoff to thoughts/shared/handoffs/
   ├─ Test agents (arbiter) → run bash commands, write test reports
   └─ Doc agents (scribe) → write handoffs and ledgers
       │
       ▼
8. Orchestrator receives all worker outputs
   └─ Synthesizes into a coherent user-facing reply
       │
       ▼
9. Session end (optional)
   └─ memory-extractor reads session JSONL → stores learnings via memory_store
   └─ scribe writes final handoff + continuity ledger
```

For **workflow-mode** requests (via `/ultracode` or `ultra-orchestrator`), step 6 becomes a call to the `ultracode` tool with a `WorkflowSpec`, which drives the `WorkflowEngine` instead of ad-hoc `task` calls. The DriftWatcher runs in parallel throughout.

---

## Two-Layer Delegation Enforcement

The orchestrator's "never act directly" constraint is enforced at two independent layers so that neither a misconfigured agent YAML nor a hook bypass can accidentally give it direct tool access.

### Layer 1: Static permission blocks

`agents/orchestrator.md` has a YAML frontmatter permission block with every tool set to `deny`. The same block is mirrored verbatim in the `agent.orchestrator` section of `opencode.json`. These are compiled into OpenCode's permission resolution at session creation time — before any prompt or hook runs.

```yaml
# agents/orchestrator.md (frontmatter)
permission:
  read: deny
  edit: deny
  write: deny
  bash: deny
  grep: deny
  glob: deny
  list: deny
  webfetch: deny
  websearch: deny
```

### Layer 2: Runtime hook injection

`src/hooks/enforce-agent-only.ts` implements an `experimental.chat.system.transform` hook. On every orchestrator session turn it:

1. Detects the agent identity via `input.agent`, `session.agent`, or a `parentID` heuristic.
2. If and only if the agent is `orchestrator`, appends a delegation instruction block to the system prompt naming the correct subagent for each category of work.
3. Returns immediately without mutation for all other agents and for native `build`/`plan` primary modes.

The two layers are independent. If one fails (e.g., a future OpenCode version changes permission resolution), the other still holds.

### What this means in practice

- The orchestrator model literally cannot call read/grep/edit/bash/etc. even if it tries — the permission block will refuse the tool call.
- The hook additionally teaches the model *why* and *what to do instead*, reducing wasted turn budget on failed attempts.
- All subagents are completely unaffected by both layers.

---

## Data Exchange Paths

How the major subsystems hand data to each other:

| From | To | Mechanism |
|---|---|---|
| Orchestrator | Subagents | `task` tool call (text prompt) |
| Subagents | Orchestrator | Final message text (markdown report) |
| `ultracode` tool | `WorkflowEngine` | `WorkflowSpec` JSON + `WorkflowContext` |
| `WorkflowEngine` | `ContextStore` | `putArtifact(label, full)` after each agent turn |
| `ContextStore` | Next agent | `injectionFor(spec)` → `{system, context}` injected into child session prompt |
| `WorkflowEngine` | `uiBus` | `emit(WorkflowEvent)` synchronously on every state change |
| `uiBus` | Dashboard | SSE broadcast; 500-event ring buffer for late joiners |
| `DriftWatcher` | `ContextStore` | `addNote()` on report verdicts; `getNotes()` for blackboard |
| `memory-awareness` hook | User reply | Mutates `output.parts` to append `MEMORY MATCH` block |
| `memory_store` tool | Memory backend | `backend.store(StoreInput)` with optional embedding |
| `memory_recall` tool | Agent | Ranked results with score, type, content |
| Installer | Plugin runtime | `memory.json` + `.env` for backend selection |
| `autoconfig` | `opencode.json` | Writes per-agent `model`/`variant` fields |
| `kraken` / `spark` | Next session | Handoff file at `thoughts/shared/handoffs/<task>/current.md` |
| `scribe` | Ledger | `thoughts/ledgers/CONTINUITY_CLAUDE-<session>.md` |

---

## Where to Go Next

| Topic | Document |
|---|---|
| Install, config keys, installer flags | [Install & Config](installation.md) |
| All 22 agents, permission tables, model assignments | [Agents](agents.md) |
| Memory backends, embeddings, dedup, CC-v3 isolation | [Memory & Recall](memory.md) |
| WorkflowSpec schema, phase modes, dashboard, TUI | [Workflows / Ultracode](workflows.md) |
| Consensus panel setup and synthesis modes | [Consensus](usage.md#consensus-mode) |
| Handoff format, ledger structure, session continuity | [Continuity](usage.md#session-continuity) |
| Back to project root | [README](../README.md) |
