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
CREATE INDEX IF NOT EXISTS idx_moments_tasks_state_due ON moments_tasks(state, due_at);
CREATE INDEX IF NOT EXISTS idx_moments_tasks_state_updated ON moments_tasks(state, updated_at);
CREATE TABLE IF NOT EXISTS moments_sync_receipts (
  receipt_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, post_id TEXT, char_id TEXT, state TEXT NOT NULL,
  payload_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS moments_diagnostics (
  id TEXT PRIMARY KEY, user_id TEXT, level TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL,
  detail_json TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS moments_deliveries (
  delivery_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, acknowledged_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_moments_deliveries_user_time ON moments_deliveries(user_id, acknowledged_at, created_at);
CREATE TABLE IF NOT EXISTS moments_actor_runtime (
  user_id TEXT NOT NULL, actor_id TEXT NOT NULL, actor_type TEXT NOT NULL, char_id TEXT, parent_char_id TEXT,
  display_name TEXT NOT NULL, avatar TEXT, bio TEXT, posting_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL,
  auto_interaction_enabled INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 0,
  timezone_id TEXT NOT NULL DEFAULT '', timezone_offset_minutes INTEGER NOT NULL DEFAULT 0, credential_id TEXT NOT NULL,
  pack_encrypted TEXT NOT NULL, next_decision_at INTEGER NOT NULL DEFAULT 0,
  last_decision_at INTEGER, last_post_at INTEGER, failure_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_moments_actor_due ON moments_actor_runtime(enabled, next_decision_at);
CREATE INDEX IF NOT EXISTS idx_moments_actor_user_interaction ON moments_actor_runtime(user_id, interaction_mode);
CREATE TABLE IF NOT EXISTS moments_generated_posts (
  post_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, author_id TEXT NOT NULL,
  payload_encrypted TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_moments_generated_author_time ON moments_generated_posts(user_id, author_id, created_at);
