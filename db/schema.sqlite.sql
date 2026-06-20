-- Memory subsystem — SQLite schema (FTS5). Idempotent.
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
