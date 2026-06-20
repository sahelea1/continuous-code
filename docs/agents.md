# Agent Reference

Continuous-code adds 22 agents to OpenCode, organized around a strict orchestrator-led delegation model. This document covers how the orchestrator works, the full agent roster, model assignments, and how to invoke agents directly or in parallel.

See also: [Memory & Recall](memory.md) | [README](../README.md)

---

## The Orchestrator

`orchestrator` is the `default_agent` in `opencode.json`. Every new primary OpenCode session starts as the orchestrator unless you switch agents explicitly.

### What it does

The orchestrator decomposes incoming tasks into a DAG of subtasks, spawns the appropriate worker agents — in parallel when tasks are independent, sequenced when there are dependencies — and synthesizes their text outputs into a final reply. It does nothing else.

### Why it cannot act directly

Two enforcement layers prevent the orchestrator from doing direct work:

**Layer 1 — Permission block.** Both `agents/orchestrator.md` and the `agent.orchestrator` section of `opencode.json` set every tool permission to `deny`:

```json
"permission": {
  "read": "deny",
  "edit": "deny",
  "write": "deny",
  "bash": "deny",
  "grep": "deny",
  "glob": "deny",
  "list": "deny",
  "webfetch": "deny",
  "websearch": "deny"
}
```

**Layer 2 — `enforce-agent-only` hook.** `src/hooks/enforce-agent-only.ts` is a `experimental.chat.system.transform` hook registered by the plugin. On every orchestrator session it injects an additional system-prompt block that explains the delegation table and names the correct subagent for each category of work. This hook gates on the agent being `orchestrator`; native OpenCode `build` and `plan` primary modes, and all worker subagents, are explicitly bypassed and remain stock.

### Parallel delegation

When tasks are independent the orchestrator spawns multiple subagents in a single response, leveraging OpenCode's task scheduler for true concurrency. The `parallel-delegate` tool (`src/tools/parallel-delegate.ts`) is a helper that formats a `tasks` array of `{agent, prompt, description}` objects and instructs the LLM to issue all `task` tool calls in one shot.

---

## All 22 Agents

The table below lists every agent. Agents marked **write** can create or modify files. Agents marked **bash** can run shell commands.

| Agent | Group | Model (default) | Write | Bash | Purpose | Typical trigger |
|---|---|---|---|---|---|---|
| `orchestrator` | Orchestrator | `deepseek-v4-pro` @ max | — | — | Decompose tasks, spawn subagents, synthesize results | Default primary session |
| `ultra-orchestrator` | Ultra-orchestrator | `glm-5.2` @ max | — | — | Orchestrate via `WorkflowSpec` DAG through the `ultracode` tool | Select agent or `/ultracode` command |
| `drift-watcher` | Drift monitor | `glm-5.2` @ high | — | — | Round-robin context-drift detection for workflow children; returns `DriftVerdict` JSON | Spawned automatically by the workflow engine |
| `scout` | Workers | `deepseek-v4-flash` | — | — | Read-only codebase exploration: find files, search, map structure | Orchestrator delegates exploration |
| `kraken` | Workers | `deepseek-v4-pro` | yes | yes | Full-access TDD implementation with checkpoint/resume via handoff files | Orchestrator delegates implementation |
| `spark` | Workers | `deepseek-v4-flash` | yes | yes | Lightweight quick fixes; escalates to kraken if scope grows | Orchestrator delegates small edits |
| `architect` | Workers | `deepseek-v4-pro` | — | — | Read-only feature, interface, and integration design | Orchestrator delegates design decisions |
| `plan-agent` | Workers | `deepseek-v4-pro` | — | — | Read-only implementation plan generation from codebase analysis | Orchestrator delegates planning |
| `sleuth` | Workers | `deepseek-v4-pro` | — | — | Read-only bug investigation and root cause analysis | Orchestrator delegates debugging |
| `arbiter` | Workers | `deepseek-v4-flash` | yes | yes | Test execution and validation; bash + write for test output, no edit | Orchestrator delegates test runs |
| `judge` | Workers | `deepseek-v4-pro` | — | — | Read-only code review and refactoring assessment; no bash | Orchestrator delegates review |
| `oracle` | Workers | `deepseek-v4-pro` | — | — | Read-only external research via webfetch/websearch | Orchestrator delegates external lookups |
| `phoenix` | Workers | `deepseek-v4-pro` | — | — | Read-only large-scale refactoring and migration planning | Orchestrator delegates migration design |
| `scribe` | Workers | `deepseek-v4-flash` | yes | — | Write handoffs and continuity ledgers to `thoughts/`; no bash/edit | Orchestrator spawns at end of workflows |
| `memory-extractor` | Workers | `deepseek-v4-flash` | — | — | Extract learnings from session JSONL thinking blocks; calls `memory_store` tool | Spawned by orchestrator after sessions |
| `kraken-openai` | OpenAI escalations | `openai/gpt-5.4` @ xhigh | yes | yes | High-effort escalation of `kraken` for the hardest implementations | Orchestrator names explicitly |
| `judge-openai` | OpenAI escalations | `openai/gpt-5.4` @ xhigh | — | — | High-effort escalation of `judge` for high-stakes reviews | Orchestrator names explicitly |
| `architect-openai` | OpenAI escalations | `openai/gpt-5.4` @ xhigh | — | — | High-effort escalation of `architect` for the hardest design problems | Orchestrator names explicitly |
| `oracle-openai` | OpenAI escalations | `openai/gpt-5.4` @ xhigh | — | — | High-effort escalation of `oracle` for difficult research | Orchestrator names explicitly |
| `sleuth-openai` | OpenAI escalations | `openai/gpt-5.4` @ xhigh | — | — | High-effort escalation of `sleuth` for the hardest debugging | Orchestrator names explicitly |
| `phoenix-openai` | OpenAI escalations | `openai/gpt-5.4` @ xhigh | — | — | High-effort escalation of `phoenix` for the hardest refactoring plans | Orchestrator names explicitly |
| `plan-agent-openai` | OpenAI escalations | `openai/gpt-5.4` @ xhigh | — | — | High-effort escalation of `plan-agent` for high-stakes planning | Orchestrator names explicitly |

