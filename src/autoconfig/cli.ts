#!/usr/bin/env node
/**
 * Headless, install-time autoconfig CLI.
 *
 * Runs under plain `node` (no `@opencode-ai/plugin`): imports ONLY from
 * `./core.js`. Wired into package.json as the `continuous-code-autoconfig`
 * bin and invoked by install.sh after the plugin is built and opencode.json is
 * deployed.
 *
 * Usage:
 *   node dist/autoconfig/cli.js inspect [--cwd <dir>] [--json]
 *   node dist/autoconfig/cli.js apply
 *         [--config <opencode.json>]   # explicit target (else core resolves)
 *         [--cwd <dir>]                # threaded to inspect()/applyAssignments
 *         [--prefer <providerId>]      # bias selection toward an authed provider
 *         [--fallback-model <slug>]    # kept when NO provider is authenticated
 *         [--dry-run]                  # compute + print plan, do NOT write
 *         [--json]                     # machine-readable output
 *
 * Exit codes:
 *   0  applied (or dry-run printed), OR no provider authed (fallback kept —
 *      install must NOT fail; a hint is printed).
 *   2  apply error (unknown provider / unparseable config / bad usage).
 *
 * install.sh treats any non-zero exit as "skip, keep fallback, print hint".
 */
import {
  inspect,
  applyAssignments,
  planAssignments,
  type Assignment,
  type InspectResult,
  type PlanResult,
} from "./core.js"

const DEFAULT_FALLBACK_MODEL = "ollama-cloud/deepseek-v4-pro"

interface ParsedArgs {
  command: string
  config?: string
  cwd?: string
  prefer?: string
  fallbackModel: string
  dryRun: boolean
  json: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? ""
  const out: ParsedArgs = {
    command,
    fallbackModel: DEFAULT_FALLBACK_MODEL,
    dryRun: false,
    json: false,
  }

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case "--config":
        out.config = argv[++i]
        break
      case "--cwd":
        out.cwd = argv[++i]
        break
      case "--prefer":
        out.prefer = argv[++i]
        break
      case "--fallback-model":
        out.fallbackModel = argv[++i] ?? DEFAULT_FALLBACK_MODEL
        break
      case "--dry-run":
        out.dryRun = true
        break
      case "--json":
        out.json = true
        break
      default:
        // Ignore unknown flags rather than failing the install.
        break
    }
  }

  return out
}

/** Render the inspect result as a readable text block (mirrors the tool). */
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

/** Render the planned assignments as a readable table. */
function renderPlan(plan: PlanResult): string {
  const lines: string[] = []
  lines.push("Planned assignments:")
  const names = Object.keys(plan.assignments)
  if (names.length === 0) {
    lines.push("  (none)")
  } else {
    for (const name of names) {
      const a = plan.assignments[name]
      const effort = a.effort ? ` @${a.effort}` : ""
      lines.push(`  - ${name}: ${a.model}${effort}`)
    }
  }
  lines.push("")
  lines.push(plan.note)
  return lines.join("\n")
}

function cmdInspect(args: ParsedArgs): number {
  const result = inspect({ cwd: args.cwd })
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  } else {
    process.stdout.write(renderInspect(result) + "\n")
  }
  return 0
}

function cmdApply(args: ParsedArgs): number {
  const result = inspect({ cwd: args.cwd })
  const plan = planAssignments(result, {
    prefer: args.prefer,
    fallbackModel: args.fallbackModel,
  })

  // No authenticated provider: do NOT write, keep the committed fallback, print
  // the hint, and exit 0 so the install never fails on a fresh machine.
  if (plan.usedFallback) {
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          { ok: true, applied: false, usedFallback: true, note: plan.note },
          null,
          2,
        ) + "\n",
      )
    } else {
      process.stdout.write(plan.note + "\n")
    }
    return 0
  }

  // Dry-run: compute + print the plan, write nothing.
  if (args.dryRun) {
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            applied: false,
            dryRun: true,
            assignments: plan.assignments,
            note: plan.note,
          },
          null,
          2,
        ) + "\n",
      )
    } else {
      process.stdout.write(renderPlan(plan) + "\n")
      process.stdout.write("\n(dry-run: no file written)\n")
    }
    return 0
  }

  const assignments: Record<string, Assignment> = plan.assignments
  const applyResult = applyAssignments({
    assignments,
    configPath: args.config,
    cwd: args.cwd,
  })

  if (!applyResult.ok) {
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: false,
            error: applyResult.error,
            invalidAssignments: applyResult.invalidAssignments ?? [],
            validProviders: applyResult.validProviders ?? [],
          },
          null,
          2,
        ) + "\n",
      )
    } else {
      process.stderr.write(
        `Failed to apply: ${applyResult.error}\n` +
          "(No file was written / original preserved.)\n",
      )
    }
    return 2
  }

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          applied: true,
          configPath: applyResult.configPath,
          backupPath: applyResult.backupPath,
          changes: applyResult.changes,
          warnings: applyResult.warnings ?? [],
          note: plan.note,
        },
        null,
        2,
      ) + "\n",
    )
    return 0
  }

  // Human-readable table (mirrors src/tools/autoconfig.ts:174-198).
  const lines: string[] = []
  lines.push(`Wrote config: ${applyResult.configPath}`)
  if (applyResult.backupPath) lines.push(`Backup: ${applyResult.backupPath}`)
  lines.push("")
  lines.push("Changes:")
  if (applyResult.changes.length === 0) {
    lines.push("  (no changes recorded)")
  } else {
    for (const c of applyResult.changes) {
      const oldM = c.oldModel ?? "(none)"
      const oldV = c.oldVariant ? `@${c.oldVariant}` : ""
      const newV = c.newVariant ? `@${c.newVariant}` : ""
      const tag = c.created ? " [created]" : ""
      lines.push(`  - ${c.agent}: ${oldM}${oldV} -> ${c.newModel}${newV}${tag}`)
    }
  }
  if (applyResult.warnings && applyResult.warnings.length > 0) {
    lines.push("")
    lines.push("Warnings:")
    for (const w of applyResult.warnings) lines.push(`  - ${w}`)
  }
  lines.push("")
  lines.push(plan.note)
  lines.push("")
  lines.push("Restart `opencode` for these changes to take effect.")

  process.stdout.write(lines.join("\n") + "\n")
  return 0
}

function printUsage(): void {
  process.stderr.write(
    [
      "continuous-code-autoconfig — headless per-agent model autoconfig",
      "",
      "Usage:",
      "  continuous-code-autoconfig inspect [--cwd <dir>] [--json]",
      "  continuous-code-autoconfig apply [--config <opencode.json>] [--cwd <dir>]",
      "      [--prefer <providerId>] [--fallback-model <slug>] [--dry-run] [--json]",
      "",
    ].join("\n"),
  )
}

function main(): number {
  const args = parseArgs(process.argv.slice(2))

  switch (args.command) {
    case "inspect":
      return cmdInspect(args)
    case "apply":
      return cmdApply(args)
    default:
      printUsage()
      return 2
  }
}

process.exit(main())
