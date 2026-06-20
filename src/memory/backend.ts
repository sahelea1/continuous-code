/**
 * Memory backend: the `MemoryBackend` interface, the `getMemoryBackend()`
 * factory (process-wide cache + graceful degrade), schema auto-apply on first
 * open, and full store()/recall() behavior.
 *
 * Native deps (`better-sqlite3`, `pg`) are **lazy-imported** (reconciliation
 * R9): a missing/broken native module disables memory (WARN once, return a
 * NoneBackend) instead of crashing the plugin. The factory NEVER throws.
 *
 * Schema DDL is applied from the TS constants in `schema-sql.ts` (R3) — the
 * `.sql` files on disk are canonical source-of-truth copies, but are never read
 * at runtime (keeps the build `tsc`-only, avoids dist/ path resolution).
 */
import { randomUUID } from "crypto"
import { dirname } from "path"
import { mkdirSync } from "fs"
import {
  loadMemoryConfig,
  resolvePostgresUrl,
  type MemoryConfig,
} from "./config.js"
import { getEmbedder, type Embedder } from "./embeddings.js"
import { POSTGRES_SCHEMA, SQLITE_SCHEMA } from "./schema-sql.js"

export interface MemoryRecord {
  id: string
  session_id: string
  agent_id?: string | null
  content: string
  metadata: Record<string, unknown>
  created_at: string // ISO string
}

export interface RecallResult extends MemoryRecord {
  score: number // higher = better (normalized 0..1-ish)
}

export interface StoreInput {
  session_id: string
  agent_id?: string
  content: string
  /** metadata.type defaults to "session_learning"; learning_type/context/tags/confidence merged in. */
  metadata?: Record<string, unknown>
}

export interface StoreResult {
  stored: boolean
  skipped?: boolean
  reason?: string // e.g. "duplicate (similarity: 0.91)" or "memory disabled"
  id?: string
  backend: string // "sqlite" | "postgres" | "none"
}

export interface RecallOptions {
  limit?: number // default cfg.recallLimit
  textOnly?: boolean // default true when embeddings.provider==="none"
}

export interface MemoryBackend {
  readonly kind: "sqlite" | "postgres" | "none"
  store(input: StoreInput): Promise<StoreResult>
  recall(query: string, opts?: RecallOptions): Promise<RecallResult[]>
  close(): Promise<void>
}

const LEARNING_TYPE = "session_learning"
const SQLITE_DEDUP_SCAN_CAP = 2000

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Build the metadata object that gets persisted alongside a stored learning. */
function buildMetadata(input: StoreInput): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: LEARNING_TYPE,
    session_id: input.session_id,
    timestamp: new Date().toISOString(),
  }
  const caller = input.metadata ?? {}
  const merged: Record<string, unknown> = { ...base, ...caller }
  // `type` may only ever be "session_learning" unless the caller explicitly
  // supplied a (string) type — but recall always filters on session_learning,
  // so coerce anything falsy back to the canonical value.
  if (typeof merged.type !== "string" || merged.type.trim().length === 0) {
    merged.type = LEARNING_TYPE
  }
  return merged
}

/** Cosine similarity of two equal-length numeric vectors. Returns 0 on bad input. */
function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Pack a float64 array into a float32 little-endian Buffer (sqlite BLOB). */
function packFloat32LE(vec: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4)
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4)
  return buf
}

/** Unpack a float32 little-endian Buffer into a number[]. */
function unpackFloat32LE(buf: Buffer, dim: number): number[] {
  const out = new Array<number>(dim)
  for (let i = 0; i < dim; i++) out[i] = buf.readFloatLE(i * 4)
  return out
}

/** Format a vector for a postgres `::vector` literal: "[1,2,3]". */
function toPgVector(vec: number[]): string {
  return "[" + vec.join(",") + "]"
}

/**
 * Tokenize a free-text query into lowercase word terms (>2 chars), dropping a
 * small set of meta-words. Mirrors CC-v3 recall preprocessing.
 */
