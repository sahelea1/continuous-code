/**
 * Pure rendering: TuiState -> ANSI string.
 *
 * No IO here either — `cli.ts` is the only place that calls
 * `process.stdout.write`. Keeping this pure makes it unit-testable: tests
 * strip ANSI codes and assert on substrings/labels/glyphs rather than exact
 * byte sequences (which would be brittle).
 *
 * Color palette (reddish theme, ANSI 256 approximations):
 *  - done glyph    ✔  green   (approx 114)
 *  - active glyph  ●  red     (approx 203)
 *  - pending glyph ◯  muted grey-red (approx 95)
 *  - failed glyph  ✘  red     (approx 203)
 *  - spinner       gold (approx 215), frames cycle in state.ts
 */

import {
  SPINNER_FRAMES,
  type TuiState,
  type AgentState,
  type PhaseState,
} from "./state.js"

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ESC = "\x1b"
const CSI = `${ESC}[`

export const ansi = {
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  cursorHome: `${CSI}H`,
  clearScreen: `${CSI}2J`,
  clearToEnd: `${CSI}0J`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  fg256: (n: number) => `${CSI}38;5;${n}m`,
}

const COLOR = {
  done: 114, // green
  active: 203, // red
  pending: 95, // muted grey-red
  failed: 203, // red
  spinner: 215, // gold
  border: 231, // white
  grey: 246,
  darkGrey: 239,
}

function colorize(text: string, code: number): string {
  return `${ansi.fg256(code)}${text}${ansi.reset}`
}

/** Strip all ANSI escape sequences — used by tests, exported for reuse. */
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

export const GLYPH = {
  done: "✔",
  active: "●",
  pending: "◯",
  failed: "✘",
} as const

function phaseGlyph(status: PhaseState["status"]): string {
  if (status === "done") return colorize(GLYPH.done, COLOR.done)
  if (status === "active") return colorize(GLYPH.active, COLOR.active)
  return colorize(GLYPH.pending, COLOR.pending)
}

function agentGlyph(status: AgentState["status"]): string {
  if (status === "done") return colorize(GLYPH.done, COLOR.done)
  if (status === "failed") return colorize(GLYPH.failed, COLOR.failed)
  if (status === "active") return colorize(GLYPH.active, COLOR.active)
  return colorize(GLYPH.pending, COLOR.pending)
}

function spinnerGlyph(frame: number): string {
  const f = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]
  return colorize(f ?? SPINNER_FRAMES[0]!, COLOR.spinner)
}

