import type { Hooks } from "@opencode-ai/plugin"
import { readFileSync } from "fs"
import { join } from "path"

interface SkillRule {
  pattern: string[]
  critical: string[]
  recommended: string[]
  command: string
}

interface SkillRules {
  rules: SkillRule[]
}

let cachedRules: SkillRules | null = null

function loadRules(directory: string): SkillRules {
  if (cachedRules) return cachedRules
  try {
    const content = readFileSync(join(directory, "skill-rules.json"), "utf-8")
    cachedRules = JSON.parse(content) as SkillRules
    return cachedRules
  } catch {
    return { rules: [] }
  }
}

/**
 * Scans incoming user messages for keyword patterns defined in skill-rules.json,
 * then appends a skill activation block naming the critical/recommended subagents
 * and suggested slash commands.
 */
export function createSkillActivation(directory: string): Hooks["chat.message"] {
  return async (_input, output) => {
    const message = output.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text || "")
      .join(" ")
      .toLowerCase()

    const skillRules = loadRules(directory)

    const matches: { rule: SkillRule; score: number }[] = []

    for (const rule of skillRules.rules) {
      const score = rule.pattern.filter((p) => message.includes(p)).length
      if (score > 0) {
        matches.push({ rule, score })
      }
    }

    if (matches.length === 0) return

    // Sort by match score descending
    matches.sort((a, b) => b.score - a.score)

    const critical = [...new Set(matches.flatMap((m) => m.rule.critical))]
    const recommended = [...new Set(matches.flatMap((m) => m.rule.recommended))]
    const commands = [...new Set(matches.map((m) => m.rule.command))]

    const activationBlock: string[] = [
      "---",
      "SKILL ACTIVATION",
      "---",
    ]

    if (critical.length > 0) {
      activationBlock.push("", "CRITICAL AGENTS:")
      critical.forEach((a) => activationBlock.push(`  -> ${a}`))
    }

    if (recommended.length > 0) {
      activationBlock.push("", "RECOMMENDED AGENTS:")
      recommended.forEach((a) => activationBlock.push(`  -> ${a}`))
    }

    if (commands.length > 0) {
      activationBlock.push("", "SUGGESTED COMMANDS:")
      commands.forEach((c) => activationBlock.push(`  -> ${c}`))
    }

    activationBlock.push("", "ACTION: Use task tool to delegate to these agents")
    activationBlock.push("---")

    // Push a synthetic text part with the activation block.
    // The Part union requires id/sessionID/messageID for TextPart, but plugins
    // that append to output.parts rely on OpenCode tolerating partial shapes.
    output.parts.push({
      type: "text",
      text: "\n\n" + activationBlock.join("\n"),
    } as any)
  }
}
