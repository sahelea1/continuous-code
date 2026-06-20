/**
 * Canonical schema DDL as TS string constants.
 *
 * These MUST be byte-identical to `db/schema.sql` and `db/schema.sqlite.sql`
 * (reconciliation R3). `backend.ts` applies the schema from THESE constants at
 * runtime — never by reading the `.sql` files (which are the source-of-truth
 * copies that ship via `package.json files[]`). Keeping the DDL inline avoids
 * runtime path resolution under `dist/` and keeps the build `tsc`-only (R9).
 *
 * Pure data only — no imports.
 */

/** PostgreSQL (pgvector) schema. Idempotent. Byte-identical to db/schema.sql. */
export const POSTGRES_SCHEMA = `-- Memory subsystem — PostgreSQL schema (pgvector). Idempotent.
-- Compatible with Continuous-Claude-v3 archival_memory.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS archival_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    agent_id TEXT,
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',
    embedding vector(1024),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_archival_session ON archival_memory(session_id);
CREATE INDEX IF NOT EXISTS idx_archival_agent ON archival_memory(session_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_archival_created ON archival_memory(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_archival_content_fts ON archival_memory
    USING gin(to_tsvector('english', content));
-- HNSW vector index only created when embeddings are in use; safe to create now (empty col allowed).
CREATE INDEX IF NOT EXISTS idx_archival_embedding_hnsw ON archival_memory
    USING hnsw(embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
`

/** SQLite (FTS5) schema. Idempotent. Byte-identical to db/schema.sqlite.sql. */
export const SQLITE_SCHEMA = `-- Memory subsystem — SQLite schema (FTS5). Idempotent.
CREATE TABLE IF NOT EXISTS archival_memory (
    id            TEXT PRIMARY KEY,            -- UUID v4 string (generated app-side)
    session_id    TEXT NOT NULL,
    agent_id      TEXT,
    content       TEXT NOT NULL,
    metadata_json TEXT DEFAULT '{}',           -- JSON string (mirrors pg metadata jsonb)
    embedding     BLOB,                         -- float32 LE, nullable
    embedding_dim INTEGER,                      -- length of embedding, nullable
    created_at    INTEGER NOT NULL              -- unix epoch seconds
);

CREATE INDEX IF NOT EXISTS idx_archival_session ON archival_memory(session_id);
CREATE INDEX IF NOT EXISTS idx_archival_created ON archival_memory(created_at DESC);

-- FTS5 external-content index over content (BM25 ranking).
CREATE VIRTUAL TABLE IF NOT EXISTS archival_fts USING fts5(
    content,
    content='archival_memory',
    content_rowid='rowid'
);

-- Keep FTS in sync with the base table.
CREATE TRIGGER IF NOT EXISTS archival_ai AFTER INSERT ON archival_memory BEGIN
    INSERT INTO archival_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS archival_ad AFTER DELETE ON archival_memory BEGIN
    INSERT INTO archival_fts(archival_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS archival_au AFTER UPDATE ON archival_memory BEGIN
    INSERT INTO archival_fts(archival_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO archival_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`