function fmtElapsed(ms: number): string {
  if (ms < 0) ms = 0
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function anyActive(state: TuiState): boolean {
  return state.phases.some(
    (p) =>
      p.status === "active" || p.agents.some((a) => a.status === "active"),
  )
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function renderHeader(state: TuiState, nowMs: number): string {
  const totalPhases = state.phases.length
  const donePhases = state.phases.filter((p) => p.status === "done").length
  const totalAgents = state.phases.reduce((n, p) => n + p.agents.length, 0)
  const doneAgents = state.phases.reduce(
    (n, p) =>
      n + p.agents.filter((a) => a.status === "done" || a.status === "failed").length,
    0,
  )

  const title = state.summary?.title ?? state.title
  const progress = `${donePhases}/${totalPhases} phases · ${doneAgents}/${totalAgents} agents`
  const spinner = anyActive(state) ? ` ${spinnerGlyph(state.spinnerFrame)}` : ""

  const lines: string[] = []
  lines.push(`${ansi.bold}${title}${ansi.reset}${spinner}`)
  lines.push(colorize(progress, COLOR.grey))
  void nowMs
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Phases view (left pane / level 1)
// ---------------------------------------------------------------------------

function renderPhasesView(state: TuiState): string {
  const lines: string[] = []
  lines.push(colorize("Phases", COLOR.border))
  if (state.phases.length === 0) {
    lines.push(colorize("  (waiting for phase.start…)", COLOR.darkGrey))
    return lines.join("\n")
  }
  state.phases.forEach((phase, idx) => {
    const cursor = idx === state.selectedPhaseIdx ? "❯ " : "  "
    const doneCount = phase.agents.filter(
      (a) => a.status === "done" || a.status === "failed",
    ).length
    const glyph = phaseGlyph(phase.status)
    const counts = colorize(
      `${doneCount}/${phase.agentCount} agents · ${phase.mode}`,
      COLOR.grey,
    )
    lines.push(`${cursor}${glyph} ${phase.title}  ${counts}`)
  })
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Agents view (level 2 — agents of the selected phase)
// ---------------------------------------------------------------------------

function renderAgentsView(state: TuiState, nowMs: number): string {
  const phase = state.phases[state.selectedPhaseIdx]
  const lines: string[] = []
  if (!phase) {
    lines.push(colorize("(no phase selected)", COLOR.darkGrey))
    return lines.join("\n")
  }
  lines.push(colorize(`${phase.title} · ${phase.mode}`, COLOR.border))
  if (phase.agents.length === 0) {
    lines.push(colorize("  (waiting for agent.start…)", COLOR.darkGrey))
    return lines.join("\n")
  }
  phase.agents.forEach((agent, idx) => {
    const cursor = idx === state.selectedAgentIdx ? "❯ " : "  "
    const glyph = agentGlyph(agent.status)
    const elapsed =
      agent.status === "done" || agent.status === "failed"
        ? fmtElapsed(agent.durationMs ?? 0)
        : agent.startedAtMs
          ? fmtElapsed(nowMs - agent.startedAtMs)
          : ""
    const meta = colorize(
      [agent.model, elapsed].filter(Boolean).join(" · "),
      COLOR.grey,
    )
    lines.push(`${cursor}${glyph} ${agent.label}  ${meta}`)
  })
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Detail view (level 3 — single agent: Activity + Outcome)
// ---------------------------------------------------------------------------

function renderDetailView(state: TuiState): string {
  const phase = state.phases[state.selectedPhaseIdx]
  const agent = phase?.agents[state.selectedAgentIdx]
  const lines: string[] = []
  if (!phase || !agent) {
    lines.push(colorize("(no agent selected)", COLOR.darkGrey))
    return lines.join("\n")
  }

  const glyph = agentGlyph(agent.status)
  const statusLabel =
    agent.status === "done"
      ? "Completed"
      : agent.status === "failed"
        ? "Failed"
        : agent.status === "active"
          ? "Running"
          : "Pending"
  lines.push(
    `${glyph} ${agent.label}  ${colorize(`${statusLabel} · ${agent.model}`, COLOR.grey)}`,
  )
  lines.push("")
  lines.push(colorize("Activity", COLOR.border))
  if (agent.activity.length === 0) {
    lines.push(colorize("  (no activity yet)", COLOR.darkGrey))
  } else {
    for (const line of agent.activity) {
      for (const subLine of line.split("\n")) {
        lines.push(`  ${subLine}`)
      }
    }
  }
  lines.push("")
  lines.push(colorize("Outcome", COLOR.border))
  if (agent.status === "done" || agent.status === "failed") {
    const okLabel = agent.ok ? colorize("ok", COLOR.done) : colorize("fail", COLOR.failed)
    lines.push(
      `  ${okLabel} · tokensEst ${agent.tokensEst ?? "?"} · durationMs ${agent.durationMs ?? "?"}`,
    )
  } else {
    lines.push(colorize("  Still running…", COLOR.darkGrey))
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Footer (keybinding hints)
// ---------------------------------------------------------------------------

function renderFooter(state: TuiState): string {
  if (state.drillLevel === "phases") {
    return colorize("↑↓ select · enter/→ open · q quit", COLOR.darkGrey)
  }
  if (state.drillLevel === "agents") {
    return colorize("↑↓ select · enter/→ detail · esc/← back · q quit", COLOR.darkGrey)
  }
  return colorize("esc/← back · q quit", COLOR.darkGrey)
}

// ---------------------------------------------------------------------------
// Top-level render
// ---------------------------------------------------------------------------

/**
 * Render the full frame for the current state as a single ANSI string.
 * `nowMs` defaults to Date.now() but is injectable for deterministic tests.
 */
export function render(state: TuiState, nowMs: number = Date.now()): string {
  const lines: string[] = []
  lines.push(renderHeader(state, nowMs))
  lines.push("")

  if (state.drillLevel === "phases") {
    lines.push(renderPhasesView(state))
  } else if (state.drillLevel === "agents") {
    lines.push(renderAgentsView(state, nowMs))
  } else {
    lines.push(renderDetailView(state))
  }

  lines.push("")
  lines.push(renderFooter(state))

  if (state.summary) {
    lines.push("")
    lines.push(
      colorize(
        `workflow.done: ${state.summary.agentsCompleted} agents completed, ` +
          `${state.summary.agentsFailed} failed, ${fmtElapsed(state.summary.durationMs)}`,
        COLOR.grey,
      ),
    )
  }

  return lines.join("\n")
}

/** Render a frame plus a cursor-home + clear-to-end prefix, ready to write
 * directly to stdout for an incremental (non-flickery) redraw. */
export function renderFrame(state: TuiState, nowMs: number = Date.now()): string {
  return `${ansi.cursorHome}${ansi.clearToEnd}${render(state, nowMs)}`
}
