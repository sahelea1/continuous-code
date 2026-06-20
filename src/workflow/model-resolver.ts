/**
 * Model resolver — the single place CC-style model shorthands become v1
 * `{ providerID, modelID }` (plan §B, §E.2).
 *
 * This centralizes two awkward facts so the rest of the engine never has to:
 *
 *  1. **v1 uses `model.modelID` (NOT `model.id`).** Everywhere downstream we
 *     build `{ providerID, modelID }`; if a provider ever rejects the field
 *     name, it is flipped HERE and nowhere else.
 *  2. **Effort is orthogonal in OpenCode** — `session.prompt`'s v1 body has no
 *     per-call effort field (verified in types.gen.d.ts). So `effort` is carried
 *     through and mapped to *agent selection* instead: a "max"/"high" effort node
 *     is routed to a `*-max` / `*-high` agent variant when one is enumerated by
 *     `client.app.agents()`. We never invent a per-prompt effort knob.
 *
 * Resolution strategy for a model shorthand:
 *  - `"opus" | "sonnet" | "haiku"` (CC class names): pick the model of the
 *    agent whose enumerated model best matches that class (substring on modelID),
 *    else fall back to a configured default, else the first available agent's
 *    model. Class match is provider-agnostic (works for anthropic, glm, etc.).
 *  - `"inherit"` / empty / undefined: use the default agent's model (or the
 *    first agent that declares one).
 *  - `"{providerID}:{modelID}"` (a full id, contains a ":"): split verbatim.
 *  - a bare modelID with no ":" and no class match: pair it with the default
 *    provider inferred from the agent fleet.
 *
 * Pure-ish: the only side effect is one cached `client.app.agents()` call.
 * Never throws — every failure path returns a best-effort fallback so a single
 * agent turn can still run.
 */
import type { PluginInput } from "@opencode-ai/plugin"

type ResolverClient = PluginInput["client"]

/** v1 model selector accepted by `session.prompt` body.model. */
export interface ResolvedModel {
  providerID: string
  modelID: string
}

/** Output of {@link resolveModel}: the v1 model plus the (possibly remapped) agent type. */
export interface ResolvedAgentModel {
  /** The `{ providerID, modelID }` to put in `session.prompt` body.model. */
  model: ResolvedModel
  /** The agent type to put in `session.prompt` body.agent (may be an effort variant). */
  agentType: string
  /** "{providerID}:{modelID}" for dashboard display. */
  display: string
}

/** Minimal shape we read off an enumerated agent (subset of SDK `Agent`). */
interface AgentLike {
  name: string
  model?: { modelID: string; providerID: string }
}

/** CC class names → substring hints matched against modelID (case-insensitive). */
const CLASS_HINTS: Record<string, string[]> = {
  opus: ["opus", "glm-4.6", "glm-4-plus", "max"],
  sonnet: ["sonnet", "glm-4.5", "glm-4-air"],
  haiku: ["haiku", "glm-4-flash", "flash", "mini"],
}

const CLASS_NAMES = new Set(Object.keys(CLASS_HINTS))

/**
 * Caches `client.app.agents()` so a fan-out of 100 agent turns does not make
 * 100 identical enumeration calls. Keyed by the client instance.
 */
export class ModelResolver {
  private readonly client: ResolverClient
  private readonly directory?: string
  /** Cached enumeration; populated lazily on first resolve. */
  private agentsCache: AgentLike[] | null = null
  /** In-flight enumeration promise (de-dupes concurrent first calls). */
  private agentsInFlight: Promise<AgentLike[]> | null = null
  /** Optional configured default "{providerID}:{modelID}" or class shorthand. */
  private readonly defaultModel?: string

  constructor(
    client: ResolverClient,
    opts: { directory?: string; defaultModel?: string } = {},
  ) {
    this.client = client
    this.directory = opts.directory
    this.defaultModel = opts.defaultModel
  }

  /**
   * Enumerate agents once and cache. Never throws — returns [] on failure so
   * resolution falls through to the pure-string fast paths.
   */
  private async agents(): Promise<AgentLike[]> {
    if (this.agentsCache) return this.agentsCache
    if (this.agentsInFlight) return this.agentsInFlight
    this.agentsInFlight = (async () => {
      try {
        const res = await this.client.app.agents(
          this.directory ? { query: { directory: this.directory } } : undefined,
        )
        const list = (res?.data ?? []) as AgentLike[]
        this.agentsCache = Array.isArray(list) ? list : []
      } catch {
        this.agentsCache = []
      }
      this.agentsInFlight = null
      return this.agentsCache
    })()
    return this.agentsInFlight
  }

