/**
 * SullyOS 朋友圈阶段 4 Worker 路由模块
 *
 * 这是朋友圈独立的数据同步/任务队列，挂载到现有主动消息 2.0 Worker 的 /moments/* 路由。
 * 它不修改主动消息 2.0 的原始表、任务和生成流程；只在同一个 DB 上创建 moments_* 表。
 * 前端仍负责把角色资料、聊天关系与朋友圈设置同步成最小快照；真正的发帖判断、
 * 新正文生成和一帖一次的统一互动规划可在 Worker 内完成。凭据复用主动消息 2.0 的
 * llm_credentials 加密表，朋友圈任务只保存 credId，不复制明文 Key。
 */
import { createWebCryptoWebPush, decryptFromStorage, deriveUserEncryptionKey, encryptForStorage } from '@rei-standard/amsg-server/cloudflare';
import { unpackStateValue } from '../../../utils/amsgFirePack';

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
const asBoolean = (value: unknown, fallback = false) => typeof value === 'boolean' ? value : fallback;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safeJson = (value: unknown) => JSON.stringify(value ?? {});
const stableHash = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
};

const postingModeEnabled = (mode: string) => mode === 'low' || mode === 'medium' || mode === 'high';
type MomentsTimeZone = string | number;

const validTimeZone = (timeZone: string) => {
  if (!timeZone) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0); return true; }
  catch { return false; }
};

const zonedParts = (timestamp: number, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const values: Record<string, string> = {};
  for (const part of parts) values[part.type] = part.value;
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour) % 24, minute: Number(values.minute), second: Number(values.second),
  };
};

const dateKeyAtTimeZone = (timestamp: number, timeZone: MomentsTimeZone) => {
  if (typeof timeZone === 'string' && validTimeZone(timeZone)) {
    const parts = zonedParts(timestamp, timeZone);
    return `${parts.year}-${padClock(parts.month)}-${padClock(parts.day)}`;
  }
  const offsetMinutes = typeof timeZone === 'number' ? timeZone : 0;
  const shifted = new Date(timestamp + offsetMinutes * 60_000);
  return `${shifted.getUTCFullYear()}-${padClock(shifted.getUTCMonth() + 1)}-${padClock(shifted.getUTCDate())}`;
};
const localDayStartUtc = (timestamp: number, offsetMinutes: number) => {
  const shifted = new Date(timestamp + offsetMinutes * 60_000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offsetMinutes * 60_000;
};

const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const padClock = (value: number) => String(value).padStart(2, '0');

/** 把前端同步的设备时区转成模型可直接理解的唯一墙钟时间锚点。 */
export const describeMomentsLocalTime = (timestamp: number, timeZone: MomentsTimeZone) => {
  if (typeof timeZone === 'string' && validTimeZone(timeZone)) {
    const parts = zonedParts(timestamp, timeZone);
    const localDate = `${parts.year}-${padClock(parts.month)}-${padClock(parts.day)}`;
    const localClock = `${padClock(parts.hour)}:${padClock(parts.minute)}:${padClock(parts.second)}`;
    return {
      epochMs: timestamp, localDate, localClock, localDateTime: `${localDate} ${localClock}`,
      weekday: WEEKDAY_NAMES[new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()],
      timezone: timeZone, minuteOfDay: parts.hour * 60 + parts.minute,
    };
  }
  const offsetMinutes = typeof timeZone === 'number' ? timeZone : 0;
  const safeOffset = Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(offsetMinutes || 0)));
  const shifted = new Date(timestamp + safeOffset * 60_000);
  const sign = safeOffset >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(safeOffset);
  const localDate = `${shifted.getUTCFullYear()}-${padClock(shifted.getUTCMonth() + 1)}-${padClock(shifted.getUTCDate())}`;
  const localClock = `${padClock(shifted.getUTCHours())}:${padClock(shifted.getUTCMinutes())}:${padClock(shifted.getUTCSeconds())}`;
  return {
    epochMs: timestamp,
    localDate,
    localClock,
    localDateTime: `${localDate} ${localClock}`,
    weekday: WEEKDAY_NAMES[shifted.getUTCDay()],
    timezone: `UTC${sign}${padClock(Math.floor(absoluteOffset / 60))}:${padClock(absoluteOffset % 60)}`,
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
};

const parseChineseClockNumber = (raw: string) => {
  if (/^\d+$/.test(raw)) return Number(raw);
  const digits: Record<string, number> = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  if (raw === '十') return 10;
  if (raw.includes('十')) {
    const [left, right] = raw.split('十');
    return (left ? digits[left] ?? 0 : 1) * 10 + (right ? digits[right] ?? 0 : 0);
  }
  if (raw.length > 1) return Number(raw.split('').map(char => digits[char] ?? '').join(''));
  return digits[raw];
};

const FUTURE_PLAN_WORDS = /准备|计划|打算|预计|约好|预约|安排|要去|将会|会在|等到|待会|稍后|一会儿|之后|到时候|下班后|今晚要|今天要/;

/**
 * 拦截把当天未来时刻当成已经发生的生活现场。明确的未来计划仍然允许。
 * 这是模型输出后的低成本硬校验，正常输出不会多调一次 API。
 */
