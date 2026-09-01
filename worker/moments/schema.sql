-- SullyOS 朋友圈阶段 4 Worker / D1 schema
-- Worker 启动时会自动 CREATE IF NOT EXISTS；本文件用于手动预建和排障。
CREATE TABLE IF NOT EXISTS moments_relationship_events (
  event_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, char_id TEXT, post_id TEXT, event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL, visibility_json TEXT, thread_version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moments_events_user_time ON moments_relationship_events(user_id, created_at);
CREATE TABLE IF NOT EXISTS moments_tasks (
  task_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, char_id TEXT, post_id TEXT, task_type TEXT NOT NULL,
  due_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', payload_json TEXT NOT NULL,
  thread_version INTEGER NOT NULL DEFAULT 1, idempotency_key TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moments_tasks_due ON moments_tasks(user_id, state, due_at);
CREATE TABLE IF NOT EXISTS moments_sync_receipts (
  receipt_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, post_id TEXT, char_id TEXT, state TEXT NOT NULL,
  payload_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS moments_diagnostics (
  id TEXT PRIMARY KEY, user_id TEXT, level TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL,
  detail_json TEXT, created_at INTEGER NOT NULL
);
