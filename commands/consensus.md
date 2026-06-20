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

Advanced settings subcommands (no hand-editing needed):

- `temperature <n>` — set global temperature (0–2); e.g. `temperature 0.5`
  → `consensus_configure action=set-temperature value=<n>`
- `maxtokens <n>` — set max response tokens (positive integer); e.g. `maxtokens 2048`
  → `consensus_configure action=set-max-tokens value=<n>`
- `threshold <n>` — set agreement threshold (0–1); e.g. `threshold 0.75`
  → `consensus_configure action=set-agreement-threshold value=<n>`
- `timeout <ms>` — set per-model timeout in milliseconds; e.g. `timeout 30000`
  → `consensus_configure action=set-timeout value=<ms>`
- `requireparams <on|off>` — set requireParameters flag; e.g. `requireparams on`
  → `consensus_configure action=set-require-parameters enabled=<true|false>`
- `provider <key> <baseURL> [apiKeyEnv]` — add or update a custom provider; e.g.
  `provider my-llm https://my-llm.example.com/v1 MY_LLM_API_KEY`
  → `consensus_configure action=set-provider provider=<key> baseURL=<...> apiKeyEnv=<...>`

After any change, call `consensus_status` again to confirm the new state.

## Step 3 — Interactive setup when NO args (or ambiguous)

If `$ARGUMENTS` is empty or ambiguous, run an INTERACTIVE setup using the `question` tool:

1. Ask whether to enable consensus mode.
2. Call `consensus_models` (optionally with a search term the user gives) to show available models with prices, context length, and reasoning support.
3. Ask which models to include in the panel, which one is the MAIN (dominant tie-breaker), and each model's reasoning effort (`none|minimal|low|medium|high|xhigh`).
4. Apply via `consensus_configure` calls: `action=add` for each model, `action=set-main` for the chosen main, `action=set-reasoning` as needed, and `action=enable` to turn it on.
5. Optionally ask synthesis mode (`main-judge` cross-provider, or `fusion` native OpenRouter) and apply with `action=set-synthesis`.
6. **Advanced settings (optional)** — Ask: "Would you like to configure advanced settings (temperature, max tokens, agreement threshold, timeout, requireParameters, or custom providers)?" If yes:
   - Temperature (0–2, default 0.3): `consensus_configure action=set-temperature value=<n>`
   - Max tokens (positive int, default 1024): `consensus_configure action=set-max-tokens value=<n>`
   - Agreement threshold (0–1, default 0.6): `consensus_configure action=set-agreement-threshold value=<n>`
   - Timeout in ms (positive int, default 60000): `consensus_configure action=set-timeout value=<ms>`
   - Require parameters (true/false, default false): `consensus_configure action=set-require-parameters enabled=<bool>`
   - Custom provider (key + baseURL + optional apiKeyEnv): `consensus_configure action=set-provider provider=<key> baseURL=<url> apiKeyEnv=<VAR>`

   Skip any the user does not want to change.
7. Finish by calling `consensus_status` to confirm.

## Tools (everything is done through these — no manual file edits)

- `consensus_configure` — enable/disable, add/remove panel models, set main, synthesis, per-model reasoning, clear; and advanced: set-temperature, set-max-tokens, set-agreement-threshold, set-timeout, set-require-parameters, set-provider.
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
