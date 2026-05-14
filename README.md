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

**Agent-only orchestration for OpenCode -- 12 specialists, zero direct execution.**

---

## Feature Highlights

- **Agent-only execution** -- the primary `build` agent never reads, greps, or runs commands; everything goes through the `task` tool to 12 specialized subagents
- **Parallel delegation** -- spawn multiple subagents concurrently via the `parallel_delegate` custom tool
- **Session continuity** -- YAML handoffs and markdown ledgers persist state across sessions, compatible with Continuous Claude v3 format
- **Skill activation** -- intent keywords in your prompt are detected and routed to the right agent pipeline automatically
- **8 slash commands** -- `/fix`, `/build`, `/tdd`, `/explore`, `/review`, `/refactor`, `/handoff`, `/resume`
- **Per-agent model config** -- every agent can use a different model and provider; defaults to free Ollama Cloud (DeepSeek V4)
- **Two-layer enforcement** -- frontmatter permissions + plugin hook ensure the orchestrator delegates, never executes
- **Docker support** -- isolated container execution for testing and CI

---

## Quick Start

### Script Install (3 steps)

```bash
git clone https://github.com/your-org/opencode-continuous.git
cd opencode-continuous && ./install.sh
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
```

### Contributor Setup

Use `--symlink` so edits to agent/command files take effect immediately without reinstalling:

```bash
./install.sh --symlink
```

This creates symlinks instead of copies. Changes to `agents/*.md` or `commands/*.md` in your clone are reflected instantly in `~/.config/opencode/`.

---

## Configuration

### Default Model Assignments

All 13 agents (1 primary + 12 subagents) and their default models:

| Agent | Role | Default Model |
|-------|------|---------------|
| build (primary) | Orchestrator -- delegates all work | `ollama-cloud/deepseek-v4-pro` |
| scout | Codebase exploration | `ollama-cloud/deepseek-v4-flash` |
| oracle | External research | `ollama-cloud/deepseek-v4-pro` |
| sleuth | Bug investigation | `ollama-cloud/deepseek-v4-pro` |
| kraken | Implementation (TDD) | `ollama-cloud/deepseek-v4-pro` |
| spark | Quick fixes | `ollama-cloud/deepseek-v4-flash` |
| arbiter | Test execution | `ollama-cloud/deepseek-v4-flash` |
| judge | Code review | `ollama-cloud/deepseek-v4-pro` |
| plan-agent | Implementation planning | `ollama-cloud/deepseek-v4-pro` |
| phoenix | Refactoring planning | `ollama-cloud/deepseek-v4-pro` |
| architect | Feature/integration design | `ollama-cloud/deepseek-v4-pro` |
| scribe | Docs, handoffs, ledgers | `ollama-cloud/deepseek-v4-flash` |
| memory-extractor | Extract session learnings | `ollama-cloud/deepseek-v4-flash` |

Defaults use Ollama Cloud (free, no API key required beyond `opencode auth login`).

### Swapping Models

Override any agent in your project's `opencode.json`. Only specify the agents you want to change; the rest keep their defaults.

```json
{
  "agent": {
    "kraken": { "model": "openai/gpt-5.5" }
  }
}
```

### Multiple Providers

You can mix providers freely. Each agent resolves its model independently.

```jsonc
{
  "agent": {
    "kraken": { "model": "openai/gpt-5.5" },            // OpenAI for implementation
    "scout":  { "model": "anthropic/claude-sonnet-4-6" }, // Anthropic for exploration
    "oracle": { "model": "anthropic/claude-opus-4-7" }    // Anthropic for research
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

You never invoke agents directly. The primary `build` agent dispatches them based on your request or the active slash command.

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

## Architecture

### Two-Layer Enforcement

The primary `build` agent is prevented from executing tools directly through two independent layers:

```
  User prompt
       |
       v
  +--------------------+
  |  build agent       |  Layer 1: frontmatter permissions
  |                    |  read, grep, glob, list, bash,
  |  (orchestrator)    |  webfetch, websearch, edit = "deny"
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

### Custom Tools

| Tool | File | Purpose |
|------|------|---------|
| handoff_save | `src/tools/handoff-save.ts` | Write a YAML handoff to `thoughts/shared/handoffs/` |
| handoff_load | `src/tools/handoff-load.ts` | Load the latest handoff for a session |
| ledger_update | `src/tools/ledger-update.ts` | Update a continuity ledger in `thoughts/ledgers/` |
| parallel_delegate | `src/tools/parallel-delegate.ts` | Spawn multiple subagents concurrently |

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

---

## License

MIT