  /**
   * Resolve a CC-style model shorthand + an agentType + an effort into the v1
   * `{ providerID, modelID }`, the (possibly effort-remapped) agentType, and a
   * display string.
   *
   * @param agentType the requested OpenCode agent name (e.g. "implementer").
   * @param model     "opus"|"sonnet"|"haiku"|"inherit"|"{providerID}:{modelID}"|bare-id|undefined.
   * @param effort    "low"|"medium"|"high"|"max"|undefined — used only to pick a
   *                  variant agent when one exists; never put on the prompt.
   */
  async resolve(
    agentType: string,
    model?: string,
    effort?: "low" | "medium" | "high" | "max",
  ): Promise<ResolvedAgentModel> {
    const agents = await this.agents()
    const resolvedModel = this.resolveModelString(model, agents)
    const resolvedAgentType = this.resolveAgentType(agentType, effort, agents)
    return {
      model: resolvedModel,
      agentType: resolvedAgentType,
      display: `${resolvedModel.providerID}:${resolvedModel.modelID}`,
    }
  }

  // --- model string resolution ---------------------------------------------

  private resolveModelString(model: string | undefined, agents: AgentLike[]): ResolvedModel {
    const raw = (model ?? "").trim()

    // 1. inherit / empty → default model.
    if (raw === "" || raw.toLowerCase() === "inherit") {
      return this.defaultOrFirst(agents)
    }

    // 2. full "{providerID}:{modelID}" → split verbatim (the v1 quirk lives here).
    if (raw.includes(":")) {
      const idx = raw.indexOf(":")
      const providerID = raw.slice(0, idx).trim()
      const modelID = raw.slice(idx + 1).trim()
      if (providerID && modelID) return { providerID, modelID }
      // Malformed (":" but a missing half) → treat the non-empty half as a class/bare id.
      const bare = providerID || modelID
      return this.resolveModelString(bare, agents)
    }

    // 3. CC class name → best-matching agent model, else default fallback.
    const lower = raw.toLowerCase()
    if (CLASS_NAMES.has(lower)) {
      const byClass = this.findModelForClass(lower, agents)
      if (byClass) return byClass
      // No agent matches the class → try the configured default, then first.
      return this.defaultOrFirst(agents)
    }

    // 4. a bare modelID (no ":" no class) → pair with inferred default provider.
    const providerID = this.defaultOrFirst(agents).providerID
    return { providerID, modelID: raw }
  }

  /** Find the model of the agent whose modelID best matches a CC class. */
  private findModelForClass(className: string, agents: AgentLike[]): ResolvedModel | null {
    const hints = CLASS_HINTS[className] ?? [className]
    for (const hint of hints) {
      for (const a of agents) {
        const m = a.model
        if (m && m.modelID && m.modelID.toLowerCase().includes(hint)) {
          return { providerID: m.providerID, modelID: m.modelID }
        }
      }
    }
    return null
  }

  /**
   * The default model: the configured `defaultModel` (recursively resolved if it
   * is itself a class / id) else the first enumerated agent that declares a
   * model, else a conservative anthropic placeholder so a turn can still run.
   */
  private defaultOrFirst(agents: AgentLike[]): ResolvedModel {
    if (this.defaultModel && this.defaultModel.trim() !== "") {
      // Guard against infinite recursion: only recurse when the default is NOT
      // itself just "inherit"/empty.
      const d = this.defaultModel.trim().toLowerCase()
      if (d !== "inherit") {
        // Resolve the configured default WITHOUT consulting defaultModel again
        // for the empty/inherit branch (it has a concrete value here).
        if (this.defaultModel.includes(":")) {
          const idx = this.defaultModel.indexOf(":")
          const providerID = this.defaultModel.slice(0, idx).trim()
          const modelID = this.defaultModel.slice(idx + 1).trim()
          if (providerID && modelID) return { providerID, modelID }
        }
        if (CLASS_NAMES.has(d)) {
          const m = this.findModelForClass(d, agents)
          if (m) return m
        }
      }
    }
    for (const a of agents) {
      if (a.model && a.model.modelID && a.model.providerID) {
        return { providerID: a.model.providerID, modelID: a.model.modelID }
      }
    }
    // Last-resort placeholder — keeps the call well-formed if enumeration failed.
    return { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" }
  }

  // --- agentType / effort resolution ---------------------------------------

  /**
   * Map effort to an agent variant when one exists. High/max effort prefers a
   * `{agentType}-max` then `{agentType}-high` variant; otherwise the base agent
   * is used verbatim. If the base agent is not enumerated at all we still return
   * it (the server validates) — enumeration may be incomplete, never block.
   */
  private resolveAgentType(
    agentType: string,
    effort: "low" | "medium" | "high" | "max" | undefined,
    agents: AgentLike[],
  ): string {
    const base = (agentType ?? "").trim()
    if (!base) return base
    if (effort !== "high" && effort !== "max") return base

    const names = new Set(agents.map((a) => a.name))
    const candidates =
      effort === "max"
        ? [`${base}-max`, `${base}-high`]
        : [`${base}-high`, `${base}-max`]
    for (const c of candidates) {
      if (names.has(c)) return c
    }
    return base
  }

  /** Drop the cache (e.g. if the agent fleet changes mid-run). */
  invalidate(): void {
    this.agentsCache = null
    this.agentsInFlight = null
  }
}