export const findImpossibleMomentsTimeClaim = (content: string, timestamp: number, timeZone: MomentsTimeZone): string | null => {
  const clock = describeMomentsLocalTime(timestamp, timeZone);
  const validateClaim = (literal: string, dayWord: string, period: string, hourValue: number, minuteValue: number, index: number) => {
    if (dayWord === '前天' || dayWord === '昨天' || dayWord === '明天' || dayWord === '后天') return null;
    let hour = hourValue;
    if (!Number.isFinite(hour) || !Number.isFinite(minuteValue) || hour > 23 || minuteValue > 59) return null;
    if (period === '凌晨' && hour === 12) hour = 0;
    else if ((period === '下午' || period === '傍晚' || period === '晚上') && hour < 12) hour += 12;
    else if (period === '中午' && hour > 0 && hour < 6) hour += 12;
    if (hour * 60 + minuteValue <= clock.minuteOfDay + 5) return null;
    const sentence = content.slice(Math.max(0, index - 28), Math.min(content.length, index + literal.length + 36));
    if (FUTURE_PLAN_WORDS.test(sentence)) return null;
    return `正文将当天未来时刻“${literal.trim()}”当成了已发生的现场；生成时当地时间为 ${clock.localDateTime}`;
  };
  const expression = /(前天|昨天|今天|明天|后天)?\s*(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*([零〇一二两三四五六七八九十\d]{1,3})\s*(?:点|时)(?:\s*([零〇一二两三四五六七八九十\d]{1,3})\s*分?|\s*(半|一刻|三刻))?/g;
  for (const match of content.matchAll(expression)) {
    const [literal, dayWord = '', period = '', hourRaw, minuteRaw = '', fraction = ''] = match;
    const hour = parseChineseClockNumber(hourRaw);
    const minute = minuteRaw ? parseChineseClockNumber(minuteRaw) : fraction === '半' ? 30 : fraction === '一刻' ? 15 : fraction === '三刻' ? 45 : 0;
    const violation = validateClaim(literal, dayWord, period, hour, minute, match.index ?? 0);
    if (violation) return violation;
  }
  const digitalExpression = /(前天|昨天|今天|明天|后天)?\s*(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*[:：]\s*(\d{2})/g;
  for (const match of content.matchAll(digitalExpression)) {
    const [literal, dayWord = '', period = '', hourRaw, minuteRaw] = match;
    const violation = validateClaim(literal, dayWord, period, Number(hourRaw), Number(minuteRaw), match.index ?? 0);
    if (violation) return violation;
  }
  return null;
};

/** 只预约真正的生活窗口；低频非候选日不会产生 API 判断。 */
export const nextMomentsDecisionAt = (actorId: string, mode: string, from: number, timeZone: MomentsTimeZone) => {
  if (!postingModeEnabled(mode)) return 0;
  const windows = mode === 'high'
    ? [{ start: 8, span: 4 }, { start: 13, span: 5 }, { start: 19, span: 4 }]
    : [{ start: 9, span: 13 }];
  const ianaZone = typeof timeZone === 'string' && validTimeZone(timeZone) ? timeZone : '';
  const offsetMinutes = typeof timeZone === 'number' ? timeZone : 0;
  const baseLocal = ianaZone ? zonedParts(from, ianaZone) : null;
  for (let dayOffset = 0; dayOffset < 9; dayOffset += 1) {
    const calendar = baseLocal
      ? new Date(Date.UTC(baseLocal.year, baseLocal.month - 1, baseLocal.day + dayOffset))
      : null;
    const dayKey = calendar
      ? `${calendar.getUTCFullYear()}-${padClock(calendar.getUTCMonth() + 1)}-${padClock(calendar.getUTCDate())}`
      : dateKeyAtTimeZone(localDayStartUtc(from, offsetMinutes) + dayOffset * 24 * 60 * 60_000 + 12 * 60 * 60_000, offsetMinutes);
    if (mode === 'low' && stableHash(`${actorId}:${dayKey}`) % 7 >= 3) continue;
    for (let opportunity = 0; opportunity < windows.length; opportunity += 1) {
      const window = windows[opportunity];
      const minuteSpan = window.span * 60;
      const minute = stableHash(`${actorId}:${dayKey}:${opportunity}:decision`) % minuteSpan;
      const wallHour = window.start + Math.floor(minute / 60);
      const wallMinute = minute % 60;
      let candidate: number;
      if (calendar && ianaZone) {
        const desiredAsUtc = Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth(), calendar.getUTCDate(), wallHour, wallMinute, 0);
        candidate = desiredAsUtc;
        // Intl 反解角色墙钟时间；跑两轮以跨过夏令时边界。
        for (let pass = 0; pass < 2; pass += 1) {
          const observed = zonedParts(candidate, ianaZone);
          const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
          candidate -= observedAsUtc - desiredAsUtc;
        }
      } else {
        const dayStart = localDayStartUtc(from, offsetMinutes) + dayOffset * 24 * 60 * 60_000;
        candidate = dayStart + (window.start * 60 + minute) * 60_000;
      }
      if (candidate > from + 5 * 60_000) return candidate;
    }
  }
  return from + 24 * 60 * 60_000;
};

export const shouldRunMomentsCron = (scheduledTime: number) => {
  if (!Number.isFinite(scheduledTime)) return false;
  return Math.floor(scheduledTime / 60_000) % 15 === 0;
};

const shouldRunHourlyRecovery = (scheduledTime: number) =>
  Number.isFinite(scheduledTime) && Math.floor(scheduledTime / 60_000) % 60 === 0;

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
    `CREATE INDEX IF NOT EXISTS idx_moments_tasks_state_due ON moments_tasks(state, due_at)`,
    `CREATE INDEX IF NOT EXISTS idx_moments_tasks_state_updated ON moments_tasks(state, updated_at)`,
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
    `CREATE TABLE IF NOT EXISTS moments_actor_runtime (
      user_id TEXT NOT NULL, actor_id TEXT NOT NULL, actor_type TEXT NOT NULL, char_id TEXT, parent_char_id TEXT,
      display_name TEXT NOT NULL, avatar TEXT, bio TEXT, posting_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL,
      auto_interaction_enabled INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 0,
      timezone_id TEXT NOT NULL DEFAULT '', timezone_offset_minutes INTEGER NOT NULL DEFAULT 0, credential_id TEXT NOT NULL,
      pack_encrypted TEXT NOT NULL, next_decision_at INTEGER NOT NULL DEFAULT 0,
      last_decision_at INTEGER, last_post_at INTEGER, failure_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, actor_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_moments_actor_due ON moments_actor_runtime(enabled, next_decision_at)`,
    `CREATE INDEX IF NOT EXISTS idx_moments_actor_user_interaction ON moments_actor_runtime(user_id, interaction_mode)`,
    `CREATE TABLE IF NOT EXISTS moments_generated_posts (
      post_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, author_id TEXT NOT NULL,
      payload_encrypted TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_moments_generated_author_time ON moments_generated_posts(user_id, author_id, created_at)`,
  ];
  for (const statement of statements) await db.prepare(statement).run();
  // 旧用户已有表时 CREATE IF NOT EXISTS 不会加列；这条只在首次升级成功，
  // 之后 duplicate column 可安全忽略。保留 offset 仅作旧前端兼容回退。
  try { await db.prepare(`ALTER TABLE moments_actor_runtime ADD COLUMN timezone_id TEXT NOT NULL DEFAULT ''`).run(); }
  catch { /* column already exists */ }
  schemaReady = true;
}

