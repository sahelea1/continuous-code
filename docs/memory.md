# Memory & Recall

Continuous-code provides a persistent, cross-session memory layer that stores learnings from past work and surfaces them automatically in new sessions. All components are zero-config by default: SQLite is the backend, no embeddings are enabled, and everything works without any external services.

**Related docs:** [README](../README.md) · [Architecture](architecture.md) · [Agents](agents.md) · [Install & Config](installation.md)

---

## Table of Contents

- [Backends](#backends)
  - [SQLite (default)](#sqlite-default)
  - [PostgreSQL + pgvector](#postgresql--pgvector)
  - [None](#none)
  - [How to Choose](#how-to-choose)
- [Storing Learnings](#storing-learnings)
- [Recalling Learnings](#recalling-learnings)
  - [memory-recall tool](#memory-recall-tool)
  - [memory-awareness auto-surfacing](#memory-awareness-auto-surfacing)
  - [Recall algorithm](#recall-algorithm)
- [Dedup and Recall Limits](#dedup-and-recall-limits)
- [Embeddings](#embeddings)
  - [Providers](#providers)
  - [The 1024-dim constraint](#the-1024-dim-constraint)
- [Schema Reference](#schema-reference)
  - [archival\_memory (PostgreSQL)](#archival_memory-postgresql)
  - [archival\_memory (SQLite)](#archival_memory-sqlite)
- [PostgreSQL Provisioning](#postgresql-provisioning)
  - [Standalone Docker](#standalone-docker)
  - [Native host postgres](#native-host-postgres)
- [Postgres Isolation from Continuous-Claude-v3](#postgres-isolation-from-continuous-claude-v3)
- [Configuration Reference](#configuration-reference)

---

## Backends

The memory subsystem is built around a `MemoryBackend` interface with three concrete implementations. The active backend is selected at install time and written into `memory.json` in the project directory. The factory function `getMemoryBackend(directory)` is process-wide cached per directory and never throws — any open or connect failure silently degrades to `NoneBackend` with a one-time warning.

### SQLite (default)

Zero-infrastructure. A single file at `~/.config/opencode/continuous/memory.db` (XDG_CONFIG_HOME honored). The schema is applied idempotently on first open. Full-text search uses SQLite FTS5 with BM25 ranking. Embeddings are stored as BLOB (float32 LE) with an `embedding_dim` column. Dedup runs a JS cosine scan over up to 2000 most-recent embedded rows.

**When to use:** Default for most installs. No extra services required.

### PostgreSQL + pgvector

Opt-in. Requires the `pgvector` extension. Full-text search uses `ts_rank` against a GIN-indexed `tsvector` column. Embeddings are stored in a `vector(1024)` column and indexed with HNSW (`m=16`, `ef_construction=64`). Dedup runs a single `ORDER BY embedding <=> $1::vector LIMIT 1` query. Recall uses Reciprocal Rank Fusion (RRF, k=60) to blend FTS and cosine search results when embeddings are active.

**When to use:** When you want vector-powered semantic recall across many learnings, or when a CC-v3 postgres server is already running and you want to reuse it.

### None

Disabled. The `NoneBackend` accepts all calls silently. Use this when you want the plugin installed but no memory persistence — for example, in ephemeral CI environments.

**When to use:** Set `memory.mode: "none"` in `continuous-code.config.jsonc` before install.

### How to Choose

| Scenario | Recommended backend |
|---|---|
| First install, no external services | `sqlite` (default) |
| You already run CC-v3 with postgres | `sqlite` (CC-v3 server auto-reused in isolated db — see [below](#postgres-isolation-from-continuous-claude-v3)) |
| You want semantic (vector) recall | `postgres` with `embeddings.provider: "voyage"` |
| Ephemeral / CI environment | `none` |

---

## Storing Learnings

Learnings are stored via the `memory_store` tool, which is exposed to all agents. The `memory-extractor` agent also calls it directly after scanning session JSONL files for perception-change signals.

The tool accepts the following fields:

| Field | Type | Description |
|---|---|---|
| `content` | string | The learning text (required) |
| `type` | string | Learning type — see table below |
| `context` | string | What situation the learning relates to |
| `tags` | string[] | Free-form tags for filtering |
| `confidence` | string | `high`, `medium`, or `low` |
| `session_id` | string | Defaults to `"opencode"` |
| `agent_id` | string | Originating agent name |

**Learning types:**

| Type | Use for |
|---|---|
| `WORKING_SOLUTION` | Fixes and solutions that worked |
| `FAILED_APPROACH` | Approaches that did not work (avoid repeating) |
| `ARCHITECTURAL_DECISION` | Design choices and rationale |
| `CODEBASE_PATTERN` | Patterns discovered in a codebase |
| `ERROR_FIX` | How specific errors were resolved |
| `USER_PREFERENCE` | The user's preferred approaches |
| `OPEN_THREAD` | Incomplete work to resume later |

If embeddings are configured, a vector is computed and attached before insert. If the embedding computation fails (network timeout, missing API key), the row is written with a NULL embedding and text-only recall still works.

---

## Recalling Learnings

### memory-recall tool

The `memory_recall` tool queries the active backend and returns a numbered list of results with learning type and score. Agents call this explicitly when they need to check prior work.

Parameters:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | — | Search query (required) |
| `limit` | integer | 5 | Maximum results to return |
| `text_only` | boolean | false | Force BM25/FTS search, skip vectors |

### memory-awareness auto-surfacing

The `memory-awareness` hook fires on every `chat.message` output event. It runs a text-only recall (limit 3) against the active backend and, if results exist, appends a `MEMORY MATCH` block to the model's reply before it reaches the user. Each match shows up to 200 characters of content with a prompt to call `memory_recall` for the full record.

This means relevant past learnings surface automatically in new sessions without any explicit recall command. The hook is suppressed only when the backend kind is `none` or recall returns empty results.

### Recall algorithm

| Condition | Algorithm |
|---|---|
| Embeddings disabled | BM25 full-text search (SQLite FTS5 / postgres `ts_rank`) |
| Embeddings enabled | Reciprocal Rank Fusion (RRF, k=60) blending BM25 and cosine vector search |

RRF scores are in the range 0.01–0.03 (normal for RRF — low numbers do not indicate low relevance). Pure vector scores are cosine similarity in the range 0.4–0.6.

---

## Dedup and Recall Limits

When embeddings are active, the backend checks for near-duplicates before every insert.

| Setting | Default | Override |
|---|---|---|
| Dedup threshold | `0.85` | `MEMORY_DEDUP_THRESHOLD` env var |
| Recall limit | `5` | `MEMORY_RECALL_LIMIT` env var or `limit` tool param |
| SQLite dedup scan cap | `2000` rows | Hard-coded constant `SQLITE_DEDUP_SCAN_CAP` |

If the best match from the dedup scan exceeds the threshold, the store call returns `skipped: true` with the existing row's `id` and no new row is written. On SQLite the scan is done in JS cosine over BLOBs; on postgres it is a single indexed vector query.

When embeddings are disabled, dedup is skipped entirely (no vectors to compare).

---

## Embeddings

Embeddings are opt-in. The default provider is `none`, which gives fast, reliable text-only recall with no API keys required.

To enable semantic recall, set `memory.embeddings.provider` in `continuous-code.config.jsonc` before running the installer. The installer writes the resolved configuration into `memory.json`.

### Providers

| Provider | Model default | Dimensions | Notes |
|---|---|---|---|
| `none` | — | — | Default. Text-only recall. No keys required. |
| `voyage` | `voyage-3` | 1024 | Requires `VOYAGE_API_KEY`. Compatible with shared postgres `vector(1024)`. |
| `openai` | `text-embedding-3-small` | 1536 | Requires OpenAI API key. **SQLite only** — blocked on shared postgres (dimension mismatch). |
| `ollama` | configurable | configurable | Local Ollama instance. |
| `local` | — | — | Stub for offline BGE embeddings (`extras.localEmbeddings: true`). |

All embedding calls use a 30-second fetch timeout. Failures are non-fatal: the row is stored without a vector and text recall still works.

### The 1024-dim constraint

The postgres schema defines the embedding column as `vector(1024)`. This is fixed at schema creation time. Any provider that produces a different number of dimensions is incompatible with that column.

In practice this means:

- `voyage` (1024-dim) is the only provider compatible with a shared postgres column, including a reused CC-v3 server.
- `openai` (1536-dim) can only be used with SQLite.
- The installer detects and enforces this: if you configure `openai` embeddings against a postgres backend, install.sh warns and resets the provider to `none`.

---

## Schema Reference

The DDL is defined as TypeScript string constants in `src/memory/schema-sql.ts`. The files in `db/` are canonical source-of-truth copies but are not read at runtime. Both schemas are idempotent (`IF NOT EXISTS`) and applied automatically on first backend open.

### archival_memory (PostgreSQL)

Source: `db/schema.sql`

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS archival_memory (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    agent_id   TEXT,
    content    TEXT NOT NULL,
    metadata   JSONB DEFAULT '{}',
    embedding  vector(1024),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

<details>
<summary>Indexes</summary>

```sql
CREATE INDEX IF NOT EXISTS idx_archival_session
    ON archival_memory(session_id);
CREATE INDEX IF NOT EXISTS idx_archival_agent
    ON archival_memory(session_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_archival_created
    ON archival_memory(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_archival_content_fts
    ON archival_memory USING gin(to_tsvector('english', content));
CREATE INDEX IF NOT EXISTS idx_archival_embedding_hnsw
    ON archival_memory USING hnsw(embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
```

</details>

### archival_memory (SQLite)

Source: `db/schema.sqlite.sql`

```sql
CREATE TABLE IF NOT EXISTS archival_memory (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    agent_id      TEXT,
    content       TEXT NOT NULL,
    metadata_json TEXT DEFAULT '{}',
    embedding     BLOB,
    embedding_dim INTEGER,
    created_at    INTEGER NOT NULL   -- unix epoch seconds
);
```

<details>
<summary>FTS5 virtual table and sync triggers</summary>

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS archival_fts USING fts5(
    content,
    content='archival_memory',
    content_rowid='rowid'
);

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
```

</details>

Column differences between postgres and SQLite:

| Column | PostgreSQL | SQLite |
|---|---|---|
| `id` | `UUID` | `TEXT` (UUID v4 string, generated app-side) |
| `metadata` | `JSONB` | `metadata_json TEXT` (JSON string) |
| `embedding` | `vector(1024)` | `BLOB` (float32 LE) + `embedding_dim INTEGER` |
| `created_at` | `TIMESTAMPTZ` | `INTEGER` (unix epoch seconds) |

---

## PostgreSQL Provisioning

Use `memory.postgres.provision` in `continuous-code.config.jsonc` to tell the installer how to obtain a postgres instance.

| Value | What install.sh does |
|---|---|
| `"docker"` | Brings up `db/docker-compose.yml` (pgvector/pgvector:pg16) |
| `"native"` | Uses a postgres already on the host (psql must be on PATH) |
| `"skip"` | Does not provision; uses `memory.postgres.url` verbatim |

### Standalone Docker

`db/docker-compose.yml` spins up a standalone pgvector container with these defaults:

| Setting | Default |
|---|---|
| Image | `pgvector/pgvector:pg16` |
| Container name | `continuous-code-postgres` |
| Host port | `5433` |
| Database | `continuous_code` |
| User | `continuous` |
| Password | `continuous_dev` |

Port 5433 (not 5432) is intentional — it avoids clashing with a CC-v3 postgres that may be running on 5432.

`db/schema.sql` is mounted into `docker-entrypoint-initdb.d` so it is applied on first cluster init. The backend also re-applies it idempotently on every first open, so a reused or pre-existing database is fine.

### Native host postgres

Set `provision: "native"` and ensure `psql` is on PATH. The installer derives the connection string from the other `memory.postgres.*` settings. Alternatively, set `memory.postgres.url` to an explicit connection string and set `provision: "skip"`.

---

## Postgres Isolation from Continuous-Claude-v3

> This section covers an important behavior for anyone who also runs Continuous-Claude-v3 (CC-v3).

**The short version:** continuous-code reuses the CC-v3 postgres *server* when detected, but always in its own isolated database. The two installs share only the server process and never share tables, rows, or schemas.

### What happens by default

If the CC-v3 postgres container (`continuous-claude-postgres`) is detected running on port 5432, the installer (with `reuseExistingCcV3: true`, the default) automatically promotes the memory backend from sqlite to postgres. It connects to that server and creates — if it does not already exist — the database `continuous_code`. All continuous-code memory operations go to `continuous_code`.

CC-v3's own database is `continuous_claude`. continuous-code never reads from or writes to `continuous_claude`. The two databases have completely separate `archival_memory` tables, sessions, file claims, and handoffs. Both installs run simultaneously without interfering with each other.

### Database isolation at a glance

| | Continuous-Claude-v3 | Continuous-code |
|---|---|---|
| Server / container | `continuous-claude-postgres` on :5432 | reused (shared server process) |
| Database | `continuous_claude` | `continuous_code` |
| `archival_memory` table | CC-v3's own rows | completely separate |
| Sessions / file_claims | CC-v3's own data | completely separate |

### Opting out

If you want continuous-code to use a completely standalone postgres or stay on sqlite regardless of whether CC-v3 is running, set one of the following in `continuous-code.config.jsonc`:

```jsonc
// Option A — never reuse CC-v3, fall back to whatever memory.mode says
"reuseExistingCcV3": false

// Option B — force standalone provisioning for everything
"forceStandalone": true

// Option C — an explicit URL always wins over detection
"memory": {
  "postgres": {
    "url": "postgresql://user:pw@host:5433/continuous_code"
  }
}
```

`forceStandalone: true` is the strongest option: it prevents reuse of the CC-v3 server AND prevents any other CC-v3 dependency (such as the `tldr` CLI that CC-v3 may have installed).

---

## Configuration Reference

All keys live in `continuous-code.config.jsonc` (pre-install) and are translated by the installer into `memory.json` and `.env` (runtime). The plugin never reads `continuous-code.config.jsonc` directly.

### memory.json keys

| Key | Type | Default | Description |
|---|---|---|---|
| `backend` | string | `"sqlite"` | Active backend: `sqlite`, `postgres`, or `none` |
| `sqlitePath` | string | `~/.config/opencode/continuous/memory.db` | SQLite database file path |
| `postgresUrl` | string | — | PostgreSQL connection string |
| `dedupThreshold` | float | `0.85` | Cosine similarity above which a new store is skipped as a duplicate |
| `recallLimit` | integer | `5` | Default maximum number of recall results |
| `embeddings.provider` | string | `"none"` | Embedding provider: `none`, `voyage`, `openai`, `ollama`, `local` |
| `embeddings.model` | string | provider default | Model override (e.g. `voyage-3`) |
| `embeddings.apiKeyEnv` | string | provider default | Name of the env var holding the API key |
| `embeddings.baseURL` | string | — | Custom base URL for the embedding endpoint |
| `embeddings.dimension` | integer | provider default | Embedding dimension override |

### Environment variable overrides

| Variable | Description |
|---|---|
| `MEMORY_BACKEND` | Override backend: `sqlite`, `postgres`, or `none` |
| `MEMORY_DB_PATH` | Override SQLite file path |
| `MEMORY_POSTGRES_URL` | Highest-priority postgres connection string |
| `CONTINUOUS_CODE_DB_URL` | Second-priority postgres connection string |
| `CONTINUOUS_CLAUDE_DB_URL` | Third-priority (CC-v3 env var; picked up if set) |
| `DATABASE_URL` | Fourth-priority postgres connection string |
| `MEMORY_DEDUP_THRESHOLD` | Override dedup threshold (float) |
| `MEMORY_RECALL_LIMIT` | Override default recall limit (integer) |
| `MEMORY_EMBEDDINGS` | Override embedding provider |
| `MEMORY_EMBEDDINGS_MODEL` | Override embedding model |

### Pre-install config keys (continuous-code.config.jsonc)

| Key | Default | Description |
|---|---|---|
| `memory.mode` | `"sqlite"` | Backend to provision: `sqlite`, `postgres`, `none` |
| `memory.sqlite.path` | `~/.config/opencode/continuous/memory.db` | SQLite file location |
| `memory.postgres.provision` | `"docker"` | How to obtain postgres: `docker`, `native`, `skip` |
| `memory.postgres.dbName` | `"continuous_code"` | Database name for standalone postgres |
| `memory.postgres.port` | `5433` | Host port for standalone docker postgres |
| `memory.postgres.url` | `""` | Explicit connection string; wins over all detection |
| `memory.embeddings.provider` | `"none"` | Embedding provider |
| `memory.embeddings.model` | `""` | Model override |
| `memory.embeddings.apiKeyEnv` | `"VOYAGE_API_KEY"` | API key env var name |
| `reuseExistingCcV3` | `true` | Reuse CC-v3 postgres server in isolated `continuous_code` db |
| `forceStandalone` | `false` | Never reuse CC-v3; guarantee standalone memory |
