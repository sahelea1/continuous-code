/**
 * Workflow dashboard server (plan §A.4, §B dashboard).
 *
 * Starts a tiny Bun.serve HTTP server that:
 *   GET /           → serves assets/workflow-dashboard.html
 *   GET /events     → text/event-stream (SSE) relaying ui-bus WorkflowEvents
 *   GET /state      → JSON snapshot of ring-buffer for late joiners
 *
 * Rules matching the codebase discipline:
 *  - Feature-detects globalThis.Bun; no-ops gracefully if absent.
 *  - Idempotent: second call with the same port is a no-op; EADDRINUSE is
 *    silently caught and treated as "already started by another process".
 *  - Never throws — every async path is wrapped in try/catch.
 *  - Surfaces the URL via client.tui.showToast if available, else client.app.log.
 *  - unref()s the server so it does not keep the process alive.
 */

import { readFileSync, existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { homedir, networkInterfaces } from "os"
import { uiBus } from "./ui-bus.js"
import type { WorkflowEvent } from "./types.js"

// ---------------------------------------------------------------------------
// Types / helpers
// ---------------------------------------------------------------------------

/** Minimal surface of the OpenCode v1 client we actually use here. */
interface DashboardClient {
  tui?: {
    showToast?: (msg: string) => void | Promise<void>
  }
  app?: {
    log?: (level: string, msg: string) => void | Promise<void>
  }
}

/** Track the live SSE response writers so we can broadcast to all. */
interface SseWriter {
  write: (chunk: string) => void | Promise<void>
  closed: boolean
}

// ---------------------------------------------------------------------------
// Module-level singleton state
// ---------------------------------------------------------------------------

let started = false
let resolvedUrl = ""
// LAN-accessible URL (http://<first-non-internal-IPv4>:<port>), or "" if the
// host has no routable IPv4 interface. resolvedUrl stays the localhost URL for
// local clients (the TUI connects locally); lanUrl is purely informational.
let lanUrl = ""
const sseWriters: Set<SseWriter> = new Set()

/**
 * First non-internal IPv4 address of this host, or undefined if none.
 *
 * Used to build a LAN-accessible dashboard URL. We derive the IP from
 * os.networkInterfaces() rather than from the Bun server object, because
 * Bun reports server.hostname as "0.0.0.0" (the bind address) rather than a
 * routable address.
 */
function firstLanIPv4(): string | undefined {
  let ifaces: ReturnType<typeof networkInterfaces>
  try {
    ifaces = networkInterfaces()
  } catch {
    return undefined
  }
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      // Node typings vary across versions: family may be the string "IPv4"
      // or the numeric 4. Accept both.
      const fam = (ni as { family: string | number }).family
      if ((fam === "IPv4" || fam === 4) && !ni.internal && ni.address) {
        return ni.address
      }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Asset resolution — robustly find workflow-dashboard.html
// ---------------------------------------------------------------------------

function findDashboardHtml(): string | null {
  // Try relative to this compiled file's directory (dist/workflow/ → assets/).
  const candidates: string[] = []

  try {
    // ESM __dirname equivalent.
    const thisDir = dirname(fileURLToPath(import.meta.url))
    // dist/workflow/ → ../../assets/ (repo root)
    candidates.push(join(thisDir, "..", "..", "assets", "workflow-dashboard.html"))
    // dist/ → ../assets/
    candidates.push(join(thisDir, "..", "assets", "workflow-dashboard.html"))
    // Same directory (flat builds)
    candidates.push(join(thisDir, "assets", "workflow-dashboard.html"))
  } catch {
    // import.meta.url may be unavailable in some environments.
  }

  // CWD-relative fallback (works when running from repo root in dev/bun test).
  candidates.push(join(process.cwd(), "assets", "workflow-dashboard.html"))
  // Installed-config fallback — matches install.sh's ASSETS_DST
  // ($CONFIG_DIR/continuous), which copies assets/* there.
  candidates.push(
    join(homedir(), ".config", "opencode", "continuous", "workflow-dashboard.html"),
  )

  for (const p of candidates) {
    try {
      if (existsSync(p)) return p
    } catch {
      // keep trying
    }
  }
  return null
}

// Read the HTML once at startup (file is static; no hot-reload needed).
let dashboardHtml: Uint8Array | null = null

function getDashboardHtml(): string {
  if (dashboardHtml) return new TextDecoder().decode(dashboardHtml)
  const path = findDashboardHtml()
  if (path) {
    try {
      const content = readFileSync(path, "utf-8")
      dashboardHtml = new TextEncoder().encode(content)
      return content
    } catch {
      // fall through to inline fallback
    }
  }
  // Minimal fallback so the server still responds if the asset is missing.
  const fallback =
    "<!DOCTYPE html><html><body><p>Workflow dashboard asset not found. " +
    "Check that assets/workflow-dashboard.html is present.</p></body></html>"
  dashboardHtml = new TextEncoder().encode(fallback)
  return fallback
}

// ---------------------------------------------------------------------------
// SSE broadcast helpers
// ---------------------------------------------------------------------------

function fmtSse(event: WorkflowEvent): string {
  // SSE wire format: the dashboard listens on the default "message" event type,
  // so we emit:  data: <json>\n\n
  return `data: ${JSON.stringify(event)}\n\n`
}

function fmtKeepAlive(): string {
  return `: keepalive\n\n`
}

async function broadcast(event: WorkflowEvent): Promise<void> {
  const payload = fmtSse(event)
  const dead: SseWriter[] = []
  for (const w of sseWriters) {
    if (w.closed) {
      dead.push(w)
      continue
    }
    try {
      await w.write(payload)
    } catch {
      w.closed = true
      dead.push(w)
    }
  }
  for (const w of dead) sseWriters.delete(w)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the dashboard server on `port` (0 = ephemeral OS-assigned port).
 *
 * Returns the base URL (e.g. "http://localhost:7878") once the server is
 * listening, or "" if Bun.serve is unavailable or the port is already in use.
 *
 * Idempotent: subsequent calls return the already-resolved URL.
 * Never throws.
 */
export async function startDashboard(
  port: number,
  _registrySnapshot?: () => unknown,
  client?: DashboardClient,
): Promise<string> {
  if (started) return resolvedUrl

  // Feature-detect Bun.serve.
  if (
    typeof globalThis === "undefined" ||
    !("Bun" in globalThis) ||
    typeof (globalThis as Record<string, unknown>).Bun !== "object"
  ) {
    return ""
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const BunGlobal = (globalThis as any).Bun

  if (typeof BunGlobal?.serve !== "function") {
    return ""
  }

  try {
    // Subscribe to ui-bus so we relay events to all SSE clients.
    const busListener = (event: WorkflowEvent): void => {
      broadcast(event).catch(() => {
        // broadcast is best-effort; swallow errors.
      })
    }
    uiBus.on(busListener)

    // Kick off a keep-alive ping every 15 s to prevent proxy timeouts.
    const keepAliveTimer = setInterval(() => {
      const ka = fmtKeepAlive()
      const dead: SseWriter[] = []
      for (const w of sseWriters) {
        if (w.closed) {
          dead.push(w)
          continue
        }
        try {
          w.write(ka)
        } catch {
          w.closed = true
          dead.push(w)
        }
      }
      for (const w of dead) sseWriters.delete(w)
    }, 15_000)
    // Don't prevent process exit.
    if (typeof keepAliveTimer === "object" && keepAliveTimer !== null) {
      (keepAliveTimer as unknown as { unref(): void }).unref?.()
    }

    // Build the Bun server.
    const server = BunGlobal.serve({
      // Bind all network interfaces (0.0.0.0) so the dashboard is reachable
      // from other devices on the local network — intentional, per user
      // request. This exposes the dashboard to the local network, not just
      // localhost. (Bun already defaults to 0.0.0.0; set explicitly for clarity.)
      hostname: "0.0.0.0",
      port,
      // Disable idle timeout so SSE streams are not closed by Bun after 10 s
      // of inactivity. 0 = no timeout (streams stay open until the client
      // disconnects or the server is shut down).
      idleTimeout: 0,
      // Bun.serve fetch handler — returns a Response for each request.
      // We use the low-level readable stream API for SSE so we don't need
      // a separate HTTP framework.
      fetch(req: Request): Response {
        const url = new URL(req.url)

        // ── GET / → serve the dashboard HTML ──────────────────────────────
        if (url.pathname === "/" || url.pathname === "") {
          return new Response(getDashboardHtml(), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-cache",
            },
          })
        }

        // ── GET /state → JSON snapshot for late joiners ──────────────────
        if (url.pathname === "/state") {
          const events = uiBus.snapshot()
          return new Response(JSON.stringify({ events }), {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-cache",
            },
          })
        }

        // ── GET /events → SSE stream ──────────────────────────────────────
        if (url.pathname === "/events") {
          let writer: SseWriter | null = null

          const stream = new ReadableStream({
            start(controller) {
              writer = {
                write(chunk: string) {
                  try {
                    controller.enqueue(new TextEncoder().encode(chunk))
                  } catch {
                    // Stream closed; mark dead.
                    if (writer) writer.closed = true
                  }
                },
                closed: false,
              }
              sseWriters.add(writer)

              // Immediately send a state.seed event so the client bootstraps
              // from the ring-buffer without a separate /state fetch.
              const snapshot = uiBus.snapshot()
              if (snapshot.length > 0) {
                const seedPayload =
                  `data: ${JSON.stringify({ type: "state.seed", events: snapshot })}\n\n`
                try {
                  controller.enqueue(new TextEncoder().encode(seedPayload))
                } catch {
                  // ignore
                }
              }
            },
            cancel() {
              if (writer) {
                writer.closed = true
                sseWriters.delete(writer)
              }
            },
          })

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              // Allow cross-origin EventSource (dev convenience).
              "Access-Control-Allow-Origin": "*",
            },
          })
        }

        // ── 404 for anything else ─────────────────────────────────────────
        return new Response("Not found", { status: 404 })
      },
      // Catch port-in-use and other listen errors; treat as "already started".
      error(err: Error): Response {
        const msg = err?.message ?? ""
        if (msg.includes("EADDRINUSE") || msg.includes("address already in use")) {
          // Silently ignore — another instance is serving on this port.
        }
        return new Response("Internal server error", { status: 500 })
      },
    })

    // Resolve the actual port (important when port=0).
    const actualPort: number =
      typeof server?.port === "number" ? server.port : port

    // resolvedUrl stays the localhost URL — local clients (the TUI) connect
    // locally. The LAN URL is computed separately and surfaced for users who
    // want to open the dashboard from another device on the network.
    resolvedUrl = `http://localhost:${actualPort}`
    const lanIP = firstLanIPv4()
    lanUrl = lanIP ? `http://${lanIP}:${actualPort}` : ""
    started = true

    // unref() the server so it doesn't keep the process alive.
    if (typeof server?.unref === "function") {
      server.unref()
    }

    // Surface both URLs to the user (localhost + LAN if available).
    await _notifyUser(resolvedUrl, lanUrl || undefined, client)

    // Return contract unchanged: callers still get the localhost URL.
    return resolvedUrl
  } catch (err) {
    // EADDRINUSE or any other error — treat as graceful no-op.
    const msg = (err as Error)?.message ?? ""
    if (msg.includes("EADDRINUSE") || msg.includes("address already in use")) {
      // Another dashboard is already listening — silently return empty.
      return ""
    }
    // Log unexpected errors but never throw.
    try {
      await client?.app?.log?.("warn", `[dashboard] startDashboard error: ${msg}`)
    } catch {
      // ignore
    }
    return ""
  }
}