function authorized(request: Request, env: Env) {
  // 正式挂载到 AMSG Worker 时沿用已有共享密钥，不需要在朋友圈再复制一份。
  // 保留 MOMENTS_TOKEN 仅为旧的独立本地预览兼容；若两者同时存在，显式朋友圈令牌优先。
  const expected = env.MOMENTS_TOKEN?.trim() || env.AMSG_SERVER_TOKEN?.trim();
  if (!expected) return true;
  return request.headers.get('X-Client-Token') === expected || request.headers.get('X-Moments-Token') === expected;
}

const requireMasterKey = (env: Env) => {
  if (!env.AMSG_MASTER_KEY?.trim()) throw new Error('AMSG_MASTER_KEY 未配置，无法读写朋友圈离线快照');
  return env.AMSG_MASTER_KEY.trim();
};

async function syncRuntime(request: Request, env: Env) {
  const body = object(await request.json().catch(() => ({})));
  const userId = asString(body.userId);
  const credentialId = asString(body.credentialId, 'moments/default');
  const enabled = asBoolean(body.enabled);
  const autoInteractionEnabled = asBoolean(body.autoInteractionEnabled, true);
  const updatedAt = asNumber(body.updatedAt, now());
  const actors = Array.isArray(body.actors) ? body.actors.slice(0, 80) : [];
  if (!userId) return json({ error: 'userId is required' }, 400);
  const userKey = await deriveUserEncryptionKey(userId, requireMasterKey(env));
  let upserted = 0;
  const actorIds: string[] = [];
  for (const raw of actors) {
    const actor = object(raw);
    const actorId = asString(actor.actorId);
    const displayName = asString(actor.displayName);
    if (!actorId || !displayName) continue;
    actorIds.push(actorId);
    const postingMode = asString(actor.postingMode, 'off');
    const interactionMode = asString(actor.interactionMode, 'normal');
    const rowEnabled = enabled && postingModeEnabled(postingMode) ? 1 : 0;
    const timezoneId = asString(actor.timezoneId);
    const offset = Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(asNumber(actor.timezoneOffsetMinutes, 0))));
    const packEncrypted = await encryptForStorage(safeJson(object(actor.pack)), userKey);
    const runtimeTimeZone: MomentsTimeZone = validTimeZone(timezoneId) ? timezoneId : offset;
    const firstDecision = rowEnabled ? nextMomentsDecisionAt(actorId, postingMode, now(), runtimeTimeZone) : 0;
    const result = await env.DB.prepare(`INSERT INTO moments_actor_runtime (
      user_id,actor_id,actor_type,char_id,parent_char_id,display_name,avatar,bio,posting_mode,interaction_mode,
      auto_interaction_enabled,enabled,timezone_id,timezone_offset_minutes,credential_id,pack_encrypted,next_decision_at,
      last_decision_at,last_post_at,failure_count,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,0,?)
    ON CONFLICT(user_id,actor_id) DO UPDATE SET
      actor_type=excluded.actor_type,char_id=excluded.char_id,parent_char_id=excluded.parent_char_id,
      display_name=excluded.display_name,avatar=excluded.avatar,bio=excluded.bio,
      posting_mode=excluded.posting_mode,interaction_mode=excluded.interaction_mode,
      auto_interaction_enabled=excluded.auto_interaction_enabled,enabled=excluded.enabled,
      timezone_id=excluded.timezone_id,timezone_offset_minutes=excluded.timezone_offset_minutes,credential_id=excluded.credential_id,
      pack_encrypted=excluded.pack_encrypted,
      next_decision_at=CASE
        WHEN excluded.enabled=0 THEN 0
        WHEN moments_actor_runtime.enabled=0 OR moments_actor_runtime.posting_mode<>excluded.posting_mode OR moments_actor_runtime.next_decision_at<=0 THEN excluded.next_decision_at
        ELSE moments_actor_runtime.next_decision_at END,
      updated_at=MAX(moments_actor_runtime.updated_at,excluded.updated_at)`)
      .bind(
        userId, actorId, asString(actor.actorType, 'character'), asString(actor.characterId) || null,
        asString(actor.parentCharacterId) || null, displayName, asString(actor.avatar) || null,
        asString(actor.bio) || null, postingMode, interactionMode, autoInteractionEnabled ? 1 : 0,
        rowEnabled, validTimeZone(timezoneId) ? timezoneId : '', offset, credentialId, packEncrypted, firstDecision, updatedAt,
      ).run();
    upserted += result.meta?.changes || 0;
  }
  let disabled = 0;
  if (asBoolean(body.replaceAll, true)) {
    const statement = actorIds.length
      ? env.DB.prepare(`UPDATE moments_actor_runtime SET enabled=0,next_decision_at=0,updated_at=? WHERE user_id=? AND actor_id NOT IN (${actorIds.map(() => '?').join(',')})`).bind(updatedAt, userId, ...actorIds)
      : env.DB.prepare(`UPDATE moments_actor_runtime SET enabled=0,next_decision_at=0,updated_at=? WHERE user_id=?`).bind(updatedAt, userId);
    const result = await statement.run();
    disabled = result.meta?.changes || 0;
  }
  return json({ ok: true, upserted, disabled });
}

