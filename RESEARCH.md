# RESEARCH.md

## 1. OpenCode Plugin System (v1.14.48)

### Plugin Entry Point
```typescript
import type { Plugin, PluginModule } from "@opencode-ai/plugin"

const server: Plugin = async (input, options) => {
  const { client, project, directory, worktree, $, serverUrl } = input
  return {
    // return Hooks subset
  }
}
export default { id: "opencode-continuous", server }
```

### Available Hooks (input → output mutation pattern)
- `event?: (input: { event: Event }) => Promise<void>` — all bus events
- `config?: (input: Config) => Promise<void>` — config loaded
- `tool?: { [key: string]: ToolDefinition }` — register custom tools
- `auth?: AuthHook` — custom auth provider
- `provider?: ProviderHook` — custom model provider
- `"chat.message"?: (input: { sessionID, agent?, model?, messageID?, variant? }, output: { message, parts }) => Promise<void>`
- `"chat.params"?: (input: { sessionID, agent, model, provider, message }, output: { temperature, topP, topK, maxOutputTokens, options }) => Promise<void>`
- `"chat.headers"?: (input, output: { headers }) => Promise<void>`
- `"permission.ask"?: (input: Permission, output: { status: "ask"|"deny"|"allow" }) => Promise<void>`
- `"command.execute.before"?: (input: { command, sessionID, arguments }, output: { parts }) => Promise<void>`
- `"tool.execute.before"?: (input: { tool, sessionID, callID }, output: { args }) => Promise<void>`
- `"tool.execute.after"?: (input: { tool, sessionID, callID, args }, output: { title, output, metadata }) => Promise<void>`
- `"tool.definition"?: (input: { toolID }, output: { description, parameters }) => Promise<void>`
- `"shell.env"?: (input: { cwd, sessionID?, callID? }, output: { env }) => Promise<void>`
- `"experimental.session.compacting"?: (input: { sessionID }, output: { context: string[], prompt? }) => Promise<void>`
- `"experimental.chat.system.transform"?: (input: { sessionID?, model }, output: { system: string[] }) => Promise<void>`
- `"experimental.chat.messages.transform"?: (input: {}, output: { messages }) => Promise<void>`
- `"experimental.text.complete"?: (input: { sessionID, messageID, partID }, output: { text }) => Promise<void>`
- `"experimental.compaction.autocontinue"?: (input, output: { enabled: boolean }) => Promise<void>`

### Custom Tool Registration
```typescript
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "description",
  args: {
    name: tool.schema.string().describe("desc"),
    count: tool.schema.number().default(10),
  },
  async execute(args, context) {
    // context: { sessionID, messageID, agent, directory, worktree, abort, metadata, ask }
    return "result string"
    // OR: return { title, output, metadata, attachments }
  },
})
```

Tools can be registered two ways:
- **File drop**: Place .ts files in `.opencode/tool/` — auto-discovered
- **Plugin hook**: Return `{ tool: { name: tool({...}) } }` from plugin

### Plugin Installation
In `opencode.json`:
```json
{
  "plugin": [
    "npm-package-name",
    ["npm-package-with-options", { "key": "value" }],
    "./local-plugin.ts"
  ]
}
```
CLI: `opencode plugin <module>` (or `opencode plug`)

## 2. OpenCode Agent System

### Agent Frontmatter (markdown files in `.opencode/agent/`)
```yaml
---
model: "provider/model-id"
variant: "high"              # optional
temperature: 0.1             # optional
top_p: 0.9                   # optional
description: "When to use"
mode: "subagent"             # "primary" | "subagent" | "all"
hidden: false                # optional
steps: 10                    # max iterations, optional
color: "#FF5733"             # optional
disable: false               # optional
permission:
  read: "allow"
  edit: "deny"
  bash: { "*": "ask", "git status *": "allow" }
options:                     # optional pass-through
  reasoningEffort: "high"
---

System prompt goes here in the markdown body.
```

### Agent Discovery Paths
- Project: `.opencode/agent/`, `.opencode/agents/`, `agent/`, `agents/`
- Global: `~/.config/opencode/agents/`
- Filename (minus .md) = agent name

