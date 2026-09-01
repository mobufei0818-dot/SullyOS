/**
 * SullyOS 朋友圈阶段 4 Worker 路由模块
 *
 * 这是朋友圈独立的数据同步/任务队列，挂载到现有主动消息 2.0 Worker 的 /moments/* 路由。
 * 它不修改主动消息 2.0 的原始表、任务和生成流程；只在同一个 DB 上创建 moments_* 表。
 * 副 API 规划仍在前端完成一次；Worker 只保存结构化事件、幂等任务和诊断。
 * 到点后 Worker 把“已预写”的任务转换为投递事件并尽力发出一条通用推送；页面下次打开时拉回落地。
 * 因此 Worker 不需要保存朋友圈副 API Key，也不会代替角色临时生成新内容。
 */
import { createWebCryptoWebPush, decryptFromStorage, deriveUserEncryptionKey } from '@rei-standard/amsg-server/cloudflare';

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
  exec(query: string): Promise<unknown>;
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<{ meta?: { changes?: number } }>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

interface Env {
  DB: D1Database;
  /** 兼容独立预览部署；当前正式挂载时优先复用 AMSG_SERVER_TOKEN。 */
  MOMENTS_TOKEN?: string;
  AMSG_SERVER_TOKEN?: string;
  AMSG_MASTER_KEY?: string;
  VAPID_EMAIL?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Moments-Token,X-Client-Token',
  'Access-Control-Max-Age': '86400',
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...cors } });
const now = () => Date.now();
const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const asString = (value: unknown, fallback = '') => typeof value === 'string' ? value.trim() : fallback;
const asNumber = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safeJson = (value: unknown) => JSON.stringify(value ?? {});

let schemaReady = false;
async function ensureSchema(db: D1Database) {
  if (schemaReady) return;
  // D1 的 exec 在部分运行时只接受一条 statement；把 schema 拆开执行，
  // 否则会在第一条 CREATE TABLE 的末尾报 "incomplete input"，并令每一次
  // /moments 请求都失败、前端不断重试。
  const statements = [
    `CREATE TABLE IF NOT EXISTS moments_relationship_events (
      event_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, char_id TEXT, post_id TEXT, event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL, visibility_json TEXT, thread_version INTEGER NOT NULL DEFAULT 1,
      idempotency_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_moments_events_user_time ON moments_relationship_events(user_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS moments_tasks (
      task_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, char_id TEXT, post_id TEXT, task_type TEXT NOT NULL,
      due_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', payload_json TEXT NOT NULL,
      thread_version INTEGER NOT NULL DEFAULT 1, idempotency_key TEXT NOT NULL UNIQUE,
      attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_moments_tasks_due ON moments_tasks(user_id, state, due_at)`,
    `CREATE TABLE IF NOT EXISTS moments_sync_receipts (
      receipt_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, post_id TEXT, char_id TEXT, state TEXT NOT NULL,
      payload_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS moments_diagnostics (
      id TEXT PRIMARY KEY, user_id TEXT, level TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL,
      detail_json TEXT, created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS moments_deliveries (
      delivery_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, acknowledged_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_moments_deliveries_user_time ON moments_deliveries(user_id, acknowledged_at, created_at)`,
  ];
  for (const statement of statements) await db.prepare(statement).run();
  schemaReady = true;
}

function authorized(request: Request, env: Env) {
  // 正式挂载到 AMSG Worker 时沿用已有共享密钥，不需要在朋友圈再复制一份。
  // 保留 MOMENTS_TOKEN 仅为旧的独立本地预览兼容；若两者同时存在，显式朋友圈令牌优先。
  const expected = env.MOMENTS_TOKEN?.trim() || env.AMSG_SERVER_TOKEN?.trim();
  if (!expected) return true;
  return request.headers.get('X-Client-Token') === expected || request.headers.get('X-Moments-Token') === expected;
}

