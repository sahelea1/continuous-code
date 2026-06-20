#!/usr/bin/env node
/**
 * Standalone terminal-UI consumer for the workflow dashboard backend.
 *
 * A SEPARATE Node/Bun CLI process — does not touch OpenCode's own TUI
 * renderer. Connects to the same dashboard server started by
 * src/workflow/dashboard.ts (GET /state + GET /events SSE) and paints a
 * raw-ANSI terminal UI of its own.
 *
 * Usage:
 *   workflow-tui [--port <n>] [--url <url>]
 *
 * Defaults to http://localhost:7878 (DEFAULT_WORKFLOW_CONFIG.dashboardPort)
 * unless --port or --url is given.
 */

import { connect, DashboardConnectionError } from "./sse-client.js"
import { reduce, tick, navigate, createInitialState, type TuiState } from "./state.js"
import { renderFrame, ansi } from "./render.js"
import { attachKeyboard, type KeyEvent } from "./keyboard.js"
import { DEFAULT_WORKFLOW_CONFIG } from "../config.js"

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { baseUrl: string } {
  let port: number | null = null
  let url: string | null = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--port" && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1]!, 10)
      if (Number.isFinite(n) && n > 0) port = n
      i++
      continue
    }
    if (arg === "--url" && argv[i + 1]) {
      url = argv[i + 1]!
      i++
      continue
    }
  }

  if (url) return { baseUrl: url.replace(/\/+$/, "") }
  const resolvedPort = port ?? DEFAULT_WORKFLOW_CONFIG.dashboardPort
  return { baseUrl: `http://localhost:${resolvedPort}` }
}

// ---------------------------------------------------------------------------
// Terminal lifecycle (raw mode / cursor visibility) — restored on exit.
// ---------------------------------------------------------------------------

let rawModeWasEnabled = false
let cleanedUp = false

function enterTerminalMode(): void {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true)
    rawModeWasEnabled = true
  }
  process.stdin.resume()
  process.stdout.write(ansi.hideCursor)
}

function restoreTerminalMode(): void {
  if (cleanedUp) return
  cleanedUp = true
  try {
    if (rawModeWasEnabled && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false)
    }
  } catch {
    // ignore — stdin may already be closed
  }
  try {
    process.stdout.write(ansi.showCursor)
    process.stdout.write(ansi.clearScreen)
    process.stdout.write(ansi.cursorHome)
  } catch {
    // ignore — stdout may already be closed
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { baseUrl } = parseArgs(argv)

  let state: TuiState = createInitialState()
  const SPINNER_INTERVAL_MS = 140

  function repaint(): void {
    process.stdout.write(renderFrame(state))
  }

  // Register cleanup handlers FIRST so any early failure still restores the
  // terminal (raw mode / hidden cursor are never left broken).
  process.on("exit", restoreTerminalMode)
  process.on("SIGINT", () => {
    restoreTerminalMode()
    process.exit(0)
  })
  process.on("SIGTERM", () => {
    restoreTerminalMode()
    process.exit(0)
  })

  const abortController = new AbortController()

  function quit(): void {
    abortController.abort()
    restoreTerminalMode()
    process.exit(0)
  }

  enterTerminalMode()

  const detachKeyboard = attachKeyboard(process.stdin, (key: KeyEvent) => {
    if (key === "quit") {
      quit()
      return
    }
    state = navigate(state, key)
    repaint()
  })

  const spinnerTimer = setInterval(() => {
    state = tick(state)
    repaint()
  }, SPINNER_INTERVAL_MS)
  spinnerTimer.unref?.()

  repaint()

  try {
    await connect(
      baseUrl,
      {
        onSeed: (events) => {
          for (const ev of events) state = reduce(state, ev)
          repaint()
        },
        onEvent: (ev) => {
          state = reduce(state, ev)
          repaint()
        },
        onClose: () => {
          // Server closed the stream; leave the last frame on screen.
        },
        onError: (err: DashboardConnectionError) => {
          clearInterval(spinnerTimer)
          detachKeyboard()
          restoreTerminalMode()
          // eslint-disable-next-line no-console
          console.error(err.message)
          process.exitCode = 1
        },
      },
      abortController.signal,
    )
  } finally {
    clearInterval(spinnerTimer)
    detachKeyboard()
  }
}

// Only auto-run when executed directly (not when imported by tests).
const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /tui[\\/]cli\.(ts|js)$/.test(process.argv[1])

if (isMain) {
  main().catch((err) => {
    restoreTerminalMode()
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