---

## Per-Agent Descriptions

<details>
<summary><strong>orchestrator</strong> — default primary agent</summary>

**File:** `agents/orchestrator.md`  
**Mode:** primary | **Steps:** 200 | **Model:** `zai-coding-plan/glm-5.2` @ max (YAML); `ollama-cloud/deepseek-v4-pro` @ max (opencode.json override — autoconfig may change this)

The canonical conductor. Its YAML frontmatter and the matching block in `opencode.json` both set all nine tool permissions to `deny`. The `enforce-agent-only` hook reinforces this at runtime by injecting a delegation table into every orchestrator system prompt.

Workflow:
1. Receive task from user.
2. Decompose into discrete subtasks.
3. Identify dependencies — what must run before what.
4. Spawn independent subtasks in parallel; sequence the rest.
5. Synthesize subagent text outputs into a coherent reply.

The orchestrator's only callable capability is the `task` tool (to spawn subagents). It never reads files, writes code, or runs commands.
</details>

<details>
<summary><strong>ultra-orchestrator</strong> — workflow-DAG variant</summary>

**File:** `agents/ultra-orchestrator.md`  
**Mode:** primary | **Steps:** 200 | **Model:** `zai-coding-plan/glm-5.2` @ max

Identical zero-tool-permission contract as `orchestrator`, but routes all substantive work through the `ultracode` tool rather than ad-hoc `task` calls. Its only output action is calling `ultracode` with a structured `WorkflowSpec` that describes phases (`single`, `parallel`, or `pipeline`), per-node `agentType`/`model`/`effort`, and `contextRefs` linking upstream artifacts to downstream agents.

Use when you want the full workflow engine: live dashboard, drift-watching, content-addressed context store, and pipeline concurrency.
</details>

<details>
<summary><strong>drift-watcher</strong> — context-drift monitor</summary>

**File:** `agents/drift-watcher.md`  
**Mode:** subagent | **Steps:** 8 | **Model:** `zai-coding-plan/glm-5.2` @ high

Spawned automatically by the workflow engine's `DriftWatcher` loop (default every 90 s). On each invocation it receives only the last ~40 lines of one active child agent's output plus the shared workflow brief. It returns a single JSON `DriftVerdict` — no prose, no code fences:

```json
{
  "drifted": false,
  "severity": "report",
  "target": "<swept-session-id>",
  "reason": "",
  "clearerPrompt": ""
}
```

`severity: "report"` adds a blackboard note and nudges the orchestrator. `severity: "respawn"` (only with a non-empty `clearerPrompt`) aborts the child and re-runs the node. Per-node respawn cap: 2; after that, further detections downgrade to `report`. The `target` field from the verdict is ignored for action selection — the engine always acts on the child it actually swept, preventing hallucinated IDs from killing the wrong session. Hard context cap: ≤ 40k tokens.
</details>

<details>
<summary><strong>scout</strong> — codebase explorer</summary>

**File:** `agents/scout.md`  
**Model:** `deepseek-v4-flash` | **Permissions:** read, grep, glob, list, bash — no edit/write

Read-only exploration. Use for: finding files, searching code patterns, mapping directory structure, understanding unfamiliar subsystems. Returns structured markdown reports. The orchestrator spawns multiple scout instances in parallel for independent areas of a codebase.
</details>

<details>
<summary><strong>kraken</strong> — implementation agent</summary>

