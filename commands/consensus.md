---
description: Manage and use multi-model consensus mode
---

You are managing **multi-model consensus mode** entirely through tools — the user NEVER hand-edits any file. The plugin writes `consensus.json` programmatically via the `consensus_configure` and `consensus_toggle` tools.

When active, the orchestrator forms substantive answers, plans, decisions, and analyses by asking MULTIPLE AI models in parallel (across providers) and producing ONE combined consensus answer, with a designated dominant "main" model that breaks ties. There is exactly ONE consensus instance (you). Subagents are ordinary single-model workers and never run consensus.

## Context

Subcommand / request: $ARGUMENTS

## Step 1 — Always show current state first

Call `consensus_status` to display the current enabled state, synthesis mode, the panel, the main model, and which provider API keys are present.

## Step 2 — Act on $ARGUMENTS (quick subcommands)

Parse `$ARGUMENTS` and act immediately via tools:

- `on` / `enable` → `consensus_configure action=enable`
- `off` / `disable` → `consensus_configure action=disable`
- `status` → just `consensus_status` (already done in step 1)
- `list [search]` → `consensus_models search=<search>` (omit search to list all)
- `add <slug> [reasoning]` → `consensus_configure action=add model=<slug> reasoning=<...>`
- `remove <id|slug>` → `consensus_configure action=remove id=<...>` (or `model=<slug>`)
- `main <id>` → `consensus_configure action=set-main id=<id>`
- `synthesis <main-judge|fusion>` → `consensus_configure action=set-synthesis synthesis=<...>`
- `reasoning <id> <effort>` → `consensus_configure action=set-reasoning id=<id> reasoning=<effort>`
- `clear` → `consensus_configure action=clear`

After any change, call `consensus_status` again to confirm the new state.

## Step 3 — Interactive setup when NO args (or ambiguous)

If `$ARGUMENTS` is empty or ambiguous, run an INTERACTIVE setup using the `question` tool:

1. Ask whether to enable consensus mode.
2. Call `consensus_models` (optionally with a search term the user gives) to show available models with prices, context length, and reasoning support.
3. Ask which models to include in the panel, which one is the MAIN (dominant tie-breaker), and each model's reasoning effort (`none|minimal|low|medium|high|xhigh`).
4. Apply via `consensus_configure` calls: `action=add` for each model, `action=set-main` for the chosen main, `action=set-reasoning` as needed, and `action=enable` to turn it on.
5. Optionally ask synthesis mode (`main-judge` cross-provider, or `fusion` native OpenRouter) and apply with `action=set-synthesis`.
6. Finish by calling `consensus_status` to confirm.

## Tools (everything is done through these — no manual file edits)

- `consensus_configure` — enable/disable, add/remove panel models, set main, synthesis, per-model reasoning, clear.
- `consensus_models` — list/search models available for the panel (from OpenRouter).
- `consensus_status` — inspect config, panel, main, and provider key availability.
- `consensus_toggle` — quick enable/disable.
- `consensus_deliberate` — get a combined consensus answer from the panel (runs only in the single primary instance).

## Env keys

- `OPENROUTER_API_KEY` for OpenRouter models.
- `OLLAMA_API_KEY` for ollama-cloud models (if your endpoint requires auth).

`consensus_status` reports each provider key as `set`/`missing`, never the value.

## Output

State explicitly that everything was done through tools — the user never edits files by hand. Confirm the resulting state clearly by ending with the `consensus_status` output.