function queryTerms(query: string): string[] {
  const META = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "have",
    "what",
    "how",
    "when",
    "where",
    "why",
    "find",
    "search",
    "show",
    "get",
    "about",
  ])
  const words = (query.toLowerCase().match(/\w+/g) ?? []).filter(
    (w) => w.length > 2 && !META.has(w),
  )
  return Array.from(new Set(words))
}

// ---------------------------------------------------------------------------
// NoneBackend
// ---------------------------------------------------------------------------

class NoneBackend implements MemoryBackend {
  readonly kind = "none" as const
  async store(_input: StoreInput): Promise<StoreResult> {
    return { stored: false, backend: "none" }
  }
  async recall(_query: string, _opts?: RecallOptions): Promise<RecallResult[]> {
    return []
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

const NONE_BACKEND = new NoneBackend()

// ---------------------------------------------------------------------------
// SqliteBackend
// ---------------------------------------------------------------------------

interface SqliteRow {
  id: string
  session_id: string
  agent_id: string | null
  content: string
  metadata_json: string | null
  embedding: Buffer | null
  embedding_dim: number | null
  created_at: number
}

class SqliteBackend implements MemoryBackend {
  readonly kind = "sqlite" as const
  private readonly db: any
  private readonly cfg: MemoryConfig
  private readonly embedder: Embedder

  constructor(db: any, cfg: MemoryConfig, embedder: Embedder) {
    this.db = db
    this.cfg = cfg
    this.embedder = embedder
  }

  private rowToRecord(row: SqliteRow): MemoryRecord {
    let metadata: Record<string, unknown> = {}
    try {
      metadata = row.metadata_json
        ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
        : {}
    } catch {
      metadata = {}
    }
    return {
      id: row.id,
      session_id: row.session_id,
      agent_id: row.agent_id,
      content: row.content,
      metadata,
      created_at: new Date(row.created_at * 1000).toISOString(),
    }
  }

  async store(input: StoreInput): Promise<StoreResult> {
    const metadata = buildMetadata(input)

    let embedding: number[] | null = null
    if (this.embedder.provider !== "none") {
      try {
        embedding = await this.embedder.embed(input.content)
      } catch {
        embedding = null // non-fatal: store with NULL embedding
      }
    }

    // Dedup only when an embedding was produced.
    if (embedding) {
      const dup = this.findDuplicate(embedding)
      if (dup) {
        return {
          stored: true,
          skipped: true,
          reason: `duplicate (similarity: ${dup.similarity.toFixed(2)})`,
          id: dup.id,
          backend: "sqlite",
        }
      }
    }

    const id = randomUUID()
    const createdAt = Math.floor(Date.now() / 1000)
    const blob = embedding ? packFloat32LE(embedding) : null
    const dim = embedding ? embedding.length : null

    this.db
      .prepare(
        `INSERT INTO archival_memory
          (id, session_id, agent_id, content, metadata_json, embedding, embedding_dim, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.session_id,
        input.agent_id ?? null,
        input.content,
        JSON.stringify(metadata),
        blob,
        dim,
        createdAt,
      )

    return { stored: true, id, backend: "sqlite" }
  }

  /** Scan up to N most-recent embedded rows of the same type; return best match ≥ threshold. */
  private findDuplicate(
    queryVec: number[],
  ): { id: string; similarity: number } | null {
    const rows = this.db
      .prepare(
        `SELECT id, embedding, embedding_dim, metadata_json
           FROM archival_memory
          WHERE embedding IS NOT NULL
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(SQLITE_DEDUP_SCAN_CAP) as Array<{
      id: string
      embedding: Buffer
      embedding_dim: number | null
      metadata_json: string | null
    }>

    let best: { id: string; similarity: number } | null = null
    for (const r of rows) {
      if (!r.embedding || !r.embedding_dim) continue
      // Only compare against rows of the same learning type.
      try {
        const md = r.metadata_json
          ? (JSON.parse(r.metadata_json) as Record<string, unknown>)
          : {}
        if (md.type !== LEARNING_TYPE) continue
      } catch {
        continue
      }
      if (r.embedding_dim !== queryVec.length) continue
      const sim = cosine(queryVec, unpackFloat32LE(r.embedding, r.embedding_dim))
      if (!best || sim > best.similarity) best = { id: r.id, similarity: sim }
    }
    if (best && best.similarity >= this.cfg.dedupThreshold) return best
    return null
  }

  async recall(query: string, opts?: RecallOptions): Promise<RecallResult[]> {
    const limit = opts?.limit ?? this.cfg.recallLimit
    const wantSemantic =
      opts?.textOnly === false ||
      (opts?.textOnly === undefined && this.embedder.provider !== "none")

    // FTS text candidates (always computed; basis for text-only and hybrid).
    const textResults = this.recallText(query, limit * 4)

    if (!wantSemantic) {
      return textResults.slice(0, limit)
    }

    // Semantic path: embed the query, cosine over stored embeddings, RRF-blend.
    let queryVec: number[] | null = null
    try {
      queryVec = await this.embedder.embed(query)
    } catch {
      queryVec = null
    }
    if (!queryVec) {
      return textResults.slice(0, limit) // embedding failed -> text-only fallback
    }

    const vecResults = this.recallVector(queryVec, limit * 4)
    if (vecResults.length === 0) {
      return textResults.slice(0, limit) // no embedded rows -> text-only
    }

    return this.rrfBlend(textResults, vecResults, limit)
  }

  /** sqlite FTS5 BM25 text recall. Mirrors recall_learnings.py:186-234. */
  private recallText(query: string, limit: number): RecallResult[] {
    const terms = queryTerms(query)
    if (terms.length === 0) return []
    const match = terms.join(" OR ")
    let rows: Array<SqliteRow & { rank: number }>
    try {
      rows = this.db
        .prepare(
          `SELECT m.id, m.session_id, m.agent_id, m.content, m.metadata_json,
                  m.embedding, m.embedding_dim, m.created_at,
                  bm25(archival_fts) AS rank
             FROM archival_fts
             JOIN archival_memory m ON m.rowid = archival_fts.rowid
            WHERE archival_fts MATCH ?
            ORDER BY rank ASC
            LIMIT ?`,
        )
        .all(match, limit) as Array<SqliteRow & { rank: number }>
    } catch {
      return [] // malformed FTS query etc.
    }
    return rows
      .map((r) => {
        const rec = this.rowToRecord(r)
        if (rec.metadata.type !== LEARNING_TYPE) return null
        const score = Math.min(1, Math.max(0, -r.rank / 25))
        return { ...rec, score }
      })
      .filter((r): r is RecallResult => r !== null)
  }

  /** JS cosine over stored embeddings (same-type, same-dim). */
  private recallVector(queryVec: number[], limit: number): RecallResult[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, agent_id, content, metadata_json,
                embedding, embedding_dim, created_at
           FROM archival_memory
          WHERE embedding IS NOT NULL
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(SQLITE_DEDUP_SCAN_CAP) as SqliteRow[]

    const scored: RecallResult[] = []
    for (const r of rows) {
      if (!r.embedding || !r.embedding_dim) continue
      if (r.embedding_dim !== queryVec.length) continue
      const rec = this.rowToRecord(r)
      if (rec.metadata.type !== LEARNING_TYPE) continue
      const sim = cosine(queryVec, unpackFloat32LE(r.embedding, r.embedding_dim))
      scored.push({ ...rec, score: sim })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  /** Reciprocal-rank-fusion of text + vector result lists (rrf_k=60). */
  private rrfBlend(
    textResults: RecallResult[],
    vecResults: RecallResult[],
    limit: number,
  ): RecallResult[] {
    const RRF_K = 60
    const byId = new Map<string, { rec: RecallResult; score: number }>()
    const add = (list: RecallResult[]) => {
      list.forEach((rec, idx) => {
        const contrib = 1 / (RRF_K + idx + 1)
        const existing = byId.get(rec.id)
        if (existing) existing.score += contrib
        else byId.set(rec.id, { rec, score: contrib })
      })
    }
    add(textResults)
    add(vecResults)
    return Array.from(byId.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((e) => ({ ...e.rec, score: e.score }))
  }

  async close(): Promise<void> {
    try {
      this.db.close()
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// PostgresBackend
// ---------------------------------------------------------------------------

interface PgRow {
  id: string
  session_id: string
  agent_id: string | null
  content: string
  metadata: Record<string, unknown> | string | null
  created_at: Date | string
}

class PostgresBackend implements MemoryBackend {
  readonly kind = "postgres" as const
  private readonly pool: any
  private readonly cfg: MemoryConfig
  private readonly embedder: Embedder

  constructor(pool: any, cfg: MemoryConfig, embedder: Embedder) {
    this.pool = pool
    this.cfg = cfg
    this.embedder = embedder
  }

  private rowToRecord(row: PgRow): MemoryRecord {
    let metadata: Record<string, unknown> = {}
    if (row.metadata && typeof row.metadata === "object") {
      metadata = row.metadata as Record<string, unknown>
    } else if (typeof row.metadata === "string") {
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>
      } catch {
        metadata = {}
      }
    }
    const created =
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString()
    return {
      id: row.id,
      session_id: row.session_id,
      agent_id: row.agent_id,
      content: row.content,
      metadata,
      created_at: created,
    }
  }

  async store(input: StoreInput): Promise<StoreResult> {
    const metadata = buildMetadata(input)

    let embedding: number[] | null = null
    if (this.embedder.provider !== "none") {
      try {
        embedding = await this.embedder.embed(input.content)
      } catch {
        embedding = null
      }
    }

    if (embedding) {
      const dup = await this.findDuplicate(embedding)
      if (dup) {
        return {
          stored: true,
          skipped: true,
          reason: `duplicate (similarity: ${dup.similarity.toFixed(2)})`,
          id: dup.id,
          backend: "postgres",
        }
      }
    }

    if (embedding) {
      const res = await this.pool.query(
        `INSERT INTO archival_memory (session_id, agent_id, content, metadata, embedding)
         VALUES ($1, $2, $3, $4::jsonb, $5::vector)
         RETURNING id`,
        [
          input.session_id,
          input.agent_id ?? null,
          input.content,
          JSON.stringify(metadata),
          toPgVector(embedding),
        ],
      )
      return { stored: true, id: res.rows[0]?.id, backend: "postgres" }
    }

    const res = await this.pool.query(
      `INSERT INTO archival_memory (session_id, agent_id, content, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id`,
      [
        input.session_id,
        input.agent_id ?? null,
        input.content,
        JSON.stringify(metadata),
      ],
    )
    return { stored: true, id: res.rows[0]?.id, backend: "postgres" }
  }

  private async findDuplicate(
    queryVec: number[],
  ): Promise<{ id: string; similarity: number } | null> {
    try {
      const res = await this.pool.query(
        `SELECT id, 1 - (embedding <=> $1::vector) AS similarity
           FROM archival_memory
          WHERE embedding IS NOT NULL
            AND metadata->>'type' = $2
          ORDER BY embedding <=> $1::vector ASC
          LIMIT 1`,
        [toPgVector(queryVec), LEARNING_TYPE],
      )
      const row = res.rows[0]
      if (row && Number(row.similarity) >= this.cfg.dedupThreshold) {
        return { id: row.id, similarity: Number(row.similarity) }
      }
    } catch {
      /* dedup is best-effort */
    }
    return null
  }

  async recall(query: string, opts?: RecallOptions): Promise<RecallResult[]> {
    const limit = opts?.limit ?? this.cfg.recallLimit
    const wantSemantic =
      opts?.textOnly === false ||
      (opts?.textOnly === undefined && this.embedder.provider !== "none")

    if (wantSemantic) {
      let queryVec: number[] | null = null
      try {
        queryVec = await this.embedder.embed(query)
      } catch {
        queryVec = null
      }
      if (queryVec) {
        const hybrid = await this.recallHybrid(query, queryVec, limit)
        if (hybrid.length > 0) return hybrid
      }
      // fall through to text-only on embed failure / empty hybrid
    }
    return this.recallText(query, limit)
  }

  /** postgres ts_rank text recall. Mirrors recall_learnings.py:90-145. */
  private async recallText(
    query: string,
    limit: number,
  ): Promise<RecallResult[]> {
    const terms = queryTerms(query)
    if (terms.length > 0) {
      const tsquery = terms.join(" | ")
      const res = await this.pool.query(
        `SELECT id, session_id, agent_id, content, metadata, created_at,
                ts_rank(to_tsvector('english', content), to_tsquery('english', $1)) AS rank
           FROM archival_memory
          WHERE metadata->>'type' = $2
            AND to_tsvector('english', content) @@ to_tsquery('english', $1)
          ORDER BY rank DESC
          LIMIT $3`,
        [tsquery, LEARNING_TYPE, limit],
      )
      if (res.rows.length > 0) {
        return res.rows.map((r: PgRow & { rank: number }) => ({
          ...this.rowToRecord(r),
          score: Number(r.rank),
        }))
      }
    }

    // ILIKE first-word fallback when ts_query empty / no matches.
    const firstWord = (query.toLowerCase().match(/\w+/g) ?? [])[0]
    if (!firstWord) return []
    const res = await this.pool.query(
      `SELECT id, session_id, agent_id, content, metadata, created_at
         FROM archival_memory
        WHERE metadata->>'type' = $1
          AND content ILIKE $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [LEARNING_TYPE, `%${firstWord}%`, limit],
    )
    return res.rows.map((r: PgRow, i: number) => ({
      ...this.rowToRecord(r),
      score: Math.max(0, 1 - i * 0.05),
    }))
  }

  /** postgres hybrid RRF (FTS rank ⊕ vector rank, rrf_k=60). Mirrors recall_learnings.py:241-357. */
  private async recallHybrid(
    query: string,
    queryVec: number[],
    limit: number,
  ): Promise<RecallResult[]> {
    const terms = queryTerms(query)
    const tsquery = terms.length > 0 ? terms.join(" | ") : ""
    try {
      const res = await this.pool.query(
        `WITH fts AS (
            SELECT id, ROW_NUMBER() OVER (
                     ORDER BY ts_rank(to_tsvector('english', content), to_tsquery('english', $1)) DESC
                   ) AS rank
              FROM archival_memory
             WHERE metadata->>'type' = $3
               AND $1 <> ''
               AND to_tsvector('english', content) @@ to_tsquery('english', $1)
             LIMIT 100
         ),
         vec AS (
            SELECT id, ROW_NUMBER() OVER (
                     ORDER BY embedding <=> $2::vector ASC
                   ) AS rank
              FROM archival_memory
             WHERE metadata->>'type' = $3
               AND embedding IS NOT NULL
             ORDER BY embedding <=> $2::vector ASC
             LIMIT 100
         ),
         fused AS (
            SELECT COALESCE(fts.id, vec.id) AS id,
                   COALESCE(1.0 / (60 + fts.rank), 0) + COALESCE(1.0 / (60 + vec.rank), 0) AS rrf
              FROM fts
              FULL OUTER JOIN vec ON fts.id = vec.id
         )
         SELECT m.id, m.session_id, m.agent_id, m.content, m.metadata, m.created_at,
                fused.rrf AS rrf
           FROM fused
           JOIN archival_memory m ON m.id = fused.id
          ORDER BY fused.rrf DESC
          LIMIT $4`,
        [tsquery, toPgVector(queryVec), LEARNING_TYPE, limit],
      )
      return res.rows.map((r: PgRow & { rrf: number }) => ({
        ...this.rowToRecord(r),
        score: Number(r.rrf),
      }))
    } catch {
      return [] // caller falls back to text-only
    }
  }

  async close(): Promise<void> {
    try {
      await this.pool.end()
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Factory (cache + graceful degrade)
// ---------------------------------------------------------------------------

const cache = new Map<string, Promise<MemoryBackend>>()
const warned = new Set<string>()

/** WARN at most once per distinct message. */
function warnOnce(message: string): void {
  if (warned.has(message)) return
  warned.add(message)
  console.warn(message)
}

async function applySqliteSchema(db: any): Promise<void> {
  // better-sqlite3 exec() runs a multi-statement script.
  db.exec(SQLITE_SCHEMA)
}

async function applyPostgresSchema(pool: any): Promise<void> {
  // Apply statement-by-statement so a single failure (e.g. hnsw on old
  // pgvector) is logged, not fatal.
  const statements = POSTGRES_SCHEMA.split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^--/.test(s.replace(/\n/g, " ").trim()))
  for (const stmt of statements) {
    try {
      await pool.query(stmt)
    } catch (err) {
      warnOnce(
        `[memory] schema statement skipped (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
}

async function openSqlite(cfg: MemoryConfig): Promise<MemoryBackend> {
  let Database: any
  try {
    const mod: any = await import("better-sqlite3")
    Database = mod.default ?? mod
  } catch {
    warnOnce(
      "[memory] memory disabled: better-sqlite3 failed to load (native module). " +
        "Run `npm rebuild better-sqlite3` or set MEMORY_BACKEND=none to silence.",
    )
    return NONE_BACKEND
  }
  try {
    mkdirSync(dirname(cfg.sqlitePath), { recursive: true })
    const db = new Database(cfg.sqlitePath)
    try {
      db.pragma("journal_mode = WAL")
    } catch {
      /* pragma best-effort */
    }
    await applySqliteSchema(db)
    return new SqliteBackend(db, cfg, getEmbedder(cfg.embeddings))
  } catch (err) {
    warnOnce(
      `[memory] memory disabled: failed to open sqlite db at ${cfg.sqlitePath} ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        "Set MEMORY_BACKEND=none to silence.",
    )
    return NONE_BACKEND
  }
}

async function openPostgres(cfg: MemoryConfig): Promise<MemoryBackend> {
  const url = resolvePostgresUrl(cfg)
  if (!url) {
    warnOnce(
      "[memory] memory disabled: backend=postgres but no connection URL " +
        "(set MEMORY_POSTGRES_URL / CONTINUOUS_CODE_DB_URL, or memory.json.postgresUrl). " +
        "Set MEMORY_BACKEND=none to silence.",
    )
    return NONE_BACKEND
  }
  let Pg: any
  try {
    Pg = await import("pg")
  } catch {
    warnOnce(
      "[memory] memory disabled: pg failed to load. " +
        "Run `npm install pg` or set MEMORY_BACKEND=none to silence.",
    )
    return NONE_BACKEND
  }
  try {
    const PoolCtor = Pg.Pool ?? Pg.default?.Pool
    const pool = new PoolCtor({ connectionString: url })
    // Probe the connection before declaring success.
    const client = await pool.connect()
    client.release()
    await applyPostgresSchema(pool)
    return new PostgresBackend(pool, cfg, getEmbedder(cfg.embeddings))
  } catch (err) {
    warnOnce(
      `[memory] memory disabled: failed to connect to postgres ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        "Set MEMORY_BACKEND=none to silence.",
    )
    return NONE_BACKEND
  }
}

/**
 * Returns a process-wide cached backend for the given directory. Selection
 * follows `loadMemoryConfig(directory)`. Any open/connect/load failure is caught
 * and degraded to a NoneBackend (WARN once) — this function NEVER throws.
 */
export function getMemoryBackend(directory: string): Promise<MemoryBackend> {
  const existing = cache.get(directory)
  if (existing) return existing

  const promise = (async (): Promise<MemoryBackend> => {
    try {
      const cfg = loadMemoryConfig(directory)
      switch (cfg.backend) {
        case "none":
          return NONE_BACKEND
        case "postgres":
          return await openPostgres(cfg)
        case "sqlite":
        default:
          return await openSqlite(cfg)
      }
    } catch (err) {
      warnOnce(
        `[memory] memory disabled: unexpected error during init ` +
          `(${err instanceof Error ? err.message : String(err)}). ` +
          "Set MEMORY_BACKEND=none to silence.",
      )
      return NONE_BACKEND
    }
  })()

  cache.set(directory, promise)
  return promise
}

/** Test/installer helper: clear the cache (e.g. after config change). */
export function resetMemoryBackend(): void {
  for (const p of cache.values()) {
    p.then((b) => {
      if (b.kind !== "none") void b.close()
    }).catch(() => {
      /* ignore */
    })
  }
  cache.clear()
  warned.clear()
}
