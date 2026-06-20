# opencode-continuous


```
 +--------------------------------------------------+
 |   ___  _ __   ___ _ __   ___ ___   __| | ___     |
 |  / _ \| '_ \ / _ \ '_ \ / __/ _ \ / _` |/ _ \   |
 | | (_) | |_) |  __/ | | | (_| (_) | (_| |  __/   |
 |  \___/| .__/ \___|_| |_|\___\___/ \__,_|\___|   |
 |  ___ _|_|  _ __ | |_(_)_ __  _   _  ___  _   _ ___|
 | / __|/ _ \| '_ \| __| | '_ \| | | |/ _ \| | | / __|
 | | (_| (_) | | | | |_| | | | | |_| | (_) | |_| \__ \
 |  \___\___/|_| |_|\__|_|_| |_|\__,_|\___/ \__,_|___/
 +--------------------------------------------------+
```

**Agent-only orchestration for OpenCode -- 14 specialist subagents (plus 3 delegate-only orchestrators), zero direct execution.**

---

## Feature Highlights

- **Agent-only execution** -- orchestrators never read, grep, or run commands; everything goes through the `task` tool to specialized subagents
- **Three orchestrator tiers** -- `build`, `plan`, and the general-purpose `orchestrator` agent; each delegates only and has all direct-tool permissions denied
- **High-effort variants** -- optional `*-openai` subagents (GPT-5.4 at `xhigh` reasoning) for the hardest logic or second opinions
- **Parallel delegation** -- spawn multiple subagents concurrently via the `parallel_delegate` custom tool
- **Session continuity** -- YAML handoffs and markdown ledgers persist state across sessions, compatible with Continuous Claude v3 format
- **Skill activation** -- intent keywords in your prompt are detected and routed to the right agent pipeline automatically
- **10 slash commands** -- `/fix`, `/build`, `/tdd`, `/explore`, `/review`, `/refactor`, `/handoff`, `/resume`, `/consensus`, `/autoconfagent`
- **Per-agent model config** -- every agent can use a different model and provider; defaults to free Ollama Cloud (DeepSeek V4) for workers and Z.AI GLM-5.2 for orchestrators
- **Auto-configuration** -- `/autoconfagent` detects the providers on your host and writes the optimal model + reasoning effort for every agent into `opencode.json`
- **Two-layer enforcement** -- frontmatter permissions + plugin hook ensure orchestrators delegate, never execute
- **Docker support** -- isolated container execution for testing and CI

---

## Quick Start

### Script Install (3 steps)

```bash
git clone https://github.com/your-org/opencode-continuous.git
cd opencode-continuous && ./install.sh
source ~/.bashrc   # or ~/.zshrc — activates the opencode alias
opencode
```

### Docker (2 steps)

```bash
git clone https://github.com/your-org/opencode-continuous.git
cd opencode-continuous && ./launch.sh /path/to/your/project
```

---

## Installation

### Script Install

```bash
./install.sh
```

This will:

1. Install npm dependencies and build the TypeScript plugin
2. Copy agent `.md` files to `~/.config/opencode/agents/`
3. Copy command `.md` files to `~/.config/opencode/commands/`
4. Install the plugin into OpenCode's config-level `node_modules`
5. Create `opencode.json` in the current directory (existing file backed up to `.bak`)
6. Create the `thoughts/shared/handoffs/` and `thoughts/ledgers/` directory skeleton
7. Add an `opencode` shell alias to your rc file (`.bashrc` or `.zshrc`) that enables OpenCode's **experimental background subagents**

After install, activate the alias without opening a new shell:

```bash
source ~/.bashrc   # or source ~/.zshrc
```

#### Background subagents alias

The installer writes this alias to your shell rc file:

```bash
alias opencode='OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode'
```

This enables OpenCode's experimental parallel background subagent feature, which the orchestrators rely on for concurrent delegation. If you prefer to manage this yourself or are using a wrapper script, pass `--no-alias` to skip this step:

```bash
./install.sh --no-alias
```

Requires [OpenCode](https://opencode.ai) v1.14.0+ and either `npm` or `bun`.

### Docker Install

```bash
./launch.sh /path/to/your/project
```

| Flag | Description |
|------|-------------|
| (no flags) | Launches interactive opencode session inside the container |
| `/path/to/project` | Mount your project directory as the working directory |

The container bundles OpenCode, the plugin, and all agents. Your project is mounted read-write at `/workspace`.

### Manual Install

If you prefer not to run `install.sh`, do the steps yourself:

```bash
# 1. Build the plugin
npm install && npx tsc

# 2. Copy agents and commands into OpenCode's config directory
cp agents/*.md ~/.config/opencode/agents/
cp commands/*.md ~/.config/opencode/commands/

# 3. Register the plugin in OpenCode's config-level node_modules
cd ~/.config/opencode && npm install file:///absolute/path/to/opencode-continuous

# 4. Copy opencode.json into your project root
cp opencode.json /path/to/your/project/opencode.json

# 5. Create the continuity directory skeleton
mkdir -p /path/to/your/project/thoughts/shared/handoffs
mkdir -p /path/to/your/project/thoughts/ledgers

# 6. Enable background subagents (add to your shell rc manually)
echo "alias opencode='OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode'" >> ~/.bashrc
```

### Contributor Setup

Use `--symlink` so edits to agent/command files take effect immediately without reinstalling:

```bash
./install.sh --symlink
```

This creates symlinks instead of copies. Changes to `agents/*.md` or `commands/*.md` in your clone are reflected instantly in `~/.config/opencode/`.

---

## Configuration

### Providers and Default Models

The default configuration uses two providers:

| Provider | Purpose | Auth |
|----------|---------|------|
| `zai-coding-plan` (Z.AI GLM-5.2) | Orchestrators (`build`, `plan`, `orchestrator`) | `opencode auth login` |
| `ollama-cloud` (DeepSeek V4) | All worker subagents | `opencode auth login` |

Both are free tiers that authenticate through OpenCode's standard login. No separate API keys are required beyond `opencode auth login`.

The default tier split is intentional: orchestrators get a stronger reasoning model (GLM-5.2) while light workers use the faster flash variant of DeepSeek V4, keeping cost low for high-volume delegation.

### Agent Table

| Agent | Role | Tier | Default Model |
|-------|------|------|---------------|
| **build** | Primary orchestrator -- delegates all work | Orchestrator | `zai-coding-plan/glm-5.2` |
| **plan** | Plan orchestrator -- delegates all work | Orchestrator | `zai-coding-plan/glm-5.2` |
| **orchestrator** | General orchestrator -- delegates all work | Orchestrator | `zai-coding-plan/glm-5.2` (`max` variant) |
| scout | Codebase exploration | Light | `ollama-cloud/deepseek-v4-flash` |
| explore | Quick codebase browsing | Light | `ollama-cloud/deepseek-v4-flash` |
| spark | Small one-file fixes | Light | `ollama-cloud/deepseek-v4-flash` |
| arbiter | Test execution and verification | Light | `ollama-cloud/deepseek-v4-flash` |
| scribe | Docs, handoffs, ledgers | Light | `ollama-cloud/deepseek-v4-flash` |
| memory-extractor | Extract session learnings | Light | `ollama-cloud/deepseek-v4-flash` |
| oracle | External research | Heavy | `ollama-cloud/deepseek-v4-pro` |
| sleuth | Bug investigation | Heavy | `ollama-cloud/deepseek-v4-pro` |
| kraken | Implementation (TDD) | Heavy | `ollama-cloud/deepseek-v4-pro` |
| judge | Code review | Heavy | `ollama-cloud/deepseek-v4-pro` |
| plan-agent | Implementation planning | Heavy | `ollama-cloud/deepseek-v4-pro` |
| phoenix | Refactoring planning | Heavy | `ollama-cloud/deepseek-v4-pro` |
| architect | Feature/integration design | Heavy | `ollama-cloud/deepseek-v4-pro` |
| general | General-purpose heavy worker | Heavy | `ollama-cloud/deepseek-v4-pro` |

### High-Effort OpenAI Variants

For the hardest reasoning tasks or when a second opinion is useful, optional `*-openai` agent files are provided. These run on `openai/gpt-5.4` at `xhigh` reasoning effort. The orchestrator's system prompt instructs it to route to these only when the standard worker is insufficient:

| Agent | OpenAI variant |
|-------|---------------|
| kraken | kraken-openai |
| sleuth | sleuth-openai |
| oracle | oracle-openai |
| judge | judge-openai |
| plan-agent | plan-agent-openai |
| phoenix | phoenix-openai |
| architect | architect-openai |

These are available as subagents but are not used by default. The orchestrator's instructions say: "Use `*-openai` alternatives (GPT-5.4 xhigh) only for the hardest logic or when a second opinion is needed."

### Swapping Models

Override any agent in your project's `opencode.json`. Only specify the agents you want to change; the rest keep their defaults.

```json
{
  "agent": {
    "kraken": { "model": "openai/gpt-5.4" }
  }
}
```

### Multiple Providers

You can mix providers freely. Each agent resolves its model independently.

```jsonc
{
  "agent": {
    "build":   { "model": "anthropic/claude-opus-4-8" },    // Anthropic for orchestrator
    "kraken":  { "model": "openai/gpt-5.4" },               // OpenAI for implementation
    "scout":   { "model": "anthropic/claude-sonnet-4-6" },  // Anthropic for exploration
    "oracle":  { "model": "anthropic/claude-opus-4-7" }     // Anthropic for research
  }
}
```

See `opencode.example.jsonc` for ready-to-copy patterns.

---

## Usage

### Agent Reference

| Agent | When to Use |
|-------|-------------|
| scout | Read files, search code, understand codebase structure |
| explore | Quick browse of a directory or file set |
| oracle | Research external APIs, documentation, or web content |
| sleuth | Investigate a bug, trace a root cause |
| kraken | Implement a feature, write production code, run TDD loops |
| spark | Small one-file fixes, quick edits, trivial changes |
| arbiter | Run tests, verify correctness, check pass/fail |
| judge | Review code quality, spot issues before merging |
| plan-agent | Break a feature into a concrete implementation plan |
| phoenix | Plan a refactor or migration across multiple files |
| architect | Design a new feature or integration at the system level |
| scribe | Write handoffs, update continuity ledgers, session notes |
| memory-extractor | Pull learnings out of a session for future recall |
| general | General-purpose heavy work that doesn't fit a specialist role |

You never invoke agents directly. The active orchestrator dispatches them based on your request or the active slash command.

### Command Pipelines

| Command | Pipeline |
|---------|----------|
| `/fix` | sleuth investigates -> spark or kraken implements -> arbiter verifies |
| `/build` | architect or plan-agent plans -> kraken implements -> arbiter tests |
| `/tdd` | plan-agent defines tests -> arbiter runs red -> kraken goes green -> arbiter confirms |
| `/explore` | scout reads relevant code -> oracle researches if needed -> summary returned |
| `/review` | scout reads changes -> judge reviews -> scribe records findings |
| `/refactor` | phoenix plans -> kraken implements -> judge reviews -> arbiter verifies |
| `/handoff` | scribe writes YAML handoff + updates continuity ledger |
| `/resume` | scribe loads latest handoff -> context restored for next session |
| `/consensus` | configure and control the multi-model consensus panel |
| `/autoconfagent` | detect available providers and auto-assign optimal models to all agents |

---

## Auto-Configuration: `/autoconfagent`

Running `/autoconfagent` tells the LLM to inspect which providers are actually authenticated on your host, then automatically pick the best model and reasoning effort (`variant`) for every agent and write the result into `opencode.json`. You never hand-edit anything -- the command uses the `autoconfig_inspect` and `autoconfig_apply` tools to do this programmatically, with a `.bak` backup of your previous config.

### What it does

1. **Inspect** -- calls `autoconfig_inspect` to enumerate all providers, authentication status, available models, and reasoning variant support.
2. **Choose** -- assigns models by role tier:
   - **Orchestrators** (`build`, `plan`, `orchestrator`): strongest available model at the highest effort (`xhigh` if supported, otherwise `max`)
   - **Heavy subagents** (`oracle`, `sleuth`, `kraken`, `judge`, `plan-agent`, `phoenix`, `architect`, `general`): strong model at `medium` or `high` effort
   - **Light subagents** (`scout`, `spark`, `arbiter`, `scribe`, `memory-extractor`, `explore`): fast/cheap model at `low` effort
3. **Apply** -- calls `autoconfig_apply` once with the full assignments map and reports a table of every change.
4. **Report** -- shows you `agent | old model -> new model | effort` grouped by tier, then tells you to restart opencode.

### Example: Anthropic-only host

If only the Anthropic provider is authenticated, `/autoconfagent` would produce assignments like:

```
build           anthropic/claude-opus-4-8   xhigh
plan            anthropic/claude-opus-4-8   xhigh
orchestrator    anthropic/claude-opus-4-8   xhigh
kraken          anthropic/claude-sonnet-4-6  high
oracle          anthropic/claude-sonnet-4-6  high
sleuth          anthropic/claude-sonnet-4-6  high
architect       anthropic/claude-sonnet-4-6  high
plan-agent      anthropic/claude-sonnet-4-6  high
judge           anthropic/claude-sonnet-4-6  medium
phoenix         anthropic/claude-sonnet-4-6  medium
general         anthropic/claude-sonnet-4-6  medium
scout           anthropic/claude-haiku-4-6   low
spark           anthropic/claude-haiku-4-6   low
arbiter         anthropic/claude-haiku-4-6   low
scribe          anthropic/claude-haiku-4-6   low
memory-extractor anthropic/claude-haiku-4-6  low
explore         anthropic/claude-haiku-4-6   low
```

You can also pass a preference hint: `/autoconfagent prefer anthropic` or `/autoconfagent stay on the current providers`.

After the command finishes, **restart opencode** for the new config to take effect.

---

## Handoff Format

Handoffs are stored as YAML at `thoughts/shared/handoffs/<session-slug>/<ISO-timestamp>.yaml`.

```yaml
goal: "What the session aimed to accomplish"    # REQUIRED
now: "Current state / what was being worked on" # REQUIRED
test: "Command to run tests"
done_this_session:
  - Item completed 1
  - Item completed 2
blockers: []
questions:
  - Open question 1
decisions:
  - Decision made 1
findings:
  - Discovery 1
worked:
  - Approach that succeeded
failed:
  - Approach that didn't work
next:
  - Next step 1
  - Next step 2
files:
  - path/to/file1.ts
  - path/to/file2.ts
```

`goal` and `now` are required. All other fields are optional. Use `/resume` at the start of a new session to load the latest handoff and restore context.

Continuity ledgers are markdown checklists at `thoughts/ledgers/CONTINUITY_<topic>.md`, tracking goals, completed items, in-progress work, and blockers across sessions.

---

## Multi-Model Consensus

A toggleable sub-plugin that layers on top of the agent-only orchestration model. When enabled, the primary orchestrator forms substantive answers, plans, decisions, and analyses by asking **multiple AI models in parallel** (across providers at once) and producing **one combined consensus answer**. A designated **main** model is dominant: it synthesizes the final answer, breaks ties, and may override dissent when justified. The result behaves like a normal model answer in OpenCode.

### Concept

- A **panel** of models is queried simultaneously -- for example OpenRouter models *and* ollama-cloud models at the same time, each with its own reasoning effort.
- Exactly one panel member is the **main** (dominant) model. It is the tie-breaker.
- The orchestrator calls `consensus_deliberate` to form any substantive answer and bases its reply on the returned consensus. All other tool usage and file edits still go through subagents via the `task` tool.
- **Single instance, no recursion** -- there is exactly ONE consensus instance: the primary orchestrator. Subagents it spawns via `task` are ordinary single-model workers; they do NOT run consensus and cannot call `consensus_deliberate`. `consensus_deliberate` refuses to run in a child/sub-agent session, deliberations are serialized one-at-a-time within the process, and the system prompt reinforces that no subagent may run in consensus mode.

### Configuration

Consensus is configured in `consensus.json` at the project root (default **disabled** -- opt-in). See `consensus.example.jsonc` for a fully commented template.

```json
{
  "enabled": false,
  "synthesis": "main-judge",
  "maxTokens": 1024,
  "temperature": 0.3,
  "providers": {
    "openrouter": { "baseURL": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" },
    "ollama-cloud": { "baseURL": "https://ollama.com/v1", "apiKeyEnv": "OLLAMA_API_KEY" }
  },
  "panel": [
    { "id": "opus", "provider": "openrouter", "model": "anthropic/claude-opus-4.6", "reasoning": "high", "main": true },
    { "id": "grok", "provider": "openrouter", "model": "x-ai/grok-4", "reasoning": "medium" },
    { "id": "deepseek", "provider": "ollama-cloud", "model": "deepseek-v4-pro", "reasoning": "low" }
  ]
}
```

- **Toggle** with the `consensus_toggle` / `consensus_configure` tools (or `/consensus on|off`), or via the `CONSENSUS_ENABLED` env var. You normally never edit `consensus.json` by hand -- see *Managing consensus from the OpenCode TUI* below.
- **Per-model reasoning effort** -- `none|minimal|low|medium|high|xhigh`, applied for OpenRouter models only (ignored for ollama-cloud, which has no reasoning object).
- **Cross-provider mixing** -- list members on different providers; OpenRouter and ollama-cloud are queried in parallel.
- **`requireParameters`** (default `false`) -- when `false`, OpenRouter drops unsupported params (e.g. `reasoning`) so models still answer (graceful degradation); set `true` for strict reasoning routing (404s if an endpoint lacks `reasoning`), and only when the whole panel is curated to reasoning-capable models.

### Synthesis modes

| Mode | How it works | Constraint |
|------|--------------|-----------|
| `main-judge` (default) | Client-side fan-out: all panel models answer in parallel, then the main model synthesizes one answer and reports an agreement score plus whether it overrode dissent. | Works across providers |
| `fusion` | Native OpenRouter Fusion: a single OpenRouter request runs all analysis models + a judge server-side. | All panel members must use the `openrouter` provider |

### Environment variables

- `OPENROUTER_API_KEY` -- required for OpenRouter models.
- `OLLAMA_API_KEY` -- for ollama-cloud models (if your endpoint requires auth).

Keys are read only from these env vars (named by each provider's `apiKeyEnv`); never store keys in `consensus.json`. Use `consensus_status` to see which keys are present (reported as `set`/`missing`, never the value).

### Tools

| Tool | Purpose |
|------|---------|
| `consensus_deliberate` | Get a combined consensus answer from the panel |
| `consensus_status` | Inspect config, panel, and provider key availability |
| `consensus_toggle` | Enable/disable consensus mode |
| `consensus_configure` | Enable/disable, add/remove panel models, set main/synthesis/reasoning, clear |
| `consensus_models` | List/search models available for the panel (from OpenRouter) |

### Managing consensus from the OpenCode TUI

You control everything from the terminal -- by chatting or via the `/consensus` slash command. **You never hand-edit `consensus.json`**; the plugin writes it programmatically through the tools above (all writes share one serializer).

In plain chat, just describe what you want, e.g.:

> enable consensus with grok-4 and claude-opus, make opus the main with high reasoning

The orchestrator maps that to `consensus_configure` calls (`action=add`, `action=set-main`, `action=set-reasoning`, `action=enable`) and confirms with `consensus_status`.

Via the `/consensus` command, quick subcommands act immediately:

| Subcommand | Effect |
|------------|--------|
| `/consensus` (no args) | Interactive setup: lists models, asks which to include, which is main, reasoning per model |
| `/consensus on` \| `off` | Enable / disable consensus |
| `/consensus status` | Show current state |
| `/consensus list [search]` | List/search available models (`consensus_models`) |
| `/consensus add <slug> [reasoning]` | Add a model to the panel |
| `/consensus remove <id\|slug>` | Remove a panel member |
| `/consensus main <id>` | Set the dominant main model |
| `/consensus synthesis <main-judge\|fusion>` | Set synthesis mode |
| `/consensus reasoning <id> <effort>` | Set a member's reasoning effort |
| `/consensus clear` | Empty the panel |

Use `consensus_models` to discover slugs/prices/reasoning support, then `consensus_configure action=add model=<slug>` to add them.

### Cost note

Running multiple premium models in parallel multiplies cost -- every deliberation issues one request per panel member plus (in `main-judge` mode) one synthesis call by the main model. Keep the panel small and reasoning effort proportionate, and prefer cheaper models for non-main members.

---

## Architecture

### Orchestrator Design

There are three orchestrator agents. All three have identical permission policies: every direct-action tool (`read`, `grep`, `glob`, `list`, `bash`, `edit`, `webfetch`, `websearch`) is denied. The only permitted tools are `task`, `todowrite`, `skill`, and `question`.

| Agent | Primary Use | Notes |
|-------|------------|-------|
| `build` | General build and implementation workflows | Registered as `default_agent` |
| `plan` | Planning-heavy workflows, feature decomposition | Routed by `/build`, `/tdd` |
| `orchestrator` | General-purpose orchestration | `max` variant, 200 steps, temperature 0.7 |

All three instruct the model to spawn subagents in parallel wherever tasks are independent, and to use `*-openai` variants only for the hardest reasoning or second opinions.

### Two-Layer Enforcement

```
  User prompt
       |
       v
  +--------------------+
  |  Orchestrator      |  Layer 1: frontmatter permissions
  |  (build / plan /   |  read, grep, glob, list, bash,
  |   orchestrator)    |  webfetch, websearch, edit = "deny"
  |                    |  task, todowrite, skill, question = "allow"
  +---------+----------+
            |
            | task tool only
            v
  +---------+----------+
  |  Subagent          |  Layer 2: plugin hook
  |  (scout, kraken,   |  enforce-agent-only.ts intercepts
  |   sleuth, etc.)    |  denied tool prompts and rewrites
  |                    |  the error to name the correct
  +---------+----------+  subagent -- model learns the
            |              delegation pattern
            v
  +---------+----------+
  |  Tool execution    |
  |  (read, bash,      |
  |   edit, grep ...)  |
  +--------------------+
```

Both layers are required. The frontmatter blocks the tool call; the hook makes the error message actionable so the model corrects itself.

### Plugin Hooks

| Hook | File | Purpose |
|------|------|---------|
| enforce-agent-only | `src/hooks/enforce-agent-only.ts` | Rewrites denied-tool errors to name the correct subagent |
| session-start | `src/hooks/session-start.ts` | Initializes session state and continuity context |
| skill-activation | `src/hooks/skill-activation.ts` | Detects intent keywords and routes to agent pipelines |
| compaction-handoff | `src/hooks/compaction-handoff.ts` | Auto-saves a handoff when context window compacts |
| memory-awareness | `src/hooks/memory-awareness.ts` | Surfaces relevant learnings from prior sessions |
| consensus-mode | `src/hooks/consensus-mode.ts` | Injects multi-model consensus instructions into the primary agent's system prompt when consensus is enabled |

### Custom Tools

| Tool | File | Purpose |
|------|------|---------|
| handoff_save | `src/tools/handoff-save.ts` | Write a YAML handoff to `thoughts/shared/handoffs/` |
| handoff_load | `src/tools/handoff-load.ts` | Load the latest handoff for a session |
| ledger_update | `src/tools/ledger-update.ts` | Update a continuity ledger in `thoughts/ledgers/` |
| parallel_delegate | `src/tools/parallel-delegate.ts` | Spawn multiple subagents concurrently |
| autoconfig_inspect | `src/tools/autoconfig.ts` | Enumerate providers, models, and auth status |
| autoconfig_apply | `src/tools/autoconfig.ts` | Write per-agent model + effort assignments to `opencode.json` |

---

## Docker

### Running Tests

```bash
bash tests/docker/run.sh
```

Prerequisites: Docker installed, `opencode auth login` completed (credentials read from `~/.local/share/opencode/auth.json`).

The test suite runs 6 scenarios in an isolated container:

| Scenario | What it verifies |
|----------|-----------------|
| Agent-only enforcement | Primary agent cannot read/grep/bash directly |
| Handoff round-trip | Write then load a YAML handoff |
| Resume | Load handoff and restore context |
| Parallel delegation | Multiple subagents spawned concurrently |
| Model swap | Override a single agent's model via config |
| CC-v3 compatibility | Handoff format matches CC-v3 spec |

### Using launch.sh

`launch.sh` runs an interactive opencode session inside a Docker container with the plugin pre-installed:

```bash
# Launch with your project mounted at /workspace
./launch.sh /path/to/your/project

# Launch with the current directory
./launch.sh .
```

The container mounts your project read-write, so all file changes persist on the host. Auth credentials are forwarded from `~/.local/share/opencode/auth.json`.

---

## Adding a New Agent

1. Create `agents/my-agent.md` with frontmatter:

```markdown
---
model: "ollama-cloud/deepseek-v4-flash"
mode: "subagent"
description: "When the primary agent should use this agent"
permission:
  read: "allow"
  edit: "deny"
  bash: "deny"
---

System prompt for my-agent goes here.
```

2. Add a model config entry to `opencode.json`:

```json
{
  "agent": {
    "my-agent": { "model": "ollama-cloud/deepseek-v4-flash" }
  }
}
```

3. Reinstall to deploy the new agent file:

```bash
./install.sh
```

---

## Uninstall

```bash
./uninstall.sh
```

This removes agent and command files from `~/.config/opencode/agents/` and `~/.config/opencode/commands/` that were installed by this plugin. It does **not** remove:

- `opencode.json` (your project config)
- `thoughts/` (your session data)
- `dist/` (built plugin output)

To remove session data manually: `rm -rf thoughts/`

The installer-added shell alias is not removed automatically. To remove it, delete the `opencode-continuous` alias block from your `~/.bashrc` or `~/.zshrc`.

---

## License

MIT
