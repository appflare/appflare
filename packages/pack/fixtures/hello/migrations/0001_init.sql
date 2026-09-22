CREATE TABLE links (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
