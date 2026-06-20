/**
 * Raw stdin keypress parser for the workflow TUI.
 *
 * Parses raw byte sequences (read from `process.stdin` in raw mode) into
 * semantic key events: up/down/enter/back/quit. No terminal setup lives
 * here — `cli.ts` owns `setRawMode`/listener wiring; this module is a pure
 * byte-string -> KeyEvent mapper plus a thin attach/detach helper.
 */

export type KeyEvent = "up" | "down" | "enter" | "back" | "quit"

/**
 * Parse a single raw chunk of stdin bytes into zero or more semantic key
 * events. A chunk may contain more than one logical keypress (e.g. pasted
 * text or back-to-back escape sequences), so this returns an array.
 */
export function parseKeypress(chunk: string): KeyEvent[] {
  const events: KeyEvent[] = []
  let i = 0
  while (i < chunk.length) {
    const ch = chunk[i]

    // Ctrl+C
    if (ch === "\x03") {
      events.push("quit")
      i += 1
      continue
    }

    // Escape sequences: ESC [ A/B/C/D  (arrow keys) or bare ESC (back).
    if (ch === "\x1b") {
      if (chunk[i + 1] === "[" && chunk[i + 2] !== undefined) {
        const code = chunk[i + 2]
        if (code === "A") {
          events.push("up")
          i += 3
          continue
        }
        if (code === "B") {
          events.push("down")
          i += 3
          continue
        }
        if (code === "C") {
          events.push("enter") // Right arrow == drill in, same as Enter
          i += 3
          continue
        }
        if (code === "D") {
          events.push("back") // Left arrow == drill out, same as Escape
          i += 3
          continue
        }
        // Unrecognized CSI sequence; skip the ESC [ and the next byte.
        i += 3
        continue
      }
      // Bare ESC (no following '[') == back.
      events.push("back")
      i += 1
      continue
    }

    // Enter (CR or LF).
    if (ch === "\r" || ch === "\n") {
      events.push("enter")
      i += 1
      continue
    }

    // 'q' or 'Q' quits.
    if (ch === "q" || ch === "Q") {
      events.push("quit")
      i += 1
      continue
    }

    i += 1
  }
  return events
}

/**
 * Attach a raw-mode keypress listener to a stdin-like stream, calling
 * `onKey` for each semantic event. Returns a detach function that removes
 * the listener (does not touch raw-mode state — caller owns that).
 */
export function attachKeyboard(
  stdin: NodeJS.ReadStream,
  onKey: (event: KeyEvent) => void,
): () => void {
  const listener = (data: Buffer | string): void => {
    const chunk = typeof data === "string" ? data : data.toString("utf8")
    for (const ev of parseKeypress(chunk)) {
      onKey(ev)
    }
  }
  stdin.on("data", listener)
  return () => {
    stdin.off("data", listener)
  }
}