async function resolveMomentsCredential(env: Env, userId: string, credentialId: string) {
  const row = await env.DB.prepare(`SELECT encrypted_value AS encryptedValue FROM llm_credentials WHERE user_id=? AND cred_id=? LIMIT 1`)
    .bind(userId, credentialId).first<{ encryptedValue?: string }>();
  if (!row?.encryptedValue) throw new Error(`朋友圈云端凭据 ${credentialId} 不存在`);
  const userKey = await deriveUserEncryptionKey(userId, requireMasterKey(env));
  const parsed = object(JSON.parse(await decryptFromStorage(row.encryptedValue, userKey)));
  const apiUrl = asString(parsed.apiUrl); const apiKey = asString(parsed.apiKey); const model = asString(parsed.primaryModel);
  if (!apiUrl || !apiKey || !model) throw new Error(`朋友圈云端凭据 ${credentialId} 不完整`);
  return { apiUrl, apiKey, model, userKey };
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
      await env.DB.prepare(`UPDATE moments_generated_posts SET deleted_at=? WHERE user_id=? AND post_id=? AND deleted_at IS NULL`)
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

interface RuntimeActorRow {
  userId: string;
  actorId: string;
  actorType: string;
  charId?: string | null;
  parentCharId?: string | null;
  displayName: string;
  avatar?: string | null;
  bio?: string | null;
  postingMode: string;
  interactionMode: string;
  autoInteractionEnabled: number;
  timezoneId: string;
  timezoneOffsetMinutes: number;
  credentialId: string;
  packEncrypted: string;
  nextDecisionAt: number;
  lastPostAt?: number | null;
  failureCount: number;
}

const extractCompletionContent = (data: unknown) => {
  const root = object(data);
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const message = choices.length ? object(object(choices[0]).message) : {};
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => asString(object(part).text)).filter(Boolean).join('\n');
  return asString(root.content);
};

const parseCompletionJson = (data: unknown) => {
  const content = extractCompletionContent(data).trim();
  const unfenced = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return object(JSON.parse(unfenced)); } catch {
    const start = unfenced.indexOf('{'); const end = unfenced.lastIndexOf('}');
    if (start >= 0 && end > start) return object(JSON.parse(unfenced.slice(start, end + 1)));
    throw new Error('朋友圈模型没有返回有效 JSON');
  }
};

async function callMomentsModel(credential: { apiUrl: string; apiKey: string; model: string }, prompt: string, timeoutMs = 90_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(credential.apiUrl, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${credential.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: credential.model, temperature: 0.78, stream: false, messages: [{ role: 'user', content: prompt }] }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`朋友圈模型 HTTP ${response.status}: ${text.slice(0, 300)}`);
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new Error('朋友圈模型响应不是 JSON'); }
    return parseCompletionJson(data);
  } finally { clearTimeout(timer); }
}

async function decryptRuntimePack(env: Env, row: RuntimeActorRow, userKey?: string) {
  const key = userKey || await deriveUserEncryptionKey(row.userId, requireMasterKey(env));
  return object(JSON.parse(await decryptFromStorage(row.packEncrypted, key)));
}

const flattenChatContent = (content: unknown) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    const item = object(part);
    return asString(item.text) || (asString(item.type).includes('image') ? '[图片]' : '');
  }).filter(Boolean).join(' ');
};

/**
 * 优先复用主动消息 2.0 已同步的最新私聊包。只有真正轮到该角色判断/互动时才读一行，
 * 不增加空转 Cron 成本；读不到时回落到朋友圈自己的最近快照。
 */
async function loadLatestAmsgPrivateChat(env: Env, row: RuntimeActorRow, userKey: string) {
  if (!row.charId) return '';
  const state = await env.DB.prepare(`SELECT value FROM client_state WHERE user_id=? AND namespace=? AND key='fire_pack' LIMIT 1`)
    .bind(row.userId, `amsg:char:${row.charId}`).first<{ value?: string }>();
  if (!state?.value) return '';
  try {
    const packed = await decryptFromStorage(state.value, userKey);
    const firePack = object(JSON.parse(await unpackStateValue(packed)));
    const chat = object(firePack.chat);
    const messages = Array.isArray(chat.messages) ? chat.messages.slice(-24) : [];
    const recentChat = messages.map(raw => {
      const message = object(raw); const role = asString(message.role);
      const who = role === 'user' ? '用户' : role === 'assistant' ? row.displayName : role;
      return `${who}：${flattenChatContent(message.content).replace(/\s+/g, ' ').slice(0, 420)}`;
    }).filter(line => !line.endsWith('：')).join('\n').slice(-7000);
    // 常规定时主动消息的 fire_pack 不一定带 chat 字段，但 template 本身含角色核心人设、
    // 最近对话、共同群聊与关系状态。取末段作为最新云端上下文，避免朋友圈快照过期。
    return recentChat || asString(firePack.template).slice(-7000);
  } catch {
    return '';
  }
}

const clampInteractionDueAt = (value: unknown, base: number, seed: string) => {
  const fallback = base + (5 + stableHash(seed) % 176) * 60_000;
  const parsed = asNumber(value, fallback);
  return Math.max(base + 2 * 60_000, Math.min(parsed, base + 6 * 60 * 60_000));
};

async function saveDelivery(env: Env, args: { userId: string; taskId: string; payload: Record<string, unknown>; createdAt?: number }) {
  const createdAt = args.createdAt || now();
  await env.DB.prepare(`INSERT OR IGNORE INTO moments_deliveries (delivery_id,user_id,task_id,payload_json,created_at,acknowledged_at) VALUES (?,?,?,?,?,NULL)`)
    .bind(`moments-delivery-${args.taskId}`, args.userId, args.taskId, safeJson(args.payload), createdAt).run();
  await notifyMomentsDelivery(env, args.userId, args.payload);
}

const selectFormalInteractionRows = (postId: string, rows: RuntimeActorRow[]) => {
  const characters = rows.filter(row => row.actorType !== 'npc');
  const limit = characters.length <= 3 ? characters.length
    : characters.length <= 5 ? Math.ceil(characters.length * 0.8)
      : characters.length <= 10 ? Math.ceil(characters.length * 0.65) : Math.ceil(characters.length * 0.5);
  const selectedCharacters = [...characters]
    .sort((a, b) => stableHash(`${postId}:${a.actorId}`) - stableHash(`${postId}:${b.actorId}`)).slice(0, limit);
  const selectedNpcs = rows.filter(row => row.actorType === 'npc')
    .sort((a, b) => stableHash(`${postId}:npc:${a.actorId}`) - stableHash(`${postId}:npc:${b.actorId}`)).slice(0, 3);
  return [...selectedCharacters, ...selectedNpcs];
};