/** Internal: surface the URL(s) via toast or log. Never throws. */
async function _notifyUser(
  localUrl: string,
  lanUrl?: string,
  client?: DashboardClient,
): Promise<void> {
  const msg = lanUrl
    ? `Workflow dashboard: ${localUrl}  (LAN: ${lanUrl})`
    : `Workflow dashboard: ${localUrl}`
  try {
    if (typeof client?.tui?.showToast === "function") {
      await client.tui.showToast(msg)
      return
    }
    if (typeof client?.app?.log === "function") {
      await client.app.log("info", `[dashboard] ${msg}`)
    }
  } catch {
    // Never propagate.
  }
}

/**
 * Return the currently resolved dashboard URL, or "" if not yet started.
 * Useful for the ultracode tool to include in its output.
 */
export function getDashboardUrl(): string {
  return resolvedUrl
}

/**
 * Return the LAN-accessible dashboard URL (http://<lan-ip>:<port>), or "" if
 * the server is not started or the host has no routable non-internal IPv4.
 * Lets the ultracode tool surface the LAN URL in its discoverability log.
 */
export function getDashboardLanUrl(): string {
  return lanUrl
}

/**
 * Reset singleton state (test helper only — NOT for production use).
 * Exposed so smoke tests can re-start the server on a fresh ephemeral port.
 */
export function _resetDashboardState(): void {
  started = false
  resolvedUrl = ""
  lanUrl = ""
  sseWriters.clear()
  dashboardHtml = null
}