**File:** `agents/kraken.md`  
**Model:** `deepseek-v4-pro` | **Permissions:** read, edit, write, bash, grep, glob — full access

Full TDD implementation: write tests first, implement to pass, iterate. Supports checkpoint/resume: task prompts can include `resume: "<session-id>"` or `"continue from checkpoint"`, and kraken reads `thoughts/shared/handoffs/<task-slug>/current.md` to pick up from the last validated phase. Escalate the task to `kraken-openai` when the problem requires the highest available reasoning.
</details>

<details>
<summary><strong>spark</strong> — quick-fix agent</summary>

**File:** `agents/spark.md`  
**Model:** `deepseek-v4-flash` | **Permissions:** full access

Lightweight edits: rename a variable, fix a typo, patch a single function. If the scope of the task grows unexpectedly, spark escalates to kraken rather than expanding its own footprint.
</details>

<details>
<summary><strong>architect</strong> — design agent</summary>

**File:** `agents/architect.md`  
**Model:** `deepseek-v4-pro` | **Permissions:** read-only

Feature design, integration design, interface contracts. Reads code and produces architectural recommendations as markdown. Does not write files. For the hardest design problems, use `architect-openai`.
</details>

<details>
<summary><strong>plan-agent</strong> — implementation planner</summary>

**File:** `agents/plan-agent.md`  
**Model:** `deepseek-v4-pro` | **Permissions:** read-only

Analyzes the codebase and generates a detailed, phased implementation plan. Typically spawned after `scout` maps structure and before `kraken` begins implementing. Use `plan-agent-openai` for high-stakes planning where extra reasoning is warranted.
</details>

<details>
<summary><strong>sleuth</strong> — bug investigator</summary>

**File:** `agents/sleuth.md`  
**Model:** `deepseek-v4-pro` | **Permissions:** read-only

Root cause analysis. Reads source, logs, and test output to trace a bug to its origin and recommend a fix. Returns findings as markdown; does not modify files. Use `sleuth-openai` for the hardest debugging.
</details>

<details>
<summary><strong>arbiter</strong> — test runner</summary>

**File:** `agents/arbiter.md`  
**Model:** `deepseek-v4-flash` | **Permissions:** bash, write — no edit

Runs test suites and writes test reports. Has bash access to execute commands and write access for report files, but cannot edit source files. Spawned in parallel with `judge` after `kraken` completes an implementation cycle.
</details>

<details>
<summary><strong>judge</strong> — code reviewer</summary>

**File:** `agents/judge.md`  
**Model:** `deepseek-v4-pro` | **Permissions:** read-only, no bash

Reviews code quality, identifies refactoring opportunities, and assesses correctness. Reads source and git diffs; returns a structured review. No bash access. Use `judge-openai` for high-stakes reviews.
</details>

<details>
<summary><strong>oracle</strong> — external researcher</summary>

**File:** `agents/oracle.md`  
**Model:** `deepseek-v4-pro` | **Permissions:** read, webfetch, websearch — no write

External research: documentation lookups, library comparisons, API reference checks. The only agent class with webfetch/websearch permissions enabled by default. Use `oracle-openai` for complex research requiring deeper reasoning.
</details>

<details>
<summary><strong>phoenix</strong> — refactoring planner</summary>

**File:** `agents/phoenix.md`  
**Model:** `deepseek-v4-pro` | **Permissions:** read-only

Large-scale refactoring plans and migration strategies. Reads the codebase and produces a phased migration plan; hands the plan to `kraken` for execution. Use `phoenix-openai` for the most complex migrations.
</details>

<details>
<summary><strong>scribe</strong> — documentation agent</summary>

**File:** `agents/scribe.md`  
**Model:** `deepseek-v4-flash` | **Permissions:** read, write — no bash/edit

Writes handoff documents and continuity ledgers. Output paths:
- `thoughts/shared/handoffs/{session-name}/current.md`
- `thoughts/ledgers/CONTINUITY_CLAUDE-{session-name}.md`

Typically the final step in any orchestrator workflow so that context survives session boundaries.
</details>

<details>
<summary><strong>memory-extractor</strong> — learning extractor</summary>

**File:** `agents/memory-extractor.md`  
**Model:** `deepseek-v4-flash` | **Permissions:** read, memory_store tool

Reads a session JSONL file, scans thinking blocks for perception-change signals, and stores structured learnings via the `memory_store` tool. If the tool backend is unavailable it falls back to writing `thoughts/ledgers/LEARNINGS_<SESSION_ID>.md`.

Invoke with `JSONL_PATH` and optional `SESSION_ID`.
</details>

<details>
<summary><strong>OpenAI escalation variants (7 agents)</strong></summary>