const PASSERBY_NAMES = ['林栀', '周屿', '许眠', '陈默', '沈棠', '顾川', '叶青', '陆遥', '宋弥', '程野', '夏柚', '白榆', '江澄', '唐梨', '温禾', '乔安'];
const PASSERBY_BIOS = [
  '偶尔刷到附近动态的普通上班族，说话简短随和。', '喜欢拍街景和食物的路人，评论直白但没有恶意。',
  '作息不太规律的年轻人，只对真正感兴趣的内容开口。', '安静的本地生活观察者，通常只点赞，偶尔留一句话。',
  '路过朋友圈的陌生人，性格外向，容易被有趣内容吸引。', '审美挑剔但有分寸的路人，不会假装认识动态作者。',
];
const passerbyActors = (postId: string) => Array.from({ length: 2 + stableHash(`${postId}:passerby-count`) % 4 }, (_, index) => {
  const seed = stableHash(`${postId}:passerby:${index}`);
  return {
    actorId: `moments:passerby:${postId}:${index}:${seed.toString(36)}`, actorType: 'npc',
    displayName: PASSERBY_NAMES[seed % PASSERBY_NAMES.length],
    bio: PASSERBY_BIOS[Math.floor(seed / PASSERBY_NAMES.length) % PASSERBY_BIOS.length],
    interactionMode: 'normal', pack: { persona: PASSERBY_BIOS[Math.floor(seed / PASSERBY_NAMES.length) % PASSERBY_BIOS.length], userRelationship: '完全无关的随机路人，不得假装认识任何人。' },
  };
});