### Built-in Agents
- `build` (primary) — default, all tools
- `plan` (primary) — edit denied
- `general` (subagent) — full tools
- `explore` (subagent) — read-only
- `scout` (subagent, experimental) — external docs

### Subagent Invocation (task tool)
The model calls `task` with: `{ description, prompt, subagent_type, task_id?, command? }`

### Per-Agent Config Override in opencode.json
```json
{
  "agent": {
    "my-agent": {
      "model": "ollama-cloud/deepseek-v4-pro:cloud",
      "temperature": 0.1,
      "permission": { "read": "allow", "edit": "deny" }
    }
  }
}
```

## 3. OpenCode Command System

### Command Markdown (`.opencode/command/`)
```yaml
---
description: "Short description"
agent: "build"              # optional
model: "provider/model-id"  # optional
subtask: true               # optional, force subagent
---

Command template text. Use $ARGUMENTS for args.
Use $1, $2 for positional args.
```

## 4. OpenCode CLI

### Key Commands
- `opencode run [message..] --format json --agent <name> --model <provider/model> --dir <path>`
- `opencode run --command <name>` — run a slash command
- `opencode serve --port <N> --hostname <host>` — headless API server
- `opencode auth login [url]` / `opencode auth list` / `opencode auth logout`
- `opencode plugin <module>` — install plugin
- `opencode models [provider]` — list models

### Headless Flags
- `--format json` — streams newline-delimited JSON events
- `--dangerously-skip-permissions` — auto-approve
- `--agent <name>` — specify agent
- `--model <provider/model>` — specify model

## 5. OpenCode Config (`opencode.json`)

### Provider Config for Ollama Cloud
```json
{
  "provider": {
    "ollama-cloud": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama Cloud",
      "options": {
        "baseURL": "https://api.ollama-cloud.example/v1"
      },
      "models": {
        "deepseek-v4-pro:cloud": { "name": "DeepSeek V4 Pro" },
        "deepseek-v4-flash:cloud": { "name": "DeepSeek V4 Flash" }
      }
    }
  }
}
```

Variable substitution: `{env:VAR_NAME}`, `{file:./path}`

### Permission Config
```json
{
  "permission": {
    "read": "allow",
    "edit": "ask",
    "bash": { "*": "ask", "git *": "allow", "rm *": "deny" }
  }
}
```
Permission keys: read, edit, glob, grep, list, bash, task, external_directory, todowrite, webfetch, websearch, lsp, skill, question, plan_enter, plan_exit, repo_clone, repo_overview

### Auth Storage
- Path: `~/.local/share/opencode/auth.json`
- Format: `{ "provider-id": { type: "api", key: "..." } }` or OAuth variant
- Both `ollama-cloud` and `openai` are configured on host

## 6. CC-v3 Architecture

