# Installation & Configuration

**continuous-code** is an OpenCode plugin that adds agent orchestration, persistent memory, and multi-agent workflows. Installation is a single command; everything else is optional configuration.

**Related docs:** [README](../README.md) · [Agents](agents.md) · [Memory & Recall](memory.md) · [Workflows](workflows.md) · [Architecture](architecture.md)

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick install (one-liner)](#quick-install-one-liner)
- [Manual install (git clone)](#manual-install-git-clone)
- [What install.sh does](#what-installsh-does)
- [install.sh flags](#installsh-flags)
- [Configuration reference](#configuration-reference)
  - [Component toggles](#component-toggles)
  - [Memory](#memory)
  - [Embeddings](#embeddings)
  - [Extras](#extras)
  - [Autoconfig](#autoconfig)
  - [Watchdog](#watchdog)
  - [Workflows / Ultracode](#workflows--ultracode)
  - [CC-v3 reuse policy](#cc-v3-reuse-policy)
- [Install-time autoconfig](#install-time-autoconfig)
- [Uninstall](#uninstall)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **git** | For cloning the repo |
| **node >= 18** | Runtime and build (TypeScript) |
| **npm** or **bun** | Package manager for plugin build |
| **docker** | Optional — only needed for `memory.mode=postgres` with `provision=docker` |

The default install (SQLite memory, no extras) requires only git, node, and npm/bun. Docker is never needed for the standard path.

---

## Quick install (one-liner)

```bash
curl -fsSL https://raw.githubusercontent.com/sahelea1/continuous-code/prod/bootstrap.sh | bash
```

`bootstrap.sh` is pipe-to-bash safe (it never uses `$0` or `$BASH_SOURCE`). It:

1. Clones (or updates) the `prod` branch into `~/.local/share/continuous-code`.
2. Seeds an editable `continuous-code.config.jsonc` from the committed example (first run only).
3. Optionally opens the config in `$EDITOR` when a terminal is attached.
4. Runs `install.sh` from the cloned directory.

After install, **open a new shell** (or `source ~/.zshrc` / `source ~/.bashrc`) so the `opencode` alias takes effect.

---

## Manual install (git clone)

Use this path if you want to pin a specific commit, work on the plugin source, or install without curl.

```bash
# Clone the prod branch (the only branch)
git clone --depth 1 -b prod https://github.com/sahelea1/continuous-code.git ~/.local/share/continuous-code
cd ~/.local/share/continuous-code

# Optional: copy and edit the pre-install config before running install
cp continuous-code.config.example.jsonc continuous-code.config.jsonc
$EDITOR continuous-code.config.jsonc   # optional

# Run the installer
bash install.sh
```

Contributors who want live edits without copying files on each change:

```bash
bash install.sh --symlink
```

---

## What install.sh does

`install.sh` is the single source of truth for the install. It is **fully idempotent** — running it twice is a no-op. It reads `continuous-code.config.jsonc` through `scripts/jsonc.mjs` (a dependency-free JSONC parser; no jq required). Every key has a compiled-in default, so the config file is optional.

Install order:

1. **Build** — `npm install` (or bun) + TypeScript compile to `dist/`.
2. **Agents** — copies `agents/*.md` into `~/.config/opencode/agents/` (22 files).
3. **Commands** — copies `commands/*.md` into `~/.config/opencode/commands/` (11 files).
4. **Workflow assets** — deploys `assets/workflow-dashboard.html`.
5. **opencode.json** — deploys the root plugin config (backs up existing as `.bak`).
6. **consensus.json** — deploys the multi-model consensus config.
7. **thoughts/ skeleton** — creates `thoughts/shared/handoffs/`, `thoughts/ledgers/`.
8. **memory.json + .env** — resolves backend choice and writes runtime env vars.
9. **Extras** — optional tldr, local embeddings, extra MCP servers merged into `opencode.json`.
10. **Autoconfig** — runs `node dist/autoconfig/cli.js apply` (headless, deterministic, no LLM).
11. **Shell alias** — appends `alias opencode='OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode'` to `~/.zshrc` or `~/.bashrc`, guarded by a marker string so re-runs are idempotent.

The plugin is registered in `opencode.json`'s `plugin` array as `opencode-continuous`. OpenCode discovers it on next launch.

---

## install.sh flags

| Flag | Effect |
|---|---|
| `--config <path>` | Use a specific config file instead of the auto-detected one |
| `--symlink` | Symlink agent/command files instead of copying (contributors) |
| `--no-alias` | Skip writing the `opencode` shell alias |
| `--no-autoconfig` | Skip install-time model autoconfig; keep committed defaults |
| `--dry-run` | Print every action but make no changes |
| `--doctor` | Print resolved config state only; no install, no changes |

```bash
# Diagnose what would be installed
bash install.sh --doctor

# Full dry-run (see all actions without writing anything)
bash install.sh --dry-run

# Re-install with a custom config
bash install.sh --config /path/to/my.jsonc
```

---

## Configuration reference

Edit `continuous-code.config.jsonc` (in the clone directory) before running `install.sh`. The file is **pre-install only** — the plugin never reads it at runtime. `install.sh` translates it into `memory.json` and `.env` in the project directory, which the plugin reads at runtime.

The file is JSONC: `//` and `/* */` comments and trailing commas are allowed.

### Component toggles

All components are enabled by default. Set any to `false` to skip that subsystem.

| Key | Default | What it controls |
|---|---|---|
| `components.agents` | `true` | Copy `agents/*.md` into `~/.config/opencode/agents/` |
| `components.commands` | `true` | Copy `commands/*.md` into `~/.config/opencode/commands/` |
| `components.plugin` | `true` | Build the TypeScript plugin and install `dist/` |
| `components.opencodeJson` | `true` | Deploy/merge `opencode.json` into the project |
| `components.thoughts` | `true` | Create the `thoughts/` directory skeleton |
| `components.shellAlias` | `true` | Write the `opencode` background-subagents alias |
| `components.consensus` | `true` | Deploy `consensus.json` (multi-model deliberation) |

### Memory

The plugin persists learnings across sessions via a memory backend. The default is SQLite — no extra services needed.

```jsonc
"memory": {
  "mode": "sqlite"   // sqlite | postgres | none
}
```

#### mode

| Value | Description |
|---|---|
| `sqlite` | **Default.** Zero-infra. File stored at `~/.config/opencode/continuous/memory.db` (XDG-aware). |
| `postgres` | PostgreSQL + pgvector. Requires provisioning (see below). |
| `none` | Memory disabled. The memory-awareness hook is silenced. |

#### SQLite settings

| Key | Default | Description |
|---|---|---|
| `memory.sqlite.path` | `~/.config/opencode/continuous/memory.db` | SQLite file path; created if missing |

#### PostgreSQL settings

| Key | Default | Description |
|---|---|---|
| `memory.postgres.provision` | `docker` | How to obtain a postgres server: `docker` (spins up `db/docker-compose.yml` on port 5433), `native` (uses host psql), `skip` (use `url` only) |
| `memory.postgres.dbName` | `continuous_code` | Database name on the standalone postgres server |
| `memory.postgres.user` | `continuous` | Database user |
| `memory.postgres.password` | `continuous_dev` | Database password |
| `memory.postgres.port` | `5433` | Standalone container port (avoids clashing with CC-v3 on :5432) |
| `memory.postgres.url` | `""` | Explicit connection string. When set, overrides everything else and wins over CC-v3 detection. |

The standalone docker container is named `continuous-code-postgres` and runs on port **5433**. The database name is `continuous_code`.

### Embeddings

Embeddings enable semantic (vector) recall in addition to full-text search. The default is `none` — fast, no API keys required.

```jsonc
"memory": {
  "embeddings": {
    "provider": "none"   // none | voyage | openai | ollama | local
  }
}
```

| Key | Default | Description |
|---|---|---|
| `memory.embeddings.provider` | `none` | Embedding provider. `none` = text-only BM25 recall. |
| `memory.embeddings.model` | `""` | Optional model override (uses provider default if empty) |
| `memory.embeddings.apiKeyEnv` | `VOYAGE_API_KEY` | Environment variable holding the API key |

**1024-dim constraint:** The shared PostgreSQL schema uses `vector(1024)`. Only `voyage` (voyage-3, 1024-dim) is compatible when using postgres (standalone or reused CC-v3). The `openai` provider (1536-dim) is **SQLite-only**. `install.sh` enforces this and will warn and block a mismatched combination.

See [Memory & Recall](memory.md) for full embedding provider details.

### Extras

All extras are opt-in. They do not affect the core install.

| Key | Default | Description |
|---|---|---|
| `extras.tldr` | `"auto"` | `"auto"` = use `tldr` if already on PATH; `true` = attempt `npm install -g llm-tldr`; `false` = never |
| `extras.localEmbeddings` | `false` | Install offline BGE embedding stack via pip/uv (`sentence-transformers`) |
| `extras.mcpServers` | `{}` | Object merged verbatim into the `mcp` block in `opencode.json`. Add MCP server entries here. |

Example adding an MCP server:

```jsonc
"extras": {
  "mcpServers": {
    "firecrawl": { "type": "local", "command": ["npx", "-y", "firecrawl-mcp"] }
  }
}
```

### Autoconfig

At install time, `install.sh` runs a headless provider detection pass and writes per-agent `model` and `variant` assignments into `opencode.json`. This is deterministic and makes no LLM calls.

| Key | Default | Description |
|---|---|---|
| `autoconfig.enabled` | `true` | Run headless autoconfig at install time |
| `autoconfig.prefer` | `""` | Provider hint (e.g. `"anthropic"`); biased to front of selection when authenticated |
| `autoconfig.fallbackModel` | `"ollama-cloud/deepseek-v4-pro"` | Assigned to all agents when no provider is authenticated |
| `autoconfig.dryRun` | `false` | Print the plan without writing `opencode.json` |

Detection sources (merged in priority order): `auth.json` keys, declared config providers, `opencode models` CLI output, built-in fallback registry, current `opencode.json`. When no provider is authenticated, all agents receive `fallbackModel`.

You can re-run autoconfig at any time via the `/autoconfagent` slash command inside OpenCode.

### Watchdog

The watchdog arms a recurring timer when the orchestrator spawns background subagents. When the timer fires and subagents are still running, the idle orchestrator is nudged to check their status. The watchdog never aborts agents on its own.

| Key | Default | Description |
|---|---|---|
| `watchdog.enabled` | `true` | Master on/off. Env var `OPENCODE_CONTINUOUS_WATCHDOG=0` wins at runtime. |
| `watchdog.intervalMinutes` | `20` | How often the watchdog nudges the orchestrator |
| `watchdog.maxWakes` | `6` | Hard cap on consecutive nudges per session (loop guard) |

Runtime override: set `OPENCODE_CONTINUOUS_WATCHDOG=0` to disable without editing the config.

### Workflows / Ultracode

The workflow engine powers the `/ultracode` command and `ultra-orchestrator` agent. It fans out real OpenCode child sessions in parallel or pipeline mode, with a live dashboard and drift detection.

| Key | Default | Description |
|---|---|---|
| `workflow.enabled` | `true` | Master on/off. Env `OPENCODE_CONTINUOUS_WORKFLOW=0` wins at runtime. |
| `workflow.dashboardEnabled` | `true` | Start the live workflow dashboard (requires Bun) |
| `workflow.dashboardPort` | `7878` | TCP port for the workflow dashboard HTTP server |
| `workflow.concurrency` | `0` | Max concurrent agent sessions. `0` = auto: `min(16, max(2, cpuCores-2))` |
| `workflow.driftEnabled` | `true` | Enable round-robin drift detection on active child sessions |
| `workflow.driftIntervalMs` | `90000` | Drift sweep interval in milliseconds (default 90 s) |
| `workflow.driftCapTokens` | `40000` | Hard cap on tokens sent to the drift-watcher per sweep (enforced host-side) |
| `workflow.perAgentContextCapTokens` | `60000` | Per-agent context injection budget; artifact summaries trimmed at this ceiling |
| `workflow.maxAgents` | `1000` | Hard ceiling on total agent sessions spawned in one workflow run |
| `workflow.storeLearnings` | `false` | Store the synthesized workflow result as a `WORKING_SOLUTION` memory on completion |

See [Workflows](workflows.md) for the full usage guide.

### CC-v3 reuse policy

If you have Continuous-Claude-v3 installed, its postgres server can be opportunistically reused.

| Key | Default | Description |
|---|---|---|
| `reuseExistingCcV3` | `true` | When the container `continuous-claude-postgres` is detected on `:5432`, reuse its server in continuous-code's own isolated `continuous_code` database. **Never touches CC-v3's `continuous_claude` database.** |
| `forceStandalone` | `false` | `true` = never reuse CC-v3; always use sqlite or provision standalone postgres. Guarantees no dependency on any CC-v3 install. |

For a guaranteed pure-sqlite install (no postgres at all), set either `reuseExistingCcV3: false` **or** `forceStandalone: true`.

---

## Install-time autoconfig

When `autoconfig.enabled` is `true` (the default), `install.sh` invokes `node dist/autoconfig/cli.js apply` after the TypeScript build. The autoconfig:

- Reads `~/.local/share/opencode/auth.json` to detect which providers have keys.
- Queries `opencode models` for the available model list (8 s timeout, best-effort).
- Assigns models deterministically by role tier:
  - **Orchestrator tier** — `orchestrator`
  - **Heavy tier** — `oracle`, `sleuth`, `kraken`, `judge`, `plan-agent`, `phoenix`, `architect`, `general`
  - **Light tier** — `scout`, `spark`, `arbiter`, `scribe`, `memory-extractor`, `explore`
- Writes per-agent `model` and `variant` into `opencode.json` with a `.bak` backup.
- Exits `0` when no provider is authenticated (prints a hint; does not abort the install).

The result is a project `opencode.json` tuned to the providers you actually have access to, without any prompt or LLM call. You can redo it any time:

```bash
# Via slash command (inside OpenCode)
/autoconfagent

# Via CLI directly
node dist/autoconfig/cli.js inspect    # show detected providers
node dist/autoconfig/cli.js apply      # write opencode.json
```

---

## Uninstall

```bash
cd ~/.local/share/continuous-code && bash uninstall.sh
```

`uninstall.sh`:

- Removes all agent files from `~/.config/opencode/agents/`.
- Removes all command files from `~/.config/opencode/commands/`.
- Notes any plugin reference in `opencode.json` that requires manual removal.
- Interactively offers to stop the **standalone** `continuous-code-postgres` container (never touches the CC-v3 `continuous-claude-postgres` container).
- Interactively offers to remove `.env` and `memory.json`.
- **Never removes `thoughts/`** — this directory contains your session handoffs, ledgers, and plans. Delete it manually if you no longer need it.

---

## Troubleshooting

<details>
<summary>Memory degrades to none silently</summary>

The memory backend factory never throws. If the backend fails to open, it silently degrades to `NoneBackend` with a one-time warning in the OpenCode log. Causes:

- **SQLite**: the `memory.db` path is not writable. Check `~/.config/opencode/continuous/` permissions.
- **Postgres**: the connection URL is wrong, the container is not running, or `pg` native bindings failed to build. Run `bash install.sh --doctor` to see the resolved URL.
- **Missing optional dep**: `better-sqlite3` or `pg` are listed as optional dependencies. If they failed to build (native addons), the backend falls back to `none`. Re-run `npm install` inside the plugin directory.

To check which backend is active, set `OPENCODE_LOG_LEVEL=debug` and look for the backend init log line.

</details>

<details>
<summary>Provider not detected by autoconfig</summary>

Autoconfig reads `~/.local/share/opencode/auth.json`. If a provider is not detected:

1. Authenticate the provider inside OpenCode first, then re-run `/autoconfagent`.
2. Or set `autoconfig.prefer` in `continuous-code.config.jsonc` to the provider ID and re-run `bash install.sh`.
3. Or run `node dist/autoconfig/cli.js inspect` to see what is currently detected.

When no provider is authenticated, all agents receive `autoconfig.fallbackModel` (default `ollama-cloud/deepseek-v4-pro`).

</details>

<details>
<summary>Port conflicts (dashboard on 7878, postgres on 5433)</summary>

**Dashboard port conflict**: set `workflow.dashboardPort` in `continuous-code.config.jsonc` to a free port and re-run `install.sh`. Or set `workflow.dashboardEnabled: false` to disable the dashboard entirely.

**Postgres port conflict** (standalone docker only): set `memory.postgres.port` in `continuous-code.config.jsonc` to a free port. The standalone container binds to this port on the host; the internal postgres port remains 5432.

If you set a custom port, also update `memory.postgres.url` (or `CONTINUOUS_CODE_DB_URL`) to match, because the derived URL uses the configured port.

</details>

<details>
<summary>Running install --doctor</summary>

`--doctor` prints the full resolved state without making any changes:

```bash
cd ~/.local/share/continuous-code && bash install.sh --doctor
```

Output includes: detected config file path, all resolved component toggles, resolved memory backend and URL, resolved embedding provider, autoconfig enabled/disabled state, watchdog settings, and workflow settings. Use this to confirm that `continuous-code.config.jsonc` is being parsed as expected.

</details>

<details>
<summary>The shell alias is not taking effect</summary>

`install.sh` appends the alias to `~/.zshrc` or `~/.bashrc`. You must either open a new terminal or run:

```bash
source ~/.zshrc   # or ~/.bashrc
```

The alias injects `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` so OpenCode enables background task spawning. Without it, the orchestrator can still spawn subagents but they run serially rather than in the background.

If you do not want the alias, pass `--no-alias` on the next install run.

</details>
