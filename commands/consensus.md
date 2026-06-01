---
description: Manage and use multi-model consensus mode
---

You are managing **multi-model consensus mode**. When active, the orchestrator forms substantive answers, plans, decisions, and analyses by asking MULTIPLE AI models in parallel (across providers) and producing ONE combined consensus answer, with a designated dominant "main" model that breaks ties.

## Context

Subcommand / request: $ARGUMENTS

If $ARGUMENTS is empty, report the current consensus status (call `consensus_status`) and briefly explain how to enable and configure it.

## What consensus mode is

- A toggleable sub-plugin layered on top of the agent-only orchestration model.
- A **panel** of models is queried simultaneously (e.g. OpenRouter models AND ollama-cloud models at once), each with its own reasoning effort.
- One member is the **main** (dominant) model. It synthesizes the final answer, breaks ties, and may override dissent when justified.
- The result behaves like a normal model answer in OpenCode — the orchestrator bases its reply on the returned consensus.

## How to enable / disable

- Toggle at runtime with the `consensus_toggle` tool: `consensus_toggle { "enabled": true }`.
- Or edit `consensus.json` at the project root and set `"enabled": true`.
- Or set the `CONSENSUS_ENABLED` env var (`1`/`true`/`yes` to enable).

## How to configure the panel

Edit `consensus.json` (see `consensus.example.jsonc` for a fully commented version):

- `panel`: array of `{ id, provider, model, reasoning?, main? }`. Exactly one member should be `"main": true`.
- `reasoning`: `none|minimal|low|medium|high|xhigh` — applied for OpenRouter models only (ignored for ollama-cloud).
- `providers`: OpenAI-compatible endpoints; each names an `apiKeyEnv` for its key. Mix providers freely (OpenRouter + ollama-cloud simultaneously).
- `synthesis`: `"main-judge"` (client-side fan-out, cross-provider) or `"fusion"` (native OpenRouter Fusion — requires all members on OpenRouter).

## Env keys needed

- `OPENROUTER_API_KEY` for OpenRouter models.
- `OLLAMA_API_KEY` for ollama-cloud models (if your endpoint requires auth).

Use `consensus_status` to see which keys are present (it reports `set`/`missing`, never the value).

## When active

The orchestrator deliberates via the `consensus_deliberate` tool to form any substantive answer/plan/decision/analysis, then bases its reply on the returned consensus. All other tool usage and file edits still go through subagents via the `task` tool.

## Tools

- `consensus_deliberate` — get a combined consensus answer from the panel.
- `consensus_status` — inspect config, panel, and provider key availability.
- `consensus_toggle` — enable/disable consensus mode.

## Output

Act on $ARGUMENTS: enable/disable, show status, or explain configuration as requested. Confirm the resulting state clearly.