async function writeDiagnostic(db: D1Database, userId: string | null, level: string, code: string, message: string, detail?: unknown) {
  await db.prepare(`INSERT INTO moments_diagnostics (id,user_id,level,code,message,detail_json,created_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(id(), userId, level, code, message.slice(0, 500), safeJson(detail), now()).run();
}

async function sync(request: Request, env: Env) {
  const body = object(await request.json().catch(() => ({})));
  const userId = asString(body.userId);
  if (!userId) return json({ error: 'userId is required' }, 400);
  const events = Array.isArray(body.events) ? body.events.slice(0, 200) : [];
  const tasks = Array.isArray(body.tasks) ? body.tasks.slice(0, 200) : [];
  const receipts = Array.isArray(body.receipts) ? body.receipts.slice(0, 200) : [];
  let accepted = 0;
  const acceptedEventIds: string[] = [];
  const acceptedTaskIds: string[] = [];
  for (const raw of events) {
    const row = object(raw);
    const eventId = asString(row.id) || id();
    const payload = object(row.payload);
    const result = await env.DB.prepare(`INSERT OR IGNORE INTO moments_relationship_events (event_id,user_id,char_id,post_id,event_type,payload_json,visibility_json,thread_version,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(eventId, userId, asString(payload.charId) || null, asString(payload.postId) || null, asString(row.type, 'event'), safeJson(payload), safeJson(payload.visibleToActorIds || []), asNumber(payload.threadVersion, 1), `event:${eventId}`, asNumber(row.createdAt, now())).run();
    accepted += result.meta?.changes || 0;
    // INSERT OR IGNORE 命中既有幂等事件也算“已安全接收”，前端才能只删除本批确认的 outbox。
    acceptedEventIds.push(eventId);
    // 收到本地删帖 tombstone 后，立即撤销这条动态还没执行的远端互动任务。
    // 事件本身保留，供其他设备下次同步时也能看到删除事实，不能用物理删除替代。
    if (asString(row.type) === 'delete' && asString(payload.postId)) {
      await env.DB.prepare(`UPDATE moments_tasks SET state='cancelled', updated_at=? WHERE user_id=? AND post_id=? AND state IN ('pending','running')`)
        .bind(now(), userId, asString(payload.postId)).run();
    }
  }
  for (const raw of tasks) {
    const row = object(raw);
    const taskId = asString(row.id) || id();
    const payload = object(row.payload || row);
    const idem = asString(row.idempotencyKey) || `task:${taskId}`;
    const result = await env.DB.prepare(`INSERT INTO moments_tasks (task_id,user_id,char_id,post_id,task_type,due_at,state,payload_json,thread_version,idempotency_key,attempts,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,NULL,?,?) ON CONFLICT(idempotency_key) DO UPDATE SET due_at=CASE WHEN moments_tasks.state IN ('done','cancelled') AND excluded.state != 'cancelled' THEN moments_tasks.due_at ELSE excluded.due_at END,state=CASE WHEN moments_tasks.state IN ('done','cancelled') AND excluded.state != 'cancelled' THEN moments_tasks.state WHEN moments_tasks.state='running' AND excluded.state='pending' THEN 'running' WHEN excluded.updated_at < moments_tasks.updated_at THEN moments_tasks.state ELSE excluded.state END,payload_json=CASE WHEN moments_tasks.state IN ('done','cancelled') AND excluded.state != 'cancelled' THEN moments_tasks.payload_json WHEN moments_tasks.state='running' AND excluded.state='pending' THEN moments_tasks.payload_json WHEN excluded.updated_at < moments_tasks.updated_at THEN moments_tasks.payload_json ELSE excluded.payload_json END,thread_version=CASE WHEN excluded.updated_at < moments_tasks.updated_at THEN moments_tasks.thread_version ELSE excluded.thread_version END,error=CASE WHEN excluded.updated_at < moments_tasks.updated_at THEN moments_tasks.error ELSE excluded.error END,updated_at=MAX(moments_tasks.updated_at,excluded.updated_at)`)
      .bind(taskId, userId, asString(row.actorId) || asString(payload.actorId) || null, asString(row.postId) || asString(payload.postId) || null, asString(row.type, 'interaction'), asNumber(row.dueAt, now()), asString(row.state, 'pending'), safeJson(payload), asNumber(row.threadVersion, 1), idem, asNumber(row.createdAt, now()), now()).run();
    accepted += result.meta?.changes || 0;
    acceptedTaskIds.push(taskId);
  }
  for (const raw of receipts) {
    const row = object(raw);
    const receiptId = asString(row.id) || id();
    await env.DB.prepare(`INSERT INTO moments_sync_receipts (receipt_id,user_id,post_id,char_id,state,payload_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(receipt_id) DO UPDATE SET state=excluded.state,payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
      .bind(receiptId, userId, asString(row.postId) || null, asString(row.charId) || null, asString(row.state, 'received'), safeJson(row), asNumber(row.createdAt, now()), now()).run();
  }
  return json({ ok: true, accepted, acceptedEventIds, acceptedTaskIds, events: events.length, tasks: tasks.length, receipts: receipts.length });
}

async function listTasks(url: URL, env: Env) {
  const userId = url.searchParams.get('userId')?.trim();
  if (!userId) return json({ error: 'userId is required' }, 400);
  const before = asNumber(url.searchParams.get('dueBefore'), now());
  const rows = await env.DB.prepare(`SELECT task_id AS id,user_id AS userId,char_id AS actorId,post_id AS postId,task_type AS type,due_at AS dueAt,state,payload_json AS payload,thread_version AS threadVersion,attempts,error,created_at AS createdAt,updated_at AS updatedAt FROM moments_tasks WHERE user_id = ? AND state IN ('pending','running') AND due_at <= ? ORDER BY due_at ASC LIMIT 200`).bind(userId, before).all<any>();
  return json({ tasks: (rows.results || []).map(row => ({ ...row, payload: (() => { try { return JSON.parse(row.payload || '{}'); } catch { return {}; } })() })) });
}

async function claimTask(request: Request, env: Env) {
  const body = object(await request.json().catch(() => ({})));
  const userId = asString(body.userId); const taskId = asString(body.taskId);
  if (!userId || !taskId) return json({ error: 'userId and taskId are required' }, 400);
  const result = await env.DB.prepare(`UPDATE moments_tasks SET state='running',attempts=attempts+1,updated_at=? WHERE task_id=? AND user_id=? AND state='pending' AND due_at<=?`).bind(now(), taskId, userId, now()).run();
  if (!(result.meta?.changes || 0)) return json({ claimed: false, reason: 'not-pending-or-not-due' }, 409);
  const row = await env.DB.prepare(`SELECT task_id AS id,user_id AS userId,char_id AS actorId,post_id AS postId,task_type AS type,due_at AS dueAt,state,payload_json AS payload,thread_version AS threadVersion,attempts,error,created_at AS createdAt,updated_at AS updatedAt FROM moments_tasks WHERE task_id=?`).bind(taskId).first<any>();
  if (row) { try { row.payload = JSON.parse(row.payload || '{}'); } catch { row.payload = {}; } }
  return json({ claimed: true, task: row });
}

async function completeTask(request: Request, env: Env) {
  const body = object(await request.json().catch(() => ({})));
  const userId = asString(body.userId); const taskId = asString(body.taskId);
  const state = asString(body.state);
  if (!userId || !taskId || !['done', 'failed', 'cancelled', 'pending'].includes(state)) return json({ error: 'userId, taskId and valid state are required' }, 400);
  const result = await env.DB.prepare(`UPDATE moments_tasks SET state=?,error=?,updated_at=? WHERE task_id=? AND user_id=?`).bind(state, asString(body.error) || null, now(), taskId, userId).run();
  return json({ ok: true, updated: Boolean(result.meta?.changes) });
}

async function diagnostics(url: URL, env: Env) {
  const userId = url.searchParams.get('userId')?.trim() || null;
  const counts = await env.DB.prepare(`SELECT state,COUNT(*) AS count FROM moments_tasks ${userId ? 'WHERE user_id=?' : ''} GROUP BY state`).bind(...(userId ? [userId] : [])).all<{ state: string; count: number }>();
  const recent = await env.DB.prepare(`SELECT level,code,message,created_at AS createdAt FROM moments_diagnostics ${userId ? 'WHERE user_id=? OR user_id IS NULL' : ''} ORDER BY created_at DESC LIMIT 20`).bind(...(userId ? [userId] : [])).all<any>();
  return json({ ok: true, counts: counts.results || [], diagnostics: recent.results || [] });
}

async function listDeliveries(url: URL, env: Env) {
  const userId = url.searchParams.get('userId')?.trim();
  if (!userId) return json({ error: 'userId is required' }, 400);
  const rows = await env.DB.prepare(`SELECT delivery_id AS id,task_id AS taskId,payload_json AS payload,created_at AS createdAt FROM moments_deliveries WHERE user_id=? AND acknowledged_at IS NULL ORDER BY created_at ASC LIMIT 200`).bind(userId).all<any>();
  return json({ deliveries: (rows.results || []).map(row => ({ ...row, payload: (() => { try { return JSON.parse(row.payload || '{}'); } catch { return {}; } })() })) });
}

async function acknowledgeDeliveries(request: Request, env: Env) {
  const body = object(await request.json().catch(() => ({})));
  const userId = asString(body.userId);
  const ids = Array.isArray(body.deliveryIds) ? body.deliveryIds.filter((value): value is string => typeof value === 'string').slice(0, 200) : [];
  if (!userId || !ids.length) return json({ error: 'userId and deliveryIds are required' }, 400);
  await env.DB.batch(ids.map(deliveryId => env.DB.prepare(`UPDATE moments_deliveries SET acknowledged_at=? WHERE delivery_id=? AND user_id=?`).bind(now(), deliveryId, userId)));
  return json({ ok: true, acknowledged: ids.length });
}

async function notifyMomentsDelivery(env: Env, userId: string, payload: Record<string, unknown>) {
  if (!env.AMSG_MASTER_KEY || !env.VAPID_PUBLIC_KEY?.trim() || !env.VAPID_PRIVATE_KEY?.trim()) return;
  try {
    const row = await env.DB.prepare(`SELECT subscription FROM push_subscriptions WHERE user_id=? LIMIT 1`).bind(userId).first<{ subscription?: string }>();
    if (!row?.subscription) return;
    let subscription: unknown;
    try {
      const userKey = await deriveUserEncryptionKey(userId, env.AMSG_MASTER_KEY);
      subscription = JSON.parse(await decryptFromStorage(row.subscription, userKey));
    } catch { subscription = JSON.parse(row.subscription); }
    const actorName = asString(payload.actorName, '一位朋友');
    const kind = asString(payload.kind);
    const sender = createWebCryptoWebPush({ email: env.VAPID_EMAIL?.trim() || 'mailto:noreply@sullyos.app', publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY });
    await sender.sendNotification(subscription as any, JSON.stringify({
      messageKind: 'moments', messageId: `moments_${asString(payload.sourceId) || id()}`, timestamp: new Date().toISOString(),
      metadata: { momentsDelivery: true, taskId: asString(payload.taskId), postId: asString(payload.postId) },
      notification: { title: '朋友圈有新动态', body: kind === 'comment' ? `${actorName} 评论了朋友圈` : `${actorName} 有新的朋友圈互动`, tag: 'sullyos-moments', silent: false },
    }));
  } catch (error: any) {
    await writeDiagnostic(env.DB, userId, 'warn', 'moments_push_failed', error?.message || 'push failed');
  }
}

export default {
  async fetch(request: Request, env: Env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401);
    try {
      await ensureSchema(env.DB);
      const url = new URL(request.url); const path = url.pathname.replace(/\/+$/, '') || '/';
      if (request.method === 'GET' && path.endsWith('/health')) return json({ ok: true, service: 'sullyos-moments', schema: 1, now: now() });
      if (request.method === 'POST' && path.endsWith('/sync')) return await sync(request, env);
      if (request.method === 'GET' && path.endsWith('/tasks')) return await listTasks(url, env);
      if (request.method === 'GET' && path.endsWith('/deliveries')) return await listDeliveries(url, env);
      if (request.method === 'POST' && path.endsWith('/deliveries/ack')) return await acknowledgeDeliveries(request, env);
      if (request.method === 'POST' && path.endsWith('/tasks/claim')) return await claimTask(request, env);
      if (request.method === 'POST' && path.endsWith('/tasks/complete')) return await completeTask(request, env);
      if (request.method === 'GET' && path.endsWith('/diagnostics')) return await diagnostics(url, env);
      return json({ error: 'Not found' }, 404);
    } catch (error: any) {
      try { await writeDiagnostic(env.DB, null, 'error', 'request_failed', error?.message || 'request failed'); } catch { /* avoid masking original error */ }
      return json({ error: error?.message || 'Worker request failed' }, 500);
    }
  },
  async scheduled(_event: any, env: Env) {
    await ensureSchema(env.DB);
    // 真实离线投递：任务正文已在前台规划完成；到点后不调副 API，直接转成可拉取的事实事件。
    const due = await env.DB.prepare(`SELECT task_id AS id,user_id AS userId,char_id AS actorId,post_id AS postId,task_type AS type,payload_json AS payload FROM moments_tasks WHERE state='pending' AND due_at<=? ORDER BY due_at ASC LIMIT 100`).bind(now()).all<any>();
    for (const task of due.results || []) {
      let payload = object((() => { try { return JSON.parse(task.payload || '{}'); } catch { return {}; } })());
      payload = { ...payload, taskId: task.id, taskType: task.type, postId: task.postId, actorId: task.actorId, __workerDelivered: true };
      const deliveryId = `moments-delivery-${task.id}`;
      const claimed = await env.DB.prepare(`UPDATE moments_tasks SET state='done',updated_at=? WHERE task_id=? AND state='pending'`).bind(now(), task.id).run();
      if (!(claimed.meta?.changes || 0)) continue;
      await env.DB.prepare(`INSERT OR IGNORE INTO moments_deliveries (delivery_id,user_id,task_id,payload_json,created_at,acknowledged_at) VALUES (?,?,?,?,?,NULL)`).bind(deliveryId, task.userId, task.id, safeJson(payload), now()).run();
      await notifyMomentsDelivery(env, task.userId, payload);
    }
    const cutoff = now() - 10 * 60_000;
    const result = await env.DB.prepare(`UPDATE moments_tasks SET state='pending',error='Worker recovered a stale running task',updated_at=? WHERE state='running' AND updated_at<?`).bind(now(), cutoff).run();
    if (result.meta?.changes) await writeDiagnostic(env.DB, null, 'info', 'stale_tasks_requeued', `requeued ${result.meta.changes} stale task(s)`);
  },
};