async function planOfflineInteractions(
  env: Env,
  author: RuntimeActorRow,
  credential: { apiUrl: string; apiKey: string; model: string; userKey: string },
  post: Record<string, unknown>,
) {
  if (!author.autoInteractionEnabled) return 0;
  const candidates = await env.DB.prepare(`SELECT user_id AS userId,actor_id AS actorId,actor_type AS actorType,char_id AS charId,parent_char_id AS parentCharId,
    display_name AS displayName,avatar,bio,posting_mode AS postingMode,interaction_mode AS interactionMode,
    auto_interaction_enabled AS autoInteractionEnabled,timezone_id AS timezoneId,timezone_offset_minutes AS timezoneOffsetMinutes,
    credential_id AS credentialId,pack_encrypted AS packEncrypted,next_decision_at AS nextDecisionAt,
    last_post_at AS lastPostAt,failure_count AS failureCount
    FROM moments_actor_runtime WHERE user_id=? AND actor_id<>? AND interaction_mode<>'off' LIMIT 60`)
    .bind(author.userId, author.actorId).all<RuntimeActorRow>();
  const visibility = object(post.visibility);
  const blocked = new Set(Array.isArray(visibility.blockedActorIds) ? visibility.blockedActorIds.filter((value): value is string => typeof value === 'string') : []);
  const visibleRows = (candidates.results || []).filter(row => !blocked.has(row.actorId) && !(row.parentCharId && blocked.has(`moments:character:${row.parentCharId}`)));
  const selected = selectFormalInteractionRows(asString(post.id), visibleRows);
  const actors = [] as Array<Record<string, unknown>>;
  for (const row of selected) {
    const pack = await decryptRuntimePack(env, row, credential.userKey);
    const latestPrivateChat = await loadLatestAmsgPrivateChat(env, row, credential.userKey);
    actors.push({
      actorId: row.actorId, actorType: row.actorType, actorName: row.displayName,
      interactionMode: row.interactionMode, persona: asString(pack.persona, asString(row.bio)).slice(0, 4500),
      userRelationship: asString(pack.userRelationship).slice(0, 1800),
      privateChat: (latestPrivateChat || asString(pack.privateChat)).slice(-7000), sharedGroupChat: asString(pack.sharedGroupChat).slice(-6000),
    });
  }
  const authorPack = await decryptRuntimePack(env, author, credential.userKey);
  const authorPrivateChat = await loadLatestAmsgPrivateChat(env, author, credential.userKey);
  actors.push({
    actorId: author.actorId, actorType: author.actorType, actorName: author.displayName,
    interactionMode: 'author_reply', canReplyAsAuthor: true,
    persona: asString(authorPack.persona, asString(author.bio)).slice(0, 4500),
    userRelationship: asString(authorPack.userRelationship).slice(0, 1800),
    privateChat: (authorPrivateChat || asString(authorPack.privateChat)).slice(-7000),
    sharedGroupChat: asString(authorPack.sharedGroupChat).slice(-6000),
  });
  const passers = passerbyActors(asString(post.id));
  actors.push(...passers.map(actor => ({
    actorId: actor.actorId, actorType: actor.actorType, actorName: actor.displayName,
    interactionMode: actor.interactionMode, persona: actor.pack.persona, userRelationship: actor.pack.userRelationship,
  })));
  if (!actors.length) return 0;
  const interactionNow = now();
  const interactionClock = describeMomentsLocalTime(interactionNow, author.timezoneId || author.timezoneOffsetMinutes);
  const prompt = [
    '你是朋友圈后台互动规划器。只输出 JSON，不要 Markdown，不要解释。',
    '一次性规划本帖的点赞、评论与少量自然互相回复；不必让所有候选人互动，也不要把不同角色写成同一种语气。',
    '角色措辞与亲疏必须来自各自 persona、当前关系、近期私聊；角色互相回复时还要参考共同群聊。没有共同上下文就只回应眼前内容，不得编造共同经历。',
    '每个 actorId 最多出现一次。kind 只能是 reaction 或 comment。comment 可以用 replyToActorId 回复本轮更早出现的评论者、已点赞者或发帖者。',
    '候选中 canReplyAsAuthor=true 的是发帖者本人：TA 不能给自己点赞，只能在其他人先互动之后按需回复其中一人；没有值得回复就不要输出 TA。',
    '随机路人共 2–5 人，点赞或评论完全随机；路人评论最多 3 条，不得假装与作者熟识。最多 8 条评论。dueAt 必须在未来 2 分钟到 6 小时。',
    `唯一现实时间锚点=${interactionClock.localDateTime} ${interactionClock.weekday} ${interactionClock.timezone}。私聊、群聊和帖子里的时间只是历史上下文，不得把当天尚未到来的时刻当作已发生的事。`,
    'JSON：{"interactions":[{"actorId":"候选ID","kind":"reaction|comment","content":"评论时必填","replyToActorId":"可省略","dueAt":0}]}',
    `nowEpochMs=${interactionNow}`,
    `帖子=${JSON.stringify({ id: post.id, authorId: post.authorId, authorName: post.authorName, content: post.content, createdAt: post.createdAt })}`,
    `候选人=${JSON.stringify(actors)}`,
  ].join('\n');
  const plan = await callMomentsModel(credential, prompt);
  const raw = Array.isArray(plan.interactions) ? plan.interactions : [];
  const actorById = new Map(actors.map(actor => [asString(actor.actorId), actor]));
  const passerIds = new Set(passers.map(actor => actor.actorId));
  const used = new Set<string>(); const availableReplyTargets = new Set<string>([author.actorId]);
  const planned = [] as Array<{ actorId: string; kind: 'reaction' | 'comment'; content?: string; replyToActorId?: string; dueAt: number; actor: Record<string, unknown> }>;
  let commentCount = 0; let passerCommentCount = 0;
  for (const rawItem of raw) {
    const item = object(rawItem); const actorId = asString(item.actorId); const actor = actorById.get(actorId);
    if (!actor || used.has(actorId)) continue;
    let kind = asString(item.kind) === 'comment' ? 'comment' as const : 'reaction' as const;
    if (actor.canReplyAsAuthor === true && kind !== 'comment') continue;
    if (asString(actor.interactionMode) === 'reaction_only') kind = 'reaction';
    const content = asString(item.content).slice(0, 500);
    if (kind === 'comment' && (!content || commentCount >= 8 || (passerIds.has(actorId) && passerCommentCount >= 3))) kind = 'reaction';
    if (kind === 'comment') { commentCount += 1; if (passerIds.has(actorId)) passerCommentCount += 1; }
    const requestedTarget = asString(item.replyToActorId);
    const replyToActorId = kind === 'comment' && availableReplyTargets.has(requestedTarget) ? requestedTarget : undefined;
    if (actor.canReplyAsAuthor === true && (!replyToActorId || replyToActorId === author.actorId)) continue;
    planned.push({ actorId, kind, ...(kind === 'comment' ? { content } : {}), ...(replyToActorId ? { replyToActorId } : {}), dueAt: clampInteractionDueAt(item.dueAt, now(), `${post.id}:${actorId}`), actor });
    used.add(actorId); availableReplyTargets.add(actorId);
  }
  // 路人数量由系统决定；模型漏掉时至少保留随机点赞，但仍不计入正式好友统计。
  for (const passer of passers) {
    if (used.has(passer.actorId)) continue;
    const actor = actorById.get(passer.actorId)!;
    planned.push({ actorId: passer.actorId, kind: 'reaction', dueAt: clampInteractionDueAt(undefined, now(), `${post.id}:${passer.actorId}`), actor });
  }
  for (const item of planned) {
    const sourceId = `${post.id}:${item.actorId}:${item.kind}`;
    const payload = {
      actorId: item.actorId, actorType: asString(item.actor.actorType, 'character'), actorName: asString(item.actor.actorName, '角色'),
      kind: item.kind, ...(item.content ? { content: item.content } : {}), ...(item.replyToActorId ? { replyToActorId: item.replyToActorId } : {}), sourceId,
    };
    await env.DB.prepare(`INSERT OR IGNORE INTO moments_tasks (task_id,user_id,char_id,post_id,task_type,due_at,state,payload_json,thread_version,idempotency_key,attempts,error,created_at,updated_at)
      VALUES (?,?,?,?,? ,?,'pending',?,1,?,0,NULL,?,?)`)
      .bind(`moments-job-${sourceId}`, author.userId, item.actorId, asString(post.id), 'interaction', item.dueAt, safeJson(payload), `moments:${post.id}:v1:${item.actorId}:${item.kind}`, now(), now()).run();
  }
  return planned.length;
}

