# Workflows / Ultracode

`continuous-code` ships a declarative multi-agent orchestration layer called the **workflow engine**, exposed through the `ultracode` tool and the `ultra-orchestrator` agent. This document explains the engine, its execution primitives, supporting infrastructure, and how to use it.

**Related:** [Agents](agents.md) · [Memory & Recall](memory.md) · [Architecture](architecture.md) · [README](../README.md)

---

## Table of Contents

- [What the Workflow Engine Is](#what-the-workflow-engine-is)
- [How to Trigger a Workflow](#how-to-trigger-a-workflow)
- [WorkflowSpec — the DAG DSL](#workflowspec--the-dag-dsl)
- [Execution Primitives](#execution-primitives)
  - [parallel — hard barrier fan-out](#parallel--hard-barrier-fan-out)
  - [pipeline — streaming no-barrier scheduler](#pipeline--streaming-no-barrier-scheduler)
  - [single — one agent turn](#single--one-agent-turn)
- [Context Store](#context-store)
- [Drift-Watcher](#drift-watcher)
- [Live Dashboard (SSE)](#live-dashboard-sse)
- [Terminal UI](#terminal-ui)
- [Configuration Reference](#configuration-reference)
- [Usage Walkthrough](#usage-walkthrough)

---

## What the Workflow Engine Is

The workflow engine fans out **real OpenCode child sessions** from a declarative `WorkflowSpec`. There is no simulation: every agent turn is a `client.session.create` + `client.session.prompt` HTTP call on its own child session. The engine enforces a concurrency ceiling (default: `min(16, max(2, cores-2))`) via a counting semaphore, so declaring 50 parallel agents does not open 50 sockets at once.

Key source files:

| File | Role |
|---|---|
| `src/tools/ultracode.ts` | Entry-point tool; validates spec, drives engine, starts dashboard + drift-watcher |
| `src/workflow/engine.ts` | `WorkflowEngine` class; `agent()`, `parallel()`, `pipeline()` primitives |
| `src/workflow/context-store.ts` | Per-run content-addressed artifact store |
| `src/workflow/drift-watcher.ts` | Round-robin drift-detection loop |
| `src/workflow/dashboard.ts` | Bun.serve SSE dashboard server |
| `src/workflow/tui/` | Zero-dependency terminal UI (`continuous-code-workflow-tui`) |
| `src/workflow/config.ts` | Config loading; honors `continuous-code.config.jsonc` `workflow` block |
| `src/workflow/types.ts` | `WorkflowSpec`, `PhaseSpec`, `Artifact`, `WorkflowEvent`, `DriftVerdict` |

The engine is entirely layered above the OpenCode v1 SDK. It does not modify any OpenCode core behavior, and native `build` / `plan` primary modes are left untouched.

---

## How to Trigger a Workflow

There are two entry points. They are equivalent mechanically; choose based on how you want to interact.

### `/ultracode` command

Type `/ultracode <task description>` in any OpenCode session. The command injects prompt instructions that tell the current agent to:

1. Restate the goal.
2. Scope work into phases, identify independent vs. dependent steps.
3. Assign `agentType`, `model`, and `effort` per node.
4. Call the `ultracode` tool with the resulting `WorkflowSpec`.

The `/ultracode` command is a prompt-injection markdown file (`commands/ultracode.md`). It contains no runtime code — it is purely instructions to the active agent.

### `ultra-orchestrator` agent

Select `ultra-orchestrator` as your session agent. This dedicated agent has all file and tool permissions denied at the YAML level; its sole capability is calling the `ultracode` tool. It autonomously designs `WorkflowSpec` DAGs and calls `ultracode` for every substantive task — never doing any direct work.

```yaml
# agents/ultra-orchestrator.md (excerpt)
model: zai-coding-plan/glm-5.2
variant: max
permission:
  read: deny
  edit: deny
  write: deny
  bash: deny
  # ... all others: deny
```

The `ultra-orchestrator` is not an "effort level" and is not triggered by any flag. It is a discrete OpenCode agent that you select like any other (e.g. `orchestrator`, `kraken`).

---

## WorkflowSpec — the DAG DSL

The `ultracode` tool accepts a JSON `WorkflowSpec`. The required fields:

```jsonc
{
  "task": "Add rate limiting to the API",       // required: human description
  "title": "rate-limiting-feature",             // optional: used in dashboard
  "phases": [                                   // required: ordered array of PhaseSpec
    {
      "mode": "parallel",
      "agents": [
        {
          "agentType": "scout",
          "label": "explore-routes",            // unique within run; used for contextRefs
          "prompt": "Map all HTTP route handlers in src/",
          "model": "sonnet",
          "effort": "low"
        },
        {
          "agentType": "oracle",
          "label": "research-ratelimit",
          "prompt": "Research token-bucket and sliding-window rate limiting algorithms",
          "model": "sonnet",
          "effort": "medium"
        }
      ]
    },
    {
      "mode": "single",
      "agents": [
        {
          "agentType": "architect",
          "label": "design",
          "prompt": "Design a rate-limiting middleware layer",
          "contextRefs": ["explore-routes", "research-ratelimit"],
          "model": "opus",
          "effort": "high"
        }
      ]
    },
    {
      "mode": "pipeline",
      "items": ["GET /users", "POST /orders", "PUT /items"],
      "stages": [
        {
          "agentType": "kraken",
          "label": "implement-{item}",
          "prompt": "Implement rate limiting for route {item}. Previous: {prev}",
          "model": "opus",
          "effort": "high"
        }
      ]
    }
  ]
}
```

Agent node fields:

| Field | Required | Description |
|---|---|---|
| `agentType` | yes | Agent name from the fleet (e.g. `scout`, `kraken`, `arbiter`) |
| `label` | yes (unique) | Artifact key; downstream agents reference this in `contextRefs` |
| `prompt` | yes | The instruction sent to the agent |
| `model` | no | `opus` / `sonnet` / `haiku` / `inherit` or a full `providerID:modelID` string |
| `effort` | no | `low` / `medium` / `high` / `max` |
| `contextRefs` | no | List of upstream artifact references (see [Context Store](#context-store)) |
| `schema` | no | JSON schema for structured output; engine retries up to 2× on validation failure |

Available agent types match the write-capable and read-only worker fleet. The node selection guide from the `/ultracode` command:

| Work type | `agentType` | Model class |
|---|---|---|
| Explore / read / gather | `scout` | sonnet-class |
| External research | `oracle` | sonnet-class |
| Architecture / design | `architect` | opus-class |
| Implement / TDD | `kraken` | opus-class |
| Quick patch | `spark` | sonnet-class |
| Test / verify | `arbiter` | opus-class |
| Review / quality | `judge` | opus-class |
| Debug / root cause | `sleuth` | opus-class |
| Docs / handoff | `scribe` | sonnet-class |
| Refactor / migration plan | `phoenix` | opus-class |
| Implementation planning | `plan-agent` | opus-class |

---

## Execution Primitives

### `parallel` — hard barrier fan-out

```
[scout A] ──┐
[scout B] ──┼──► next phase (starts only after ALL settle)
[oracle]  ──┘
```

All agent thunks in the phase are launched via `Promise.allSettled`. The phase does not complete until the last settled result arrives. Rejected thunks produce `null` artifacts; they do not abort sibling agents.

Actual concurrency is throttled by the shared semaphore (default `min(16, max(2, cores-2))` unless overridden by `concurrency` in config).

### `pipeline` — streaming no-barrier scheduler

```
item A: [stage 1] ──► [stage 2] ──► [stage 3]
item B:    [stage 1] ──► [stage 2] ──► [stage 3]
item C:       [stage 1] ──► [stage 2] ──► [stage 3]
```

Items are fed through stages as independent async chains. There is **no inter-stage barrier**: item B enters stage 1 as soon as item A exits stage 1, regardless of where item A is in stage 2. All chains run concurrently, throttled by the shared semaphore. Per-item failures are caught and dropped to `null` without halting other items.

Within pipeline stage prompts, two substitutions are available:

| Token | Expands to |
|---|---|
| `{item}` | The current item value |
| `{prev}` | The output of the previous stage for this item |

### `single` — one agent turn

Runs one agent. This is the fallback mode when a phase has one node and no streaming structure is needed.

---

## Context Store

The context store is a **per-run, in-memory, content-addressed `Map`**. Every completed agent turn stores an `Artifact` keyed by its `label`. Downstream agents receive artifact content via `contextRefs`.

### Artifact storage

When an agent turn completes, the engine calls `ContextStore.putArtifact({ label, full, phase })`. A `headTailSummary` (40-line head/tail digest with an elision marker) is auto-generated from the full output and stored alongside it.

### Ref forms

Downstream agents declare what context they want via `contextRefs`:

| Ref form | What is injected |
|---|---|
| `"label"` | Summary (40-line digest) of the named artifact |
| `"@full:label"` | Full verbatim text of the named artifact |
| `"phase:N"` | Summaries of all artifacts from phase N |

### Per-agent context cap

Before dispatching each agent turn, the engine calls `ContextStore.injectionFor(spec)` to build the system + context blocks. The budget is `perAgentContextCapTokens` (default 60,000; chars/4 estimate).

Budget enforcement rules:

- `@full` refs are reserved first and are **never trimmed**.
- Summary refs are sorted newest-first and dropped oldest-first until the remaining budget is satisfied.

### Blackboard

`ContextStore.addNote()` writes short annotations visible to the drift-watcher and available to orchestrator nudges. The drift-watcher uses the blackboard for `report`-severity verdicts.

---

## Drift-Watcher

The drift-watcher is an `unref`-ed `setInterval` loop that monitors in-flight child sessions for context drift or task deviation. It starts automatically when `driftEnabled: true` (the default) and is disposed in the `ultracode` tool's `finally` block when the workflow ends.

### How the sweep works

Every `driftIntervalMs` milliseconds (default 90,000 ms / 90 s) the loop:

1. **Picks one active child** from the registry in round-robin order. Only the swept child is acted on per tick.
2. **Snapshots** the last 40 lines of the swept child's most recent assistant text via `client.session.messages`.
3. **Assembles a watcher prompt** containing the shared workflow brief, any blackboard notes, and the 40-line snapshot.
4. **Hard-truncates** the assembled text to `driftCapTokens - 5000` tokens. The `driftCapTokens` value is hard-capped at **≤ 40,000** (user config may only lower it).
5. **Spawns a fresh `drift-watcher` agent session** (all tool permissions denied) and sends the truncated text.
6. **Receives a `DriftVerdict` JSON** and acts on it.

### DriftVerdict actions

| `drifted` | `severity` | `clearerPrompt` | Action |
|---|---|---|---|
| `false` | — | — | No action |
| `true` | `"report"` | — | Add blackboard note; nudge orchestrator via `promptAsync` (no abort) |
| `true` | `"respawn"` | non-empty | Abort the swept child; deregister it; re-run the node with `clearerPrompt` appended |

**Safety binding:** The `verdict.target` field returned by the LLM is deliberately ignored for action selection. The engine always acts on the actually-swept child, preventing a hallucinated `target` value from aborting the wrong session.

**Respawn cap:** Each node label tracks a respawn count. Once it reaches `maxRespawns` (default 2), further `respawn` verdicts degrade to `report`.

---

## Live Dashboard (SSE)

The workflow engine starts a local HTTP server (requires Bun; no-ops silently if Bun is absent) on the first workflow run. Subsequent runs reuse the already-bound server (idempotent start). The server is `unref`-ed so it does not keep the process alive.

The URL is logged **once** via `client.app.log`:

```
ultracode workflow dashboard live at http://localhost:7878
```

Open that URL in any browser.

### Routes

| Route | Description |
|---|---|
| `GET /` | Serves `assets/workflow-dashboard.html` — a reddish live dashboard |
| `GET /events` | SSE stream of `WorkflowEvent` frames; late joiners receive an immediate `state.seed` frame with the current ring-buffer snapshot |
| `GET /state` | JSON snapshot of the 500-event ring-buffer; useful for polling clients |

A 15-second `: keepalive` comment is sent on the SSE stream to prevent proxy timeouts.

### Why the dashboard is standalone

There is no OpenCode web-UI extension point for this dashboard:

- CSP blocks iframes in the OpenCode web UI.
- The server-plugin Hook API exposes no route hook and no panel hook.

The dashboard therefore runs on its own port as a separate browser tab. The one-time log line in the OpenCode interface is the only discovery mechanism.

---

## Terminal UI

`continuous-code-workflow-tui` is a zero-dependency terminal UI installed via the `bin` entry in `package.json`. It runs as a separate process and connects to the dashboard SSE stream.

### Starting it

```bash
continuous-code-workflow-tui              # connects to http://localhost:7878
continuous-code-workflow-tui --port 9090  # custom port
continuous-code-workflow-tui --url http://remote:7878
```

The TUI requires a running dashboard. It fetches the current state snapshot from `GET /state` first, then opens the `GET /events` SSE stream for live updates. It uses only global `fetch` + `ReadableStream.getReader()` — no npm dependencies.

### Navigation

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection within the current level |
| `Enter` or `→` | Drill in (phases → agents → agent detail) |
| `Esc` or `←` | Go back one level |
| `q` | Quit |

Three drill levels:

1. **Phases list** — shows all phases with status and agent counts.
2. **Agents list** — shows all agents in the selected phase with live status.
3. **Agent detail** — shows recent activity lines and the final outcome.

### Color palette

| Color (ANSI 256) | Meaning |
|---|---|
| 203 (reddish) | Active — agent is running |
| 114 (green) | Done |
| 95 (muted grey-red) | Pending |
| 215 (gold) | Spinner |

The spinner advances every 140 ms.

---

## Configuration Reference

All keys live in the `"workflow"` block of `continuous-code.config.jsonc` in your project directory. Missing keys fall back to defaults. The env var `OPENCODE_CONTINUOUS_WORKFLOW=0` disables the engine entirely at runtime.

<details>
<summary>Full workflow config keys</summary>

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Master on/off switch |
| `dashboardEnabled` | `true` | Start the Bun.serve SSE dashboard |
| `dashboardPort` | `7878` | TCP port for the dashboard |
| `concurrency` | `0` (auto) | Max concurrent agent sessions; 0 = `min(16, max(2, cores-2))` |
| `driftEnabled` | `true` | Run the drift-watcher round-robin loop |
| `driftIntervalMs` | `90000` | Sweep interval in milliseconds |
| `driftCapTokens` | `40000` | Hard cap on tokens sent to the drift-watcher per sweep; cannot be raised above 40,000 |
| `perAgentContextCapTokens` | `60000` | Per-agent context injection budget (chars/4 estimate) |
| `maxAgents` | `1000` | Hard ceiling on total agent sessions per workflow run |
| `storeLearnings` | `false` | On workflow completion, store the synthesized result as a `WORKING_SOLUTION` in the memory backend |

</details>

Example config block:

```jsonc
// continuous-code.config.jsonc
{
  "workflow": {
    "dashboardPort": 8080,
    "concurrency": 4,
    "driftIntervalMs": 60000,
    "storeLearnings": true
  }
}
```

---

## Usage Walkthrough

This example adds a rate-limiting feature to a hypothetical API codebase.

### Step 1 — Start OpenCode

```bash
opencode
```

The `orchestrator` agent opens by default. Switch to `ultra-orchestrator` if you want full autonomous workflow mode, or stay on the orchestrator and use the `/ultracode` command.

### Step 2 — Trigger a workflow

```
/ultracode Add token-bucket rate limiting to all API routes
```

The agent scopes the work and calls the `ultracode` tool with a spec similar to:

```jsonc
{
  "task": "Add token-bucket rate limiting to all API routes",
  "phases": [
    {
      "mode": "parallel",
      "agents": [
        { "agentType": "scout", "label": "explore-routes", "prompt": "List all HTTP route files and middleware entry points", "model": "sonnet", "effort": "low" },
        { "agentType": "oracle", "label": "ratelimit-research", "prompt": "Research token-bucket algorithm implementations for Node.js", "model": "sonnet", "effort": "medium" }
      ]
    },
    {
      "mode": "single",
      "agents": [
        { "agentType": "architect", "label": "design", "prompt": "Design the middleware layer", "contextRefs": ["explore-routes", "ratelimit-research"], "model": "opus", "effort": "high" }
      ]
    },
    {
      "mode": "parallel",
      "agents": [
        { "agentType": "kraken", "label": "implement", "prompt": "Implement the middleware and integrate it", "contextRefs": ["design"], "model": "opus", "effort": "high" },
        { "agentType": "arbiter", "label": "verify", "prompt": "Run existing tests and confirm baseline passes", "model": "opus", "effort": "medium" }
      ]
    },
    {
      "mode": "single",
      "agents": [
        { "agentType": "judge", "label": "review", "prompt": "Review the implementation for correctness and edge cases", "contextRefs": ["implement", "verify"], "model": "opus", "effort": "medium" }
      ]
    }
  ]
}
```

### Step 3 — Watch progress

The dashboard URL appears in the OpenCode log output:

```
ultracode workflow dashboard live at http://localhost:7878
```

Open it in a browser, or in a second terminal:

```bash
continuous-code-workflow-tui
```

Navigate with arrow keys. The phases list appears first; press `Enter` to drill into agents; press `Enter` again on an agent to see its activity and outcome.

### Step 4 — Receive the synthesized result

When all phases complete, the `ultracode` tool synthesizes a final report: a phase-by-phase summary with per-agent outcomes and the combined result. This appears as the agent's reply in your OpenCode session.

If `storeLearnings: true` is set, the synthesized result is also stored as a `WORKING_SOLUTION` in the memory backend and will surface in future sessions via the `memory-awareness` hook. See [Memory & Recall](memory.md) for details.

---

## DAG Patterns Quick Reference

```
# Parallel gather → single design → parallel implement+verify
[scout]──┐                          [kraken]──┐
         ├──► [architect: design] ──►           ├──► [judge: review]
[oracle]─┘                          [arbiter]──┘

# Linear pipeline (each stage gates the next)
[kraken: implement] ──► [arbiter: test] ──► [judge: review] ──► [scribe: handoff]

# Pipeline over items (each item is independent)
items: [route-A, route-B, route-C]
stages: [kraken: implement {item}] ──► [arbiter: verify {item}]
→ all three items run concurrently through all stages
```

For further reading on the agents available as workflow nodes, see [Agents](agents.md). For memory storage of workflow results, see [Memory & Recall](memory.md).