### Confirmed Handoff Format (pure YAML, from create_handoff skill)
```yaml
goal: "What the session aimed to accomplish"
now: "Current state / what was being worked on"
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
Location: `thoughts/shared/handoffs/<session-slug>/<ISO-timestamp>.yaml`
Fields `goal` and `now` are REQUIRED.

### CC-v3 Continuity Ledger
Location: `thoughts/ledgers/CONTINUITY_<topic>.md`
Format: Markdown with checklist sections (Goal, Completed, In Progress, Blockers)

### CC-v3 Agent Roster (12 to port — from spec §5.3)
| Agent | CC-v3 Model | Role |
|-------|-------------|------|
| scout | sonnet | Codebase exploration, read-only |
| oracle | opus | External research, web/docs/APIs |
| sleuth | opus | Bug investigation, root cause |
| kraken | opus | Implementation, TDD |
| spark | sonnet | Quick fixes, lightweight |
| arbiter | opus | Test execution, verification |
| judge | sonnet | Code review, refactoring review |
| plan-agent | opus | Implementation planning |
| phoenix | opus | Refactoring + migration planning |
| architect | opus | Feature + integration planning |
| scribe | sonnet | Documentation, handoffs, ledgers |
| memory-extractor | sonnet | Extract learnings from sessions |

### CC-v3 Hook Events (mapped to OpenCode equivalents)
| CC-v3 Event | OpenCode Hook |
|-------------|---------------|
| PreToolUse | tool.execute.before + permission.ask |
| PostToolUse | tool.execute.after |
| UserPromptSubmit | chat.message |
| SessionStart | event (session.created) |
| PreCompact | experimental.session.compacting |
| Stop | event (session.idle or custom) |
| SessionEnd | event (session.deleted) |

## 7. Confirmed Model IDs

### Default assignments (all agents)
- Pro models: `ollama-cloud/deepseek-v4-pro:cloud`
- Flash models: `ollama-cloud/deepseek-v4-flash:cloud`
- Alternative: `openai/gpt-5.5`

### Agent-to-model mapping
| Agent | Default Model |
|-------|---------------|
| build (primary) | ollama-cloud/deepseek-v4-pro:cloud |
| scout | ollama-cloud/deepseek-v4-flash:cloud |
| oracle | ollama-cloud/deepseek-v4-pro:cloud |
| sleuth | ollama-cloud/deepseek-v4-pro:cloud |
| kraken | ollama-cloud/deepseek-v4-pro:cloud |
| spark | ollama-cloud/deepseek-v4-flash:cloud |
| arbiter | ollama-cloud/deepseek-v4-flash:cloud |
| judge | ollama-cloud/deepseek-v4-pro:cloud |
| plan-agent | ollama-cloud/deepseek-v4-pro:cloud |
| phoenix | ollama-cloud/deepseek-v4-pro:cloud |
| architect | ollama-cloud/deepseek-v4-pro:cloud |
| scribe | ollama-cloud/deepseek-v4-flash:cloud |
| memory-extractor | ollama-cloud/deepseek-v4-flash:cloud |

## 8. Key Architectural Decisions

1. **Agent-only enforcement**: Two layers:
   - Layer 1: Primary agent (`build`) frontmatter sets `permission: { read: deny, grep: deny, glob: deny, bash: deny, webfetch: deny }`
   - Layer 2: Plugin `permission.ask` hook rewrites deny message to name the correct subagent

2. **Handoff format**: Use CC-v3 actual YAML format (not spec §4.2)

3. **Agent count**: Port 12 agents from spec §5.3 (not all 32 from CC-v3)

4. **Plugin structure**: Single npm package with server plugin entry point

5. **Parallel delegate**: Custom tool using `Promise.all` on `ctx.client.session.prompt()` calls

## 9. File Layout (Target)

```
opencode-continuous/
├── package.json
├── tsconfig.json
├── install.sh
├── uninstall.sh
├── README.md
├── RESEARCH.md
├── opencode.json              # template config
├── src/
│   ├── index.ts               # plugin entry point
│   ├── hooks/
│   │   ├── enforce-agent-only.ts
│   │   ├── skill-activation.ts
│   │   ├── compaction-handoff.ts
│   │   ├── session-start.ts
│   │   └── memory-awareness.ts
│   └── tools/
│       ├── handoff-save.ts
│       ├── handoff-load.ts
│       ├── ledger-update.ts
│       └── parallel-delegate.ts
├── agents/
│   ├── scout.md
│   ├── oracle.md
│   ├── sleuth.md
│   ├── kraken.md
│   ├── spark.md
│   ├── arbiter.md
│   ├── judge.md
│   ├── plan-agent.md
│   ├── phoenix.md
│   ├── architect.md
│   ├── scribe.md
│   └── memory-extractor.md
├── commands/
│   ├── fix.md
│   ├── build.md
│   ├── tdd.md
│   ├── explore.md
│   ├── review.md
│   ├── refactor.md
│   ├── handoff.md
│   └── resume.md
├── tests/
│   ├── fixtures/
│   │   └── cc-v3-handoff.yaml
│   ├── docker/
│   │   ├── Dockerfile
│   │   ├── docker-compose.yml
│   │   ├── run.sh
│   │   └── stub-provider.ts
│   └── scenarios/
│       ├── run-all.sh
│       ├── 01-agent-only.sh
│       ├── 02-handoff-roundtrip.sh
│       ├── 03-resume.sh
│       ├── 04-parallel-delegation.sh
│       ├── 05-model-swap.sh
│       └── 06-cc-v3-compat.sh
└── skill-rules.json
```

## 10. Reference Paths

- OpenCode source: /tmp/opencode
- CC-v3 source: /tmp/cc-v3
- OpenCode plugin SDK types: /tmp/opencode/packages/plugin/src/index.ts
- OpenCode tool types: /tmp/opencode/packages/plugin/src/tool.ts
- OpenCode agent code: /tmp/opencode/packages/opencode/src/agent/agent.ts
- OpenCode config code: /tmp/opencode/packages/opencode/src/config/config.ts
- OpenCode task tool: /tmp/opencode/packages/opencode/src/tool/task.ts
- CC-v3 settings: /tmp/cc-v3/.claude/settings.json
- CC-v3 agents: /tmp/cc-v3/.claude/agents/
- CC-v3 skills: /tmp/cc-v3/.claude/skills/
- Host auth: ~/.local/share/opencode/auth.json
- Host config: ~/.config/opencode/
- Plugin SDK installed: ~/.config/opencode/node_modules/@opencode-ai/plugin/

## 11. Multi-Model Consensus (OpenRouter Fusion) Research

The Multi-Model Consensus feature gets answers from several models at once and produces one combined output, with a dominant "main" model breaking ties. Two paths were researched.

### Native Fusion vs client-side fan-out

- **Native OpenRouter Fusion** runs the whole panel server-side in a single request. You attach a tool `{ "type": "openrouter:fusion", "parameters": { "analysis_models": [...1-8 slugs], "model": "<judge slug>", "max_completion_tokens": N, "reasoning": { "effort": "..." } } }` with `tool_choice: "required"`. The response carries `analysis.consensus` (array), `analysis.contradictions`, and `responses[]`. It is simplest and cheapest in round-trips, **but only works for OpenRouter-hosted models** — you cannot include an ollama-cloud model in `analysis_models`.
- **Client-side fan-out ("main-judge")** issues one OpenAI-compatible `POST /chat/completions` per panel member in parallel (via `Promise.allSettled`), then makes one more call to the main model with a judge system prompt that synthesizes a single answer plus trailing `---AGREEMENT:` / `---OVERRIDE:` marker lines. This is the only way to mix providers.

### Reasoning object

Per-request reasoning is the body field `reasoning: { effort: "none"|"minimal"|"low"|"medium"|"high"|"xhigh", max_tokens?, exclude? }`. Pair it with `provider: { require_parameters: true }` so the parameters aren't silently dropped. Response content is at `choices[0].message.content`; reasoning trace at `choices[0].message.reasoning`. ollama-cloud (base URL `https://ollama.com/v1`) is OpenAI-compatible but does **not** support the `reasoning` object, so it must be omitted for non-OpenRouter providers.

### Cross-provider mixing requires client-side orchestration

Because native Fusion is OpenRouter-only, querying OpenRouter and ollama-cloud simultaneously can only be done client-side: resolve each member's provider config + API key (from `apiKeyEnv`), fan out in parallel, and synthesize locally. `supportsReasoning` is decided per call by `provider === "openrouter"`.

### Request/response essentials

- OpenRouter: base URL `https://openrouter.ai/api/v1`, `POST /chat/completions`, auth `Authorization: Bearer <key>`, optional `HTTP-Referer` / `X-Title` headers.
- Token cap via `max_tokens` (Fusion uses `max_completion_tokens` inside the tool parameters).
- `GET /api/v1/models` lists valid slugs and pricing.
- Use an `AbortController` with a configurable timeout for every request.

### Design decision

Default to **client-side `main-judge`** because it supports cross-provider panels (the headline requirement) and gives explicit control over the synthesis prompt, agreement score, and override signal. Offer **native `fusion`** as an opt-in fast path when every panel member is on OpenRouter, with a defensive parser that falls back to `choices[0].message.content` if the Fusion response shape is unexpected.