async function generateOfflinePost(env: Env, actor: RuntimeActorRow) {
  const decisionNow = now();
  const actorTimeZone: MomentsTimeZone = actor.timezoneId || actor.timezoneOffsetMinutes;
  const localClock = describeMomentsLocalTime(decisionNow, actorTimeZone);
  const credential = await resolveMomentsCredential(env, actor.userId, actor.credentialId);
  const pack = await decryptRuntimePack(env, actor, credential.userKey);
  const latestPrivateChat = await loadLatestAmsgPrivateChat(env, actor, credential.userKey);
  const recentCloud = await env.DB.prepare(`SELECT payload_encrypted AS payloadEncrypted FROM moments_generated_posts WHERE user_id=? AND author_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 6`)
    .bind(actor.userId, actor.actorId).all<{ payloadEncrypted: string }>();
  const recentPosts: Array<{ content: string; createdAt: number }> = [];
  for (const row of recentCloud.results || []) {
    try {
      const stored = object(JSON.parse(await decryptFromStorage(row.payloadEncrypted, credential.userKey)));
      recentPosts.push({ content: asString(stored.content), createdAt: asNumber(stored.createdAt) });
    } catch { /* 单条旧数据损坏不阻断本轮 */ }
  }
  const photoPreferred = stableHash(`${actor.actorId}:${dateKeyAtTimeZone(decisionNow, actorTimeZone)}:photo`) % 100 < 80;
  const galleryOptions = Array.isArray(pack.galleryOptions) ? pack.galleryOptions.slice(0, 18).map(object) : [];
  const privacyCandidates = Array.isArray(pack.privacyCandidates) ? pack.privacyCandidates.slice(0, 48).map(object) : [];
  const prompt = [
    '你是角色朋友圈后台生活线规划器。只输出 JSON，不要 Markdown，不要解释。',
    '结合角色人设、与用户的当前关系、近期私聊/群聊和最近动态，判断现在是否真有值得发的朋友圈；没有就 shouldPost=false，绝不要凑数。',
    `唯一现实时间锚点=${localClock.localDateTime} ${localClock.weekday} ${localClock.timezone}（epochMs=${decisionNow}）。`,
    '时间是硬约束：私聊、群聊、记忆与旧动态都是历史材料，不能覆盖上面的现实时间。不得把当天未来时刻写成已经发生；不得擅自把“早上/刚才”的事改成下午或晚上。不确定具体时刻就不写钟点。',
    `频率档位=${actor.postingMode}；本次带图倾向=${photoPreferred ? '80%规则命中' : '未命中'}。`,
    '若 shouldPost=true，直接生成不超过500字的生活化正文。可以从自己的小手机相册候选选择 galleryImageId；只有没有合适旧照时才填写 photoPrompt，二者只能选一个。',
    'JSON：{"shouldPost":true,"content":"正文","galleryImageId":"可省略","photoPrompt":"可省略","photoIncludesAuthor":false,"visibilityMode":"public|exclude","excludedActorIds":[]}',
    `角色=${JSON.stringify({ name: actor.displayName, bio: actor.bio || '', persona: asString(pack.persona).slice(0, 5000) })}`,
    `与用户关系=${asString(pack.userRelationship).slice(0, 2200)}`,
    `历史材料｜近期私聊=${(latestPrivateChat || asString(pack.privateChat)).slice(-7000)}`,
    `历史材料｜共同群聊=${asString(pack.sharedGroupChat).slice(-6500)}`,
    `最近动态=${JSON.stringify([...recentPosts, ...(Array.isArray(pack.recentPosts) ? pack.recentPosts.map(object).map(item => ({ content: asString(item.content), createdAt: asNumber(item.createdAt) })) : [])].slice(0, 8))}`,
    `自己的相册候选=${JSON.stringify(galleryOptions.map(item => ({ id: item.id, savedDate: item.savedDate, review: item.review, context: item.context })))}`,
    `可排除的好友=${JSON.stringify(privacyCandidates.map(item => ({ actorId: item.actorId, name: item.name, groupName: item.groupName })))}`,
  ].join('\n');
  const result = await callMomentsModel(credential, prompt);
  const content = asString(result.content).slice(0, 1000);
  if (result.shouldPost !== true || !content) return { posted: false, interactions: 0 };
  const impossibleTime = findImpossibleMomentsTimeClaim(content, decisionNow, actorTimeZone);
  if (impossibleTime) {
    await writeDiagnostic(env.DB, actor.userId, 'warn', 'offline_post_time_rejected', impossibleTime, { actorId: actor.actorId, content });
    return { posted: false, interactions: 0 };
  }
  const createdAt = now(); const postId = `moment-cloud-${actor.actorId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(-40)}-${createdAt.toString(36)}`;
  const galleryById = new Map(galleryOptions.map(item => [asString(item.id), item]));
  const selectedGallery = galleryById.get(asString(result.galleryImageId));
  const modelPrompt = asString(result.photoPrompt).slice(0, 1000);
  const photoPrompt = photoPreferred && !selectedGallery ? (modelPrompt || `与这条朋友圈正文一致的自然生活照片：${content}`) : '';
  const mediaId = selectedGallery ? `moments-gallery-${postId}` : photoPrompt ? `moments-generated-${postId}` : '';
  const candidateIds = new Set(privacyCandidates.map(item => asString(item.actorId)).filter(Boolean));
  const excludedActorIds = Array.isArray(result.excludedActorIds)
    ? [...new Set(result.excludedActorIds.filter((value): value is string => typeof value === 'string' && candidateIds.has(value)))].slice(0, 24) : [];
  const visibilityMode = asString(result.visibilityMode) === 'exclude' && excludedActorIds.length ? 'exclude' : 'public';
  const post = {
    id: postId, authorType: actor.actorType === 'npc' ? 'npc' : 'character', authorId: actor.actorId,
    authorName: actor.displayName, ...(actor.avatar ? { authorAvatar: actor.avatar } : {}), content,
    mediaIds: mediaId ? [mediaId] : [], createdAt, source: actor.actorType === 'npc' ? 'npc' : 'character',
    visibility: { id: `moments-visibility-${postId}`, postId, mode: visibilityMode, allowedActorIds: [], blockedActorIds: visibilityMode === 'exclude' ? excludedActorIds : [], groupIds: [], version: 1, capturedAt: createdAt },
  };
  const media = selectedGallery && mediaId
    ? [{ id: mediaId, postId, url: asString(selectedGallery.url, `moments-gallery-pending:${mediaId}`), galleryImageId: asString(selectedGallery.id), createdAt, generated: false, generationStatus: 'ready' }]
    : mediaId ? [{ id: mediaId, postId, url: `moments-photo-pending:${mediaId}`, createdAt, generated: true, prompt: photoPrompt, includeCharacter: result.photoIncludesAuthor === true, generationStatus: 'pending' }] : [];
  await env.DB.prepare(`INSERT OR IGNORE INTO moments_generated_posts (post_id,user_id,author_id,payload_encrypted,created_at,deleted_at) VALUES (?,?,?,?,?,NULL)`)
    .bind(postId, actor.userId, actor.actorId, await encryptForStorage(safeJson(post), credential.userKey), createdAt).run();
  const taskId = `moments-job-post-${postId}`;
  const payload = { kind: 'post', actorName: actor.displayName, sourceId: postId, postId, actorId: actor.actorId, post, media, taskType: 'post', taskId, __workerDelivered: true };
  await saveDelivery(env, { userId: actor.userId, taskId, payload, createdAt });
  let interactions = 0;
  try { interactions = await planOfflineInteractions(env, actor, credential, post); }
  catch (error: any) { await writeDiagnostic(env.DB, actor.userId, 'warn', 'offline_interaction_plan_failed', error?.message || '互动规划失败', { postId }); }
  return { posted: true, interactions, createdAt };
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
      if (request.method === 'GET' && path.endsWith('/health')) return json({ ok: true, service: 'sullyos-moments', schema: 2, now: now() });
      if (request.method === 'POST' && path.endsWith('/runtime')) return await syncRuntime(request, env);
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
  async scheduled(event: any, env: Env) {
    const scheduledTime = asNumber(event?.scheduledTime, now());
    // AMSG 仍保持每分钟 Cron；朋友圈只在整 15 分钟进入自己的数据库路径，
    // 因而不会为了离线发帖额外增加 Worker 唤醒，也不会每分钟读取朋友圈表。
    if (!shouldRunMomentsCron(scheduledTime)) return;
    await ensureSchema(env.DB);
    const tickNow = now();
    // 真实离线投递：正文/互动已经一次性规划完成；到点后直接转成可拉取事实，不为每个角色再调 API。
    const due = await env.DB.prepare(`SELECT task_id AS id,user_id AS userId,char_id AS actorId,post_id AS postId,task_type AS type,payload_json AS payload FROM moments_tasks WHERE state='pending' AND due_at<=? ORDER BY due_at ASC LIMIT 100`).bind(tickNow).all<any>();
    for (const task of due.results || []) {
      let payload = object((() => { try { return JSON.parse(task.payload || '{}'); } catch { return {}; } })());
      payload = { ...payload, taskId: task.id, taskType: task.type, postId: task.postId, actorId: task.actorId, __workerDelivered: true };
      const deliveryId = `moments-delivery-${task.id}`;
      const claimed = await env.DB.prepare(`UPDATE moments_tasks SET state='done',updated_at=? WHERE task_id=? AND state='pending'`).bind(tickNow, task.id).run();
      if (!(claimed.meta?.changes || 0)) continue;
      await env.DB.prepare(`INSERT OR IGNORE INTO moments_deliveries (delivery_id,user_id,task_id,payload_json,created_at,acknowledged_at) VALUES (?,?,?,?,?,NULL)`).bind(deliveryId, task.userId, task.id, safeJson(payload), tickNow).run();
      await notifyMomentsDelivery(env, task.userId, payload);
    }

    // 每轮最多判断一名到期主体：角色多时自然排队，避免同一分钟模型与 D1 突发。
    const actor = await env.DB.prepare(`SELECT user_id AS userId,actor_id AS actorId,actor_type AS actorType,char_id AS charId,parent_char_id AS parentCharId,
      display_name AS displayName,avatar,bio,posting_mode AS postingMode,interaction_mode AS interactionMode,
      auto_interaction_enabled AS autoInteractionEnabled,timezone_id AS timezoneId,timezone_offset_minutes AS timezoneOffsetMinutes,
      credential_id AS credentialId,pack_encrypted AS packEncrypted,next_decision_at AS nextDecisionAt,
      last_post_at AS lastPostAt,failure_count AS failureCount
      FROM moments_actor_runtime WHERE enabled=1 AND next_decision_at>0 AND next_decision_at<=?
      ORDER BY next_decision_at ASC LIMIT 1`).bind(tickNow).first<RuntimeActorRow>();
    if (actor) {
      const minimumGap = actor.postingMode === 'high' ? 4 * 60 * 60_000
        : actor.postingMode === 'medium' ? 18 * 60 * 60_000 : 48 * 60 * 60_000;
      const nextDecisionAt = nextMomentsDecisionAt(actor.actorId, actor.postingMode, tickNow, actor.timezoneId || actor.timezoneOffsetMinutes);
      if (actor.lastPostAt && tickNow - actor.lastPostAt < minimumGap) {
        await env.DB.prepare(`UPDATE moments_actor_runtime SET next_decision_at=?,last_decision_at=?,failure_count=0,updated_at=? WHERE user_id=? AND actor_id=?`)
          .bind(Math.max(nextDecisionAt, actor.lastPostAt + minimumGap), tickNow, tickNow, actor.userId, actor.actorId).run();
      } else {
        try {
          const generated = await generateOfflinePost(env, actor);
          await env.DB.prepare(`UPDATE moments_actor_runtime SET next_decision_at=?,last_decision_at=?,last_post_at=CASE WHEN ?=1 THEN ? ELSE last_post_at END,failure_count=0,updated_at=? WHERE user_id=? AND actor_id=?`)
            .bind(nextDecisionAt, tickNow, generated.posted ? 1 : 0, generated.posted ? generated.createdAt : null, tickNow, actor.userId, actor.actorId).run();
        } catch (error: any) {
          const failureCount = Math.min(8, Math.max(0, actor.failureCount || 0) + 1);
          const retryAt = tickNow + Math.min(6 * 60 * 60_000, 30 * 60_000 * 2 ** (failureCount - 1));
          await env.DB.prepare(`UPDATE moments_actor_runtime SET next_decision_at=?,last_decision_at=?,failure_count=?,updated_at=? WHERE user_id=? AND actor_id=?`)
            .bind(retryAt, tickNow, failureCount, tickNow, actor.userId, actor.actorId).run();
          await writeDiagnostic(env.DB, actor.userId, 'warn', 'offline_post_check_failed', error?.message || '离线发帖判断失败', { actorId: actor.actorId, retryAt, failureCount });
        }
      }
    }

    // 旧 running 任务恢复只需每小时做一次，且使用 state+updated_at 索引。
    if (shouldRunHourlyRecovery(scheduledTime)) {
      const cutoff = tickNow - 10 * 60_000;
      const result = await env.DB.prepare(`UPDATE moments_tasks SET state='pending',error='Worker recovered a stale running task',updated_at=? WHERE state='running' AND updated_at<?`).bind(tickNow, cutoff).run();
      if (result.meta?.changes) await writeDiagnostic(env.DB, null, 'info', 'stale_tasks_requeued', `requeued ${result.meta.changes} stale task(s)`);
    }
  },
};
