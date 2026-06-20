import { tool } from "@opencode-ai/plugin"
import {
  inspect,
  applyAssignments,
  type Assignment,
  type Effort,
  type InspectResult,
} from "../autoconfig/core.js"

const EFFORTS: Effort[] = ["low", "medium", "high", "max", "xhigh"]

/** Render the inspect result as a readable text block for the LLM. */
function renderInspect(result: InspectResult): string {
  const lines: string[] = []
  lines.push("Available providers (authenticated first):")
  for (const p of result.providers) {
    const auth = p.authenticated ? "AUTHENTICATED" : "not authenticated"
    const name = p.name ? ` (${p.name})` : ""
    lines.push(`- ${p.id}${name} [${auth}] — source: ${p.source}`)
    if (p.baseURL) lines.push(`    baseURL: ${p.baseURL}`)
    if (p.models.length === 0) {
      lines.push("    models: (none enumerated)")
    } else {
      for (const m of p.models) {
        const reasoning = m.reasoning ? "reasoning" : "no-reasoning"
        const variants =
          m.variants.length > 0 ? ` variants=[${m.variants.join("|")}]` : ""
        lines.push(`    - ${p.id}/${m.id} [${reasoning}]${variants}`)
      }
    }
  }

  lines.push("")
  lines.push(`Resolved config path: ${result.currentConfigPath ?? "(none)"}`)
  lines.push("Current agent -> model mapping:")
  const names = Object.keys(result.currentAgents)
  if (names.length === 0) {
    lines.push("  (no agents configured)")
  } else {
    for (const name of names) {
      const a = result.currentAgents[name]
      const variant = a.variant ? ` (variant: ${a.variant})` : ""
      lines.push(`  - ${name}: ${a.model ?? "(unset)"}${variant}`)
    }
  }

  if (result.notes.length > 0) {
    lines.push("")
    lines.push("Notes:")
    for (const n of result.notes) lines.push(`  - ${n}`)
  }

  return lines.join("\n")
}

export const autoconfigInspect = tool({
  description:
    "Detect the host's available AI providers and models (merged from auth.json, declared opencode config providers, the `opencode models` CLI, and a built-in fallback map of well-known providers). Returns structured JSON with providers/models, which ones are authenticated, whether each model supports reasoning, its variants, the resolved opencode.json path, and the current agent->model mapping. Never exposes secret values. Call this BEFORE autoconfig_apply.",
  args: {},
  async execute(_args, context) {
    const result = inspect({ cwd: context.directory })

    context.metadata({
      title: `Autoconfig inspect: ${result.providers.length} providers`,
      metadata: {
        providers: result.providers.map((p) => p.id),
        authenticated: result.providers
          .filter((p) => p.authenticated)
          .map((p) => p.id),
        currentConfigPath: result.currentConfigPath,
      },
    })

    return {
      title: `Autoconfig inspect: ${result.providers.length} providers`,
      output: `${renderInspect(result)}\n\n--- structured ---\n${JSON.stringify(
        result,
        null,
        2,
      )}`,
      metadata: {
        providers: result.providers,
        currentConfigPath: result.currentConfigPath,
        currentAgents: result.currentAgents,
      },
    }
  },
})

export const autoconfigApply = tool({
  description:
    "Write chosen per-agent models + reasoning effort into the host's opencode.json (effort maps to the AgentConfig `variant` field). Preserves all other config content, creates missing agent entries, and writes a `.bak` backup before overwriting. Target path resolution: explicit configPath > $cwd/opencode.json > ~/.config/opencode/opencode.json > ~/.config/opencode/opencode.jsonc. If the target cannot be parsed it is left untouched and an error is returned. Call autoconfig_inspect first to pick models that are actually available.",
  args: {
    assignments: tool.schema
      .record(
        tool.schema.string(),
        tool.schema.object({
          model: tool.schema
            .string()
            .describe("Full model slug, e.g. 'anthropic/claude-opus-4-8'"),
          effort: tool.schema
            .enum(["low", "medium", "high", "max", "xhigh"])
            .optional()
            .describe(
              "Reasoning effort; mapped to the agent `variant` field (xhigh -> max)",
            ),
          variant: tool.schema
            .string()
            .optional()
            .describe("Explicit variant override (wins over effort)"),
        }),
      )
      .describe(
        "Map of agentName -> { model, effort?, variant? }. e.g. {\"build\": {\"model\": \"anthropic/claude-opus-4-8\", \"effort\": \"xhigh\"}}",
      ),
    configPath: tool.schema
      .string()
      .optional()
      .describe("Explicit path to the opencode.json to write (optional)"),
  },
  async execute(args, context) {
    // Normalize assignments into the core Assignment shape.
    const assignments: Record<string, Assignment> = {}
    for (const [name, a] of Object.entries(args.assignments ?? {})) {
      if (!a || typeof a.model !== "string") continue
      const effort =
        a.effort && EFFORTS.includes(a.effort as Effort)
          ? (a.effort as Effort)
          : undefined
      assignments[name] = {
        model: a.model,
        effort,
        variant: a.variant,
      }
    }

    if (Object.keys(assignments).length === 0) {
      return {
        title: "Autoconfig apply: nothing to do",
        output:
          "No valid assignments provided. Each assignment needs at least a `model` slug.",
      }
    }

    const result = applyAssignments({
      assignments,
      configPath: args.configPath,
      // FIX 1: thread the project dir so apply resolves the SAME config file
      // inspect reported (mirrors inspect({ cwd: context.directory }) above).
      cwd: context.directory,
    })

    if (!result.ok) {
      context.metadata({
        title: "Autoconfig apply: FAILED",
        metadata: {
          error: result.error,
          configPath: result.configPath,
          invalidAssignments: result.invalidAssignments,
        },
      })
      return {
        title: "Autoconfig apply: FAILED",
        output: `Failed to apply: ${result.error}\n(No file was written / original preserved.)`,
        metadata: {
          ok: false,
          error: result.error,
          invalidAssignments: result.invalidAssignments ?? [],
          validProviders: result.validProviders ?? [],
        },
      }
    }

    const lines: string[] = []
    lines.push(`Wrote config: ${result.configPath}`)
    if (result.backupPath) lines.push(`Backup: ${result.backupPath}`)
    lines.push("")
    lines.push("Changes:")
    if (result.changes.length === 0) {
      lines.push("  (no changes recorded)")
    } else {
      for (const c of result.changes) {
        const oldM = c.oldModel ?? "(none)"
        const oldV = c.oldVariant ? `@${c.oldVariant}` : ""
        const newV = c.newVariant ? `@${c.newVariant}` : ""
        const tag = c.created ? " [created]" : ""
        lines.push(
          `  - ${c.agent}: ${oldM}${oldV} -> ${c.newModel}${newV}${tag}`,
        )
      }
    }
    if (result.warnings && result.warnings.length > 0) {
      lines.push("")
      lines.push("Warnings:")
      for (const w of result.warnings) lines.push(`  - ${w}`)
    }
    lines.push("")
    lines.push("Restart `opencode` for these changes to take effect.")

    context.metadata({
      title: `Autoconfig apply: ${result.changes.length} change(s)`,
      metadata: {
        configPath: result.configPath,
        backupPath: result.backupPath,
        changeCount: result.changes.length,
        warningCount: result.warnings?.length ?? 0,
      },
    })

    return {
      title: `Autoconfig apply: ${result.changes.length} change(s)`,
      output: lines.join("\n"),
      metadata: {
        ok: true,
        configPath: result.configPath,
        backupPath: result.backupPath,
        changes: result.changes,
        warnings: result.warnings ?? [],
      },
    }
  },
})
