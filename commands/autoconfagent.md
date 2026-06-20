---
description: Auto-configure agent models and reasoning effort for this host's providers
---

You are running the **/autoconfagent** workflow. Your job is to make this OpenCode
installation adapt to whatever AI providers the current host actually has: detect
the available/authenticated providers and models, wisely choose the best model AND
reasoning effort for each agent based on its role, then WRITE those choices into the
host's `opencode.json`. The user NEVER hand-edits any file — everything is done
through the `autoconfig_inspect` and `autoconfig_apply` tools.

## Context

Optional hint / preference: $ARGUMENTS

(e.g. "prefer anthropic", "stay on the current providers", or empty for full auto.)

## Step 1 — Inspect what's available

Call `autoconfig_inspect` FIRST. Read the structured result carefully:

- `providers[]` — each has `id`, `authenticated`, `source`, optional `baseURL`, and
  `models[]` where each model has `id`, `reasoning` (whether it supports a reasoning
  variant), and `variants` (the reasoning-effort levels the provider declares, e.g.
  `low | medium | high | max`).
- `currentConfigPath` — the `opencode.json` that `autoconfig_apply` will write to.
- `currentAgents` — the current `agent -> { model, variant }` mapping.

**You may ONLY assign models that appear in the inspect output and belong to an
AUTHENTICATED provider.** Authenticated providers are listed first. Never invent a
model slug; never pick a provider that has no credentials.

## Step 2 — Choose models + reasoning effort per role

Reasoning effort is expressed through the agent `variant` field. Use the `effort`
argument of `autoconfig_apply` (one of `low | medium | high | max | xhigh`); the tool
maps it to the correct `variant` for you (`xhigh` clamps to `max`). Only set effort
for models whose `reasoning` flag is true / that declare `variants`.

Assign every agent using this **ROLE TAXONOMY**:

- **Orchestrator** — `orchestrator`:
  The single MOST capable / strongest-reasoning available model, at the HIGHEST
  effort (`xhigh` if the model supports it, otherwise `max`).
- **Heavy reasoning subagents** — `oracle`, `sleuth`, `kraken`, `judge`,
  `plan-agent`, `phoenix`, `architect`, `general`:
  A strong model at `medium` or `high` effort.
- **Light / fast subagents** — `scout`, `spark`, `arbiter`, `scribe`,
  `memory-extractor`, `explore`:
  A fast / cheap model at `low` effort. If only reasoning models are available,
  still use the cheapest one at `low`.

### Provider-mix guidance

- **Prefer keeping the existing provider mix** when it is already well configured for
  these three tiers — only switch providers when the current ones are clearly NOT the
  best available on this host.
- Respect any preference in `$ARGUMENTS` (e.g. "prefer anthropic") as long as that
  provider is authenticated.
- Concrete example: on a host where only **anthropic** is authenticated, set the
  orchestrator (`orchestrator`) to the strongest model such as
  `anthropic/claude-opus-4-8` at `xhigh`; the heavy subagents to
  `anthropic/claude-sonnet-4-6` at `medium`/`high`; and the light subagents to a fast
  model such as `anthropic/claude-haiku-4-6` at `low`.

## Step 3 — Apply

Call `autoconfig_apply` once with the full `assignments` map, e.g.:

```json
{
  "assignments": {
    "orchestrator":     { "model": "anthropic/claude-opus-4-8",  "effort": "xhigh" },
    "oracle":           { "model": "anthropic/claude-sonnet-4-6", "effort": "high" },
    "sleuth":           { "model": "anthropic/claude-sonnet-4-6", "effort": "high" },
    "kraken":           { "model": "anthropic/claude-sonnet-4-6", "effort": "high" },
    "judge":            { "model": "anthropic/claude-sonnet-4-6", "effort": "medium" },
    "plan-agent":       { "model": "anthropic/claude-sonnet-4-6", "effort": "high" },
    "phoenix":          { "model": "anthropic/claude-sonnet-4-6", "effort": "medium" },
    "architect":        { "model": "anthropic/claude-sonnet-4-6", "effort": "high" },
    "general":          { "model": "anthropic/claude-sonnet-4-6", "effort": "medium" },
    "scout":            { "model": "anthropic/claude-haiku-4-6",  "effort": "low" },
    "spark":            { "model": "anthropic/claude-haiku-4-6",  "effort": "low" },
    "arbiter":          { "model": "anthropic/claude-haiku-4-6",  "effort": "low" },
    "scribe":           { "model": "anthropic/claude-haiku-4-6",  "effort": "low" },
    "memory-extractor": { "model": "anthropic/claude-haiku-4-6",  "effort": "low" },
    "explore":          { "model": "anthropic/claude-haiku-4-6",  "effort": "low" }
  }
}
```

The above is only an EXAMPLE for an anthropic-only host — substitute the actual
models you found in Step 1. Pass `configPath` only if the user specified an explicit
target.

`autoconfig_apply` preserves the rest of the config, creates missing agent entries,
and writes a `.bak` backup **the first time** it touches a file (a re-run keeps the
original pristine backup instead of overwriting it). It also VALIDATES every
assignment against the host's known providers: if any model uses a provider that is
not authenticated/declared/known, the whole apply is REJECTED (nothing is written, no
backup is made) and the error lists the offending `agent -> model` pairs plus the
valid provider ids. A known provider with an un-enumerated model id still applies, but
returns a non-fatal warning. If you set `effort` on a model that is NOT reasoning-
capable, the `variant` is skipped and a warning is returned (the model is applied).
If it returns an error (unknown provider, or the config could not be parsed), report
the error and DO NOT retry blindly — the original file is untouched. Surface any
`warnings` to the user.

## Tools (everything is done through these — no manual file edits)

- `autoconfig_inspect` — detect providers/models, authentication, reasoning support,
  resolved config path, and current agent mapping.
- `autoconfig_apply` — write the chosen per-agent model + effort/variant, with a
  one-time `.bak` backup and full content preservation. Validates providers and
  rejects unknown ones; skips `variant` for non-reasoning models (with a warning).

## Output

Present a clear **table** of every change: `agent | old model -> new model | effort`,
plus the config path that was written and the backup path. Group the table by the
three role tiers so the reasoning is obvious. End by telling the user explicitly:

> Restart `opencode` for these changes to take effect.