The seven `-openai` agents — `kraken-openai`, `judge-openai`, `architect-openai`, `oracle-openai`, `sleuth-openai`, `phoenix-openai`, `plan-agent-openai` — are separate agent definitions with:

- **Identical** system prompt and permission set as the base variant
- **Model:** `openai/gpt-5.4`
- **Variant:** `xhigh`

They are not the default. The orchestrator selects them explicitly by name when a task requires the highest available reasoning tier or a second opinion from a different model family. No user configuration is required beyond having an OpenAI API key authenticated.

Files:
- `agents/kraken-openai.md`
- `agents/judge-openai.md`
- `agents/architect-openai.md`
- `agents/oracle-openai.md`
- `agents/sleuth-openai.md`
- `agents/phoenix-openai.md`
- `agents/plan-agent-openai.md`
</details>

---

## Model Assignment

### Defaults (opencode.json)

The committed `opencode.json` ships with these defaults (before autoconfig runs):

| Role | Default model |
|---|---|
| `orchestrator`, `ultra-orchestrator` | `zai-coding-plan/glm-5.2` @ max (YAML) / `ollama-cloud/deepseek-v4-pro` @ max (opencode.json) |
| `drift-watcher` | `zai-coding-plan/glm-5.2` @ high |
| All worker agents | `ollama-cloud/deepseek-v4-flash` |
| OpenAI escalation variants | `openai/gpt-5.4` @ xhigh |

The global `"model"` key is `ollama-cloud/deepseek-v4-pro`; `"small_model"` is `ollama-cloud/deepseek-v4-flash`. Worker agents inherit `small_model` unless overridden per-agent.

### Autoconfig

At install time, `install.sh` invokes `dist/autoconfig/cli.js` to detect which providers have authenticated credentials and deterministically reassign models — no LLM call, no guessing:

| Tier | Agents | Effort |
|---|---|---|
| Orchestrator | `orchestrator` | xhigh |
| Heavy | `oracle`, `sleuth`, `kraken`, `judge`, `plan-agent`, `phoenix`, `architect`, `general` | high |
| Light | `scout`, `spark`, `arbiter`, `scribe`, `memory-extractor`, `explore` | low |

Autoconfig picks the provider's strongest model for the orchestrator tier, a mid-tier model for heavy workers, and the fastest model for light workers. When no provider is authenticated it keeps `ollama-cloud/deepseek-v4-pro` as the fallback everywhere. `xhigh` effort is clamped to `max` because OpenCode's `variant` field has no `xhigh` value.

Re-run autoconfig at any time with the `/autoconfagent` command or:

```bash
node dist/autoconfig/cli.js apply --config opencode.json
```

### Effort and variant

OpenCode expresses reasoning effort through the `variant` field on an agent config (`low`, `medium`, `high`, `max`). The workflow engine's `ModelResolver` maps effort shorthands to variants when spawning child sessions for workflows.

---

## Parallel Delegation

The `parallel-delegate` tool provides a structured way to request parallel execution:

```jsonc
// args passed to the parallel_delegate tool
{
  "tasks": [
    { "agent": "scout", "prompt": "Map the src/auth directory", "description": "explore auth" },
    { "agent": "oracle", "prompt": "Summarize OAuth2 PKCE flow", "description": "research" }
  ]
}
```

The tool formats the list and instructs the LLM to issue all `task` tool calls in a single response so OpenCode's scheduler can run them concurrently.

The orchestrator also applies parallel delegation without the tool — it is instructed by both its system prompt and the `enforce-agent-only` hook to prefer parallel spawning for independent subtasks.

---

## Native Build and Plan: Unchanged

`/build` and `/plan` are OpenCode's native primary modes. Continuous-code does **not** redefine them, inject system-prompt instructions into them, or alter their model assignments. The `enforce-agent-only` hook explicitly gates on `agent === "orchestrator"` and returns immediately for all other primary modes.

You can switch between the orchestrator and native modes at any time. They are complementary, not competing.

---

## Workflows and the Ultra-Orchestrator

For multi-agent fan-out with a live dashboard, drift detection, and pipeline concurrency, use the workflow engine:

- **`/ultracode` command** — instructs the current agent to scope a DAG and call the `ultracode` tool.
- **`ultra-orchestrator` agent** — a dedicated primary that expresses every substantive task as a `WorkflowSpec` and never issues ad-hoc `task` calls.

The workflow engine supports three phase modes:

| Mode | Behavior |
|---|---|
| `single` | One agent turn |
| `parallel` | All agents run concurrently; hard barrier waits for all to settle |
| `pipeline` | Items stream through stages with no inter-stage barrier; per-item failures drop to null without halting others |

The `drift-watcher` agent is wired into the engine and runs automatically when `driftEnabled: true` (default). See the workflow configuration keys in `continuous-code.config.example.jsonc` under the `workflow` block.
