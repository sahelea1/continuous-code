# Usage & Command Reference

Day-to-day guide to `continuous-code`. For installation, see [README](../README.md). For a subsystem deep-dive, see [Architecture](architecture.md).

---

## Table of Contents

- [How to Start](#how-to-start)
- [Slash Commands](#slash-commands)
- [Plugin Tools](#plugin-tools)
- [Consensus Mode](#consensus-mode)
- [Session Continuity](#session-continuity)
- [End-to-End Example Flows](#end-to-end-example-flows)

---

## How to Start

Open a terminal in any project and run:

```bash
opencode
```

The shell alias written by the installer (`~/.zshrc` or `~/.bashrc`) injects `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`, enabling background task spawning. If you opened the shell before installing, source your rc file once:

```bash
source ~/.zshrc   # or ~/.bashrc
```

`opencode.json` sets `default_agent` to `orchestrator`, so every new primary session starts as the orchestrator. The orchestrator has all tool permissions denied — it never reads files, writes code, or runs commands directly. Its only job is to decompose your request into subtasks and delegate them to the appropriate worker agents. See [Agents](agents.md) for the full fleet.

OpenCode's native `build` and `plan` primary modes are completely untouched. You can switch to them at any time; `continuous-code` adds on top and never overrides them.

---

## Slash Commands

There are 11 slash commands. Type them in any OpenCode session with an optional argument.

| Command | What it does | Quick example |
|---|---|---|
| `/autoconfagent` | Detect authenticated AI providers on this host, choose the best model and reasoning effort per agent role, and write `opencode.json`. No file hand-editing required. | `/autoconfagent prefer anthropic` |
| `/build-cmd` | Full end-to-end feature build: plan (plan-agent) → design (architect) → implement (kraken) → test (arbiter) → review (judge) → handoff (scribe). | `/build-cmd add pagination to the user list endpoint` |
| `/consensus` | Interactive wizard to configure the multi-model consensus panel — or quick subcommands to enable/disable/modify it without touching files. | `/consensus on` · `/consensus add claude-3-5-sonnet` |
| `/explore` | Parallel codebase exploration: three scout agents map structure, patterns, and dependencies simultaneously; oracle adds external context; results are synthesized. | `/explore how authentication works` |
| `/fix` | Bug fix pipeline: sleuth investigates → kraken implements → arbiter verifies → scribe creates handoff. | `/fix login fails when email contains a plus sign` |
| `/handoff` | Collect the current session's git state and work into a structured YAML handoff file; update the continuity ledger at `thoughts/ledgers/CONTINUITY_{topic}.md`. | `/handoff finished auth refactor, blocked on refresh tokens` |
| `/refactor` | Safe refactoring pipeline: phoenix plans → judge reviews the plan → kraken executes step by step (tests run after each step) → arbiter verifies. | `/refactor extract UserService from the monolithic controller` |
| `/resume` | Load the most recent handoff (or a specific one), orient you on what was left in-progress or blocked, then route to the right agent to continue. | `/resume` · `/resume thoughts/shared/handoffs/auth/2024-01-15.yaml` |
| `/review` | Multi-perspective parallel review: judge (quality), arbiter (tests), and scout (consistency) all run simultaneously; results are synthesized into a single verdict. | `/review src/api/users.ts` |
| `/tdd` | Strict test-first pipeline: plan-agent designs test cases → arbiter writes failing tests (RED) → kraken implements minimal code to pass (GREEN + REFACTOR) → arbiter verifies the suite is clean. | `/tdd UserRepository.findByEmail` |
| `/ultracode` | Switch the current conversation into workflow mode. The agent scopes a phase DAG, assigns agent types and model tiers per node, and calls the `ultracode` tool to fan out real concurrent child sessions. | `/ultracode migrate the billing module to Stripe v4` |

---

## Plugin Tools

These tools are registered by the plugin and are available to agents inside OpenCode sessions. You do not call them directly in the shell — agents call them as needed, and slash commands are implemented by instructing agents to call the appropriate tools.

<details>
<summary><strong>Full tool list</strong></summary>

### Memory tools

| Tool | Source | Purpose |
|---|---|---|
| `memory_recall` | `src/tools/memory-recall.ts` | Query the memory backend (BM25 full-text search, or RRF blend of FTS + cosine when embeddings are active). Returns numbered results with `learning_type` and score. Accepts `query`, `limit` (default 5), and `text_only`. |
| `memory_store` | `src/tools/memory-store.ts` | Write a learning to the memory backend. Accepts `content`, `type` (one of `FAILED_APPROACH`, `WORKING_SOLUTION`, `USER_PREFERENCE`, `CODEBASE_PATTERN`, `ARCHITECTURAL_DECISION`, `ERROR_FIX`, `OPEN_THREAD`), `context`, `tags[]`, `confidence` (`high`/`medium`/`low`), and optional `session_id` / `agent_id`. Dedup runs automatically. |

### Handoff tools

| Tool | Source | Purpose |
|---|---|---|
| `handoff_save` | `src/tools/handoff-save.ts` | Write a structured YAML handoff file to `thoughts/shared/handoffs/<session-slug>/<timestamp>.yaml`. Called by scribe during `/handoff` and at the end of most workflows. |
| `handoff_load` | `src/tools/handoff-load.ts` | Read a handoff file (by path or by finding the most recent one) and return its contents. Called by the orchestrator during `/resume`. |

### Continuity tool

| Tool | Source | Purpose |
|---|---|---|
| `ledger_update` | `src/tools/ledger-update.ts` | Append an entry to the continuity ledger at `thoughts/ledgers/CONTINUITY_{topic}.md`. Called by scribe after writing a handoff. |

### Consensus tools

| Tool | Source | Purpose |
|---|---|---|
| `consensus_configure` | `src/tools/consensus-configure.ts` | Full consensus management: `enable`, `disable`, `add` / `remove` panel models, `set-main`, `set-synthesis`, `set-reasoning`, `clear`, plus advanced settings (`set-temperature`, `set-max-tokens`, `set-agreement-threshold`, `set-timeout`, `set-require-parameters`, `set-provider`). Writes `consensus.json` programmatically. |
| `consensus_models` | `src/tools/consensus-models.ts` | List or search available models for the consensus panel (from OpenRouter), including prices, context length, and reasoning support. |
| `consensus_status` | `src/tools/consensus-status.ts` | Inspect the current consensus config: enabled state, synthesis mode, panel members, main model, and provider key availability (`set`/`missing`, never the value). |
| `consensus_toggle` | `src/tools/consensus-toggle.ts` | Quick enable / disable without going through the full configure flow. |
| `consensus_deliberate` | `src/tools/consensus-deliberate.ts` | Send a question to the configured panel, poll all models in parallel, and return one synthesized answer. Runs only in the single primary orchestrator session; subagents are single-model workers and never run consensus. |

### Autoconfig tool

| Tool | Source | Purpose |
|---|---|---|
| `autoconfig_inspect` | `src/tools/autoconfig.ts` | Detect authenticated providers and their models on this host. Returns `providers[]`, each with `id`, `authenticated`, `models[]` (with `reasoning` flag and `variants`), and `currentAgents`. |
| `autoconfig_apply` | `src/tools/autoconfig.ts` | Write a `model` + `effort` assignment for every agent to `opencode.json`. Validates all providers up-front; rejects the whole apply if any model uses an unknown provider. Creates a `.bak` backup on first write. |

### Orchestration tool

| Tool | Source | Purpose |
|---|---|---|
| `parallel_delegate` | `src/tools/parallel-delegate.ts` | Format a `tasks` array of `{agent, prompt, description}` objects into instructions that cause the LLM to issue all `task` calls in one response, achieving true concurrency through OpenCode's task scheduler. |

### Workflow tool

| Tool | Source | Purpose |
|---|---|---|
| `ultracode` | `src/tools/ultracode.ts` | Accept a `WorkflowSpec` JSON (phases with `single`/`parallel`/`pipeline` nodes, per-node `agentType`/`model`/`effort`/`contextRefs`/`schema`), fan out real OpenCode child sessions, drive the context store + drift-watcher + dashboard, and return a synthesized report. See [Workflows / Ultracode](workflows.md). |

</details>

---

## Consensus Mode

Consensus mode makes the orchestrator poll a configurable panel of models across providers in parallel and produce one combined answer. It is off by default.

### Setting up with the wizard

Run `/consensus` with no arguments to start the interactive setup:

```
/consensus
```

The wizard will:

1. Show current state (via `consensus_status`).
2. List available panel models (via `consensus_models`).
3. Ask which models to include, which is the MAIN (tie-breaker), and each model's reasoning effort.
4. Optionally configure synthesis mode, temperature, token limits, and custom providers.
5. Confirm the final state.

Everything is written to `consensus.json` in the project directory through tools — you never edit the file by hand.

### Quick subcommands

```
/consensus on                        # enable
/consensus off                       # disable
/consensus status                    # inspect current panel
/consensus list                      # list available models
/consensus list gpt                  # search available models
/consensus add openai/gpt-4o         # add a model to the panel
/consensus remove <id>               # remove by panel member id
/consensus main <id>                 # set the tie-breaker model
/consensus synthesis fusion          # switch synthesis mode
/consensus temperature 0.5           # set global temperature
/consensus maxtokens 2048            # set max response tokens
/consensus threshold 0.75            # set agreement threshold (0–1)
/consensus timeout 30000             # set per-model timeout (ms)
```

### Synthesis modes

| Mode | Behavior |
|---|---|
| `main-judge` | Each panel model answers independently; the main model then reads all answers and synthesizes one final response. Cross-provider. |
| `fusion` | Uses OpenRouter's native model-fusion feature. Requires all panel models to be on OpenRouter. |

### Required environment variables

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Required for OpenRouter panel models. |
| `OLLAMA_API_KEY` | Required for ollama-cloud models if your endpoint needs auth. |

`consensus_status` reports each key as `set` or `missing`, never its value.

---

## Session Continuity

Work persists across sessions through two mechanisms: **handoff files** and the **continuity ledger**.

### Handoff files

A handoff is a YAML file written by the `scribe` agent to:

```
thoughts/shared/handoffs/<session-slug>/<timestamp>.yaml
```

It captures:

- Session name, timestamp, branch, and HEAD commit.
- Status: `complete`, `partial`, or `blocked`.
- A one-to-two sentence summary of what was accomplished.
- `accomplished`, `in_progress` (each with a `next_step`), and `blocked` lists.
- `context` (key files, decisions, gotchas).
- `next_session` (priority, suggested command, notes).

Most workflows (build, fix, refactor, tdd) create a handoff automatically as their final step. You can also trigger one explicitly:

```
/handoff <optional notes about where you left off>
```

### Continuity ledger

`thoughts/shared/CONTINUITY.md` is a running log of sessions. Each entry is appended (never overwritten) in this format:

```markdown
## 2024-01-15 — auth refactor

**Status:** partial
**Branch:** feature/auth
**Handoff:** thoughts/shared/handoffs/auth-refactor/2024-01-15T14-32.yaml

Extracted UserService from the monolithic controller. Refresh token logic incomplete.

**Next:** Complete refresh token endpoint, then run the full auth test suite.
```

### Resuming

```
/resume
```

The `/resume` command finds the most recent handoff, reads the current git state, and routes to the right agent based on status:

- `blocked` → sleuth investigates the blocker.
- `partial` (implementation work) → kraken continues.
- `partial` (test/verification work) → arbiter resumes.
- `complete` → presents `next_session.priority` and asks what to do next.

After the resumed work reaches a stopping point, `/resume` automatically triggers a new `/handoff` to capture the updated state.

### Memory

Long-term learnings (solutions, decisions, patterns, pitfalls) persist across sessions via the memory backend. The `memory-awareness` hook auto-surfaces relevant past learnings in every session by appending a `MEMORY MATCH` block to model output when the backend finds matches. For the full memory reference, see [Memory & Recall](memory.md).

---

## End-to-End Example Flows

### Explore then build

Understand an unfamiliar codebase, then add a feature.

```
/explore how the payment processing module works
```

Three scout agents map structure, patterns, and dependencies in parallel; oracle adds external context. After the synthesized report:

```
/build-cmd add a retry mechanism to failed payment jobs
```

`plan-agent` produces an implementation plan, `architect` reviews it for fit, `kraken` implements with tests at each step, `arbiter` verifies the suite, `judge` reviews code quality, and `scribe` writes a handoff.

---

### Fix a bug

```
/fix checkout crashes when the cart is empty
```

`sleuth` investigates root cause in parallel across source files, logs, and test output. Once it returns a structured diagnosis, `kraken` writes a failing regression test first, then implements the minimal fix. `arbiter` confirms the regression test and full suite pass. `scribe` writes a handoff with the root cause and files changed.

---

### Safe refactoring

```
/refactor extract PaymentService from OrderController
```

`phoenix` produces a step-by-step migration plan with impact analysis and a rollback plan. `judge` reviews the plan and flags any blockers. Once the plan is approved, `kraken` executes one step at a time — running the full test suite after each step and stopping immediately if any test fails. `arbiter` does a final verification pass.

---

### Strict TDD

```
/tdd UserRepository.findByEmail must handle case-insensitive matching
```

`plan-agent` designs test cases ordered simplest to most complex. `arbiter` writes all the failing tests and confirms each one fails for the right reason (missing implementation, not a syntax error). `kraken` implements the minimal code to turn each test green, then refactors while keeping the suite green. A final `arbiter` run confirms the suite is clean.

---

### Parallel code review

```
/review src/payments/
```

`judge`, `arbiter`, and `scout` run simultaneously. Judge evaluates correctness, quality, design, security, and performance. Arbiter runs the test suite and audits coverage. Scout checks consistency with existing codebase conventions. Results are synthesized into a single verdict with items classified as BLOCKER / WARNING / SUGGESTION.

---

### Ultracode for a large task

Use `/ultracode` when a task is too large or parallel for a single agent chain.

```
/ultracode migrate all database queries in src/ from raw SQL to the ORM layer
```

The agent scopes the work into a DAG: parallel `scout` agents inventory all raw-SQL call sites across the codebase, then `architect` designs the migration strategy, then `kraken` agents handle separate modules in parallel, then `arbiter` runs the full suite, and finally `scribe` writes a handoff. All phases run as real concurrent child sessions through the workflow engine.

While the workflow runs:
- A live dashboard starts at `http://localhost:7878` (Bun required). The URL appears once in the OpenCode log.
- Run `continuous-code-workflow-tui` in a separate terminal for an ANSI dashboard with phase/agent drill-down.
- The drift-watcher monitors running child agents and respawns any that have gone off-track (up to 2 times per node).

See [Workflows / Ultracode](workflows.md) for the full `WorkflowSpec` reference and configuration options.

---

### Model reconfiguration

After authenticating a new AI provider:

```
/autoconfagent prefer anthropic
```

The command inspects all authenticated providers and their available models, assigns the strongest to the orchestrator (`xhigh` effort), mid-tier models to heavy reasoning agents (`high` effort), and fast models to light agents (`low` effort). The result is written to `opencode.json` with a `.bak` backup. Restart `opencode` for changes to take effect.

---

### Consensus for a hard decision

When you want multiple models to weigh in before committing to an architectural choice:

```
/consensus on
/consensus add openai/gpt-4o
/consensus add anthropic/claude-opus-4
/consensus main anthropic/claude-opus-4
```

Then ask your question normally. The orchestrator polls both models in parallel, the main model synthesizes their responses into one answer, and the synthesized result is what you see.

Turn it off when you no longer need it:

```
/consensus off
```
