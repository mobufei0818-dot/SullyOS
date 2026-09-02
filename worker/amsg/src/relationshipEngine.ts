/**
 * 关系主动消息层：独立于 amsg-server 的任务表，只保存「何时值得创建一条原版任务」。
 *
 * 内容生成、推送、收件箱、取消与失败重试仍完全交给原版 amsg-server；本模块绝不直接
 * 伪造聊天消息。D1 中的 payload 以用户派生密钥加密，避免把关系状态明文留库。
 */
import { decryptFromStorage, deriveUserEncryptionKey, encryptForStorage } from '@rei-standard/amsg-server/cloudflare';
import { constantTimeEqual } from './instantChat';
import {
  awakeRelationshipElapsedMs,
  normalizeRelationshipSleepWindows,
  relationshipSleepWindowFromClocks,
  type RelationshipSleepWindow,
} from '../../../utils/relationshipSleep';
import { planRelationshipTaskLockReconciliation } from '../../../utils/relationshipPending';

type Style = 'reserved' | 'natural' | 'clingy';
type D1Statement = { bind: (...values: unknown[]) => D1Statement; first: <T = Record<string, unknown>>() => Promise<T | null>; run: () => Promise<unknown>; all: <T = Record<string, unknown>>() => Promise<{ results?: T[] }> };
type D1Like = { prepare: (query: string) => D1Statement };

export interface RelationshipConfigWire {
  enabled: boolean;
  initiativeStyle: Style;
  dailyLimit: number;
  minimumIntervalMinutes?: number;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  followUpPromises?: boolean;
}

export type RelationshipJealousyKind = 'moments_romance' | 'moments_intimate_comment' | 'chat_other_affection' | 'chat_comparison' | 'reassurance';
export interface RelationshipJealousySignalWire {
  eventId: string;
  kind: RelationshipJealousyKind;
  intensity: number;
  reason: string;
  createdAt: number;
}

interface RelationshipRecord {
  v: 1;
  userId: string;
  charId: string;
  charName: string;
  tzId: string;
  credRef: string;
  config: RelationshipConfigWire;
  /** 最近一次由角色日程同步来的睡眠时段；App 关闭后 Worker 仍据此暂停增长。 */
  sleepWindows?: RelationshipSleepWindow[];
  longing: number;
  nextThreshold: number;
  affection: number;
  jealousy: number;
  innerVoice: string;
  lastCalculatedAt: number;
  lastUserAt: number;
  lastAssistantAt: number;
  /** 最近一次关系主动消息真正发送成功的时间；排上但跳过/失败不计入。 */
  lastDispatchAt: number;
  /** 仅由 Cron 在完成一轮关系检查后更新；绝不能复用 lastCalculatedAt。 */
  lastTickAt?: number;
  dailyDate: string;
  dailySent: number;
  pendingTaskUuid?: string;
  /** 保存在加密 payload 内的实际下次扫描时间，供同步时避免把既有 tick 往后推。 */
  nextTickAt?: number;
  /** 最近一次尝试创建原版 AMSG 任务的失败摘要；不写入聊天正文或凭据。 */
  lastScheduleError?: string;
  lastScheduleErrorAt?: number;
  /** 最近一次带现实后续含义的话，到了合理时间窗后仅提供一次联系机会。 */
  promiseDueAt?: number;
  promiseKind?: string;
  /** 醋意事实只保留最近一小段稳定 ID，重试/刷新不会重复加分。 */
  jealousyEvents?: Array<{ eventId: string; kind: RelationshipJealousyKind; delta: number; reason: string; createdAt: number }>;
  jealousyForceEnabled?: boolean;
  /** 同一轮 >=80 只允许接管一次；跌回 70 以下才重新 armed。 */
  jealousyCriticalLatched?: boolean;
  criticalPendingTaskUuid?: string;
  criticalRetryAt?: number;
  lastJealousyEventId?: string;
  lastJealousyReason?: string;
  lastJealousyAt?: number;
}

export interface RelationshipSyncInput {
  charId: string;
  charName: string;
  tzId: string;
  credRef?: string;
  config: RelationshipConfigWire;
  sleepWindows?: RelationshipSleepWindow[];
  /** 首次启用时前端按已有聊天/人设给出的合理估值，不是固定从 0 开始。 */
  initialLonging?: number;
  lastUserAt?: number;
  lastAssistantAt?: number;
  /** 只传关系方向，不上传聊天正文。 */
  userSignal?: 'neutral' | 'affectionate' | 'distant';
  affection?: number;
  jealousy?: number;
  jealousyEvents?: RelationshipJealousySignalWire[];
  jealousyForceEnabled?: boolean;
  innerVoice?: string;
  promise?: { dueAt: number; kind: string };
  /** 用户从关系卡主动校正的数值；只改关系账本，不写进聊天正文或角色设定。 */
  manual?: { longing?: number; nextThreshold?: number };
}

interface RelationshipJealousyTarget extends Omit<RelationshipSyncInput, 'jealousyEvents' | 'jealousy'> {
  initialJealousy?: number;
  signals: RelationshipJealousySignalWire[];
}

export interface RelationshipEngineEnv { DB: unknown; AMSG_MASTER_KEY: string; AMSG_SERVER_TOKEN?: string; }

let configuredEnv: RelationshipEngineEnv | null = null;
let schemaReady: Promise<void> | null = null;
/** buildWorkerConfig 每次初始化时注入；与原版 Worker 共用同一个 D1 和主密钥。 */
export const configureRelationshipEngine = (env: RelationshipEngineEnv | null) => { configuredEnv = env; };

const HOUR = 60 * 60_000;
const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const isTakeoutPromise = (kind?: string) => kind === 'takeout_to_user' || kind === 'takeout_to_character';
const ratePerMs = (style: Style) => (style === 'clingy' ? 30 / HOUR : style === 'reserved' ? 6 / HOUR : 9 / HOUR);
const dayKey = (time: number, tzId: string) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tzId, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
  } catch { return new Date(time).toISOString().slice(0, 10); }
};
const inQuietHours = (time: number, config: RelationshipConfigWire, tzId: string) => {
  if (!config.quietHoursEnabled) return false;
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tzId, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(time));
    const hour = Number(part.find(item => item.type === 'hour')?.value || 0);
    const minute = Number(part.find(item => item.type === 'minute')?.value || 0);
    const [sh = '0', sm = '0'] = config.quietHoursStart.split(':');
    const [eh = '0', em = '0'] = config.quietHoursEnd.split(':');
    const now = hour * 60 + minute;
    const start = Number(sh) * 60 + Number(sm);
    const end = Number(eh) * 60 + Number(em);
    return start < end ? now >= start && now < end : now >= start || now < end;
  } catch { return false; }
};

const minimumGapMs = (state: RelationshipRecord) => Math.max(30, state.config.minimumIntervalMinutes || 60) * 60_000;
const hasReachedDailyLimit = (state: RelationshipRecord) => {
  const limit = Math.max(0, state.config.dailyLimit || 0);
  return limit > 0 && state.dailySent >= limit;
};
const canDispatchNow = (state: RelationshipRecord, now: number) => !state.pendingTaskUuid
  && !hasReachedDailyLimit(state)
  && now - state.lastDispatchAt >= minimumGapMs(state)
  && !inQuietHours(now, state.config, state.tzId);
const sentRelief = (style: Style) => style === 'clingy' ? 6 : style === 'reserved' ? 10 : 8;
const isCriticalDue = (state: RelationshipRecord, now: number) => Boolean(
  state.jealousyForceEnabled
  && state.jealousy >= 80
  && !state.jealousyCriticalLatched
  && !state.criticalPendingTaskUuid
  && (!state.criticalRetryAt || state.criticalRetryAt <= now),
);

const jealousyMultiplier = (state: RelationshipRecord) => {
  const temperament = state.config.initiativeStyle === 'clingy' ? 1.18 : state.config.initiativeStyle === 'reserved' ? 0.72 : 1;
  // 好感越深同类事件越有分量，但不能因为 100 好感而指数膨胀。
  return temperament * (0.78 + clamp(state.affection, 0, 100) / 220);
};

/**
 * 账本式结算：eventId 已看过就完全无操作；“安抚”才回落，普通回复不会被误当成降醋意。
 * 只保存原因摘要和强度，不保存帖子正文或私聊原文。
 */
const applyJealousySignal = (state: RelationshipRecord, raw: RelationshipJealousySignalWire) => {
  const eventId = String(raw.eventId || '').trim();
  if (!eventId || state.jealousyEvents?.some(item => item.eventId === eventId)) return false;
  const intensity = clamp(Number(raw.intensity) || 0, 1, 30);
  const positive = raw.kind !== 'reassurance';
  const delta = positive
    ? Math.max(1, Math.round(intensity * jealousyMultiplier(state)))
    : -Math.max(2, Math.round(intensity * (0.75 + clamp(state.affection, 0, 100) / 250)));
  state.jealousy = clamp(state.jealousy + delta);
  const record = {
    eventId, kind: raw.kind, delta,
    reason: String(raw.reason || (positive ? '可见关系刺激' : '用户安抚')).slice(0, 120),
    createdAt: Number(raw.createdAt) || Date.now(),
  };
  state.jealousyEvents = [...(state.jealousyEvents || []).filter(item => item.eventId !== eventId), record].slice(-128);
  state.lastJealousyEventId = record.eventId;
  state.lastJealousyReason = record.reason;
  state.lastJealousyAt = record.createdAt;
  // 一轮爆发只能接管一次。真正的安抚让数值回到安全线下后，才允许未来重新武装。
  if (state.jealousy < 70) {
    state.jealousyCriticalLatched = false;
    state.criticalRetryAt = undefined;
  }
  return true;
};

const dbOf = (env: RelationshipEngineEnv): D1Like => env.DB as D1Like;

const ensureTable = (env: RelationshipEngineEnv) => {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await dbOf(env).prepare(`CREATE TABLE IF NOT EXISTS sully_relationship_state (
    user_id TEXT NOT NULL, char_id TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL,
    next_tick_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, char_id)
  )`).run();
  // 兼容这一功能测试期间已经创建过的旧表；重复添加在 D1 中会报错，忽略即可。
  await dbOf(env).prepare('ALTER TABLE sully_relationship_state ADD COLUMN next_tick_at INTEGER NOT NULL DEFAULT 0').run().catch(() => undefined);
  await dbOf(env).prepare('CREATE INDEX IF NOT EXISTS idx_sully_relationship_next_tick ON sully_relationship_state(next_tick_at)').run();
  })();
  return schemaReady;
};

const load = async (env: RelationshipEngineEnv, userId: string, charId: string): Promise<RelationshipRecord | null> => {
  await ensureTable(env);
  const row = await dbOf(env).prepare('SELECT payload FROM sully_relationship_state WHERE user_id = ? AND char_id = ?').bind(userId, charId).first<{ payload?: string }>();
  if (!row?.payload) return null;
  try {
    const key = await deriveUserEncryptionKey(userId, env.AMSG_MASTER_KEY);
    return JSON.parse(await decryptFromStorage(row.payload, key)) as RelationshipRecord;
  } catch (error) {
    console.warn('[relationship] state decrypt failed', charId, error);
    return null;
  }
};

const save = async (env: RelationshipEngineEnv, record: RelationshipRecord) => {
  const key = await deriveUserEncryptionKey(record.userId, env.AMSG_MASTER_KEY);
  const payload = await encryptForStorage(JSON.stringify(record), key);
  const now = Date.now();
  // 原版 Cron 仍是一分钟一次；关系层每十分钟才需要结算，关闭时则一天后再看。
  const normalTickAt = record.config.enabled ? now + 10 * 60_000 : now + 24 * HOUR;
  // 外卖/承诺事件需要在明确 ETA 到达时被 Cron 取到，不能被 10 分钟轮询额外拖后。
  const scheduledPromiseAt = record.promiseDueAt && record.promiseDueAt > now
    ? Math.min(normalTickAt, record.promiseDueAt)
    : normalTickAt;
  // 已超过阈值且没有明确阻塞时，下一分钟 Cron 就应尝试创建任务；不能再白等 10 分钟。
  const shouldCheckImmediately = (record.config.enabled && canDispatchNow(record, now)
    && (record.longing >= record.nextThreshold
      || Boolean((record.config.followUpPromises || isTakeoutPromise(record.promiseKind)) && record.promiseDueAt && record.promiseDueAt <= now)))
    || isCriticalDue(record, now);
  const requestedTickAt = shouldCheckImmediately ? now : scheduledPromiseAt;
  // 关键：聊天页面的同步可每分钟发生一次，不能把已经安排好的 10 分钟检查反复推迟。
  // 仅保留「仍在未来的更早时刻」；已到期的时刻由本次保存重新排下一轮。
  const nextTickAt = record.nextTickAt && record.nextTickAt > now
    ? Math.min(record.nextTickAt, requestedTickAt)
    : requestedTickAt;
  record.nextTickAt = nextTickAt;
  await dbOf(env).prepare(`INSERT INTO sully_relationship_state (user_id, char_id, payload, updated_at, next_tick_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, char_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at, next_tick_at = excluded.next_tick_at`)
    .bind(record.userId, record.charId, payload, now, nextTickAt).run();
};

const dispatchStatus = (state: RelationshipRecord, now = Date.now()) => {
  if (state.criticalPendingTaskUuid) return '醋意阈值已触发：高优先级关系任务正在等待原版主动消息 2.0 结算。';
  if (isCriticalDue(state, now)) return '醋意达到强制联系阈值，正在建立高优先级主动消息。';
  if (state.jealousy >= 80 && !state.jealousyForceEnabled) return '醋意已达到强制阈值；“醋意强制联系”开关当前关闭，仅记录不投递。';
  if (!state.config.enabled) return '关系主动消息已关闭。';
  if (state.pendingTaskUuid) return '已有一条关系任务正在等待原版主动消息 2.0 结算。';
  if (hasReachedDailyLimit(state)) return '已达到该角色设置的每日主动消息上限。';
  if (now - state.lastDispatchAt < minimumGapMs(state)) return '距离上一次关系任务创建尚未达到最短间隔。';
  if (inQuietHours(now, state.config, state.tzId)) return '当前处于该角色的免打扰时段。';
  if (state.longing >= state.nextThreshold && state.nextTickAt && state.nextTickAt > now) return '阈值已达到，等待 Worker 的下一次关系检查。';
  if (state.longing >= state.nextThreshold) return '阈值已达到，等待 Worker Cron 执行。';
  return '尚未达到下一次思念阈值。';
};

const publicState = (state: RelationshipRecord) => ({
  longing: Math.round(state.longing), nextThreshold: Math.round(state.nextThreshold), affection: Math.round(state.affection),
  jealousy: Math.round(state.jealousy), innerVoice: state.innerVoice, dailySent: state.dailySent,
  updatedAt: state.lastCalculatedAt,
  diagnostics: {
    pendingTaskUuid: state.pendingTaskUuid,
    criticalPendingTaskUuid: state.criticalPendingTaskUuid,
    lastDispatchAt: state.lastDispatchAt || undefined,
    lastTickAt: state.lastTickAt,
    nextTickAt: state.nextTickAt,
    lastScheduleError: state.lastScheduleError,
    lastScheduleErrorAt: state.lastScheduleErrorAt,
    lastJealousyEventId: state.lastJealousyEventId,
    lastJealousyReason: state.lastJealousyReason,
    jealousyCriticalLatched: state.jealousyCriticalLatched,
    status: dispatchStatus(state),
  },
});

const advance = (state: RelationshipRecord, now: number) => {
  const date = dayKey(now, state.tzId);
  if (state.dailyDate !== date) { state.dailyDate = date; state.dailySent = 0; }
  const elapsed = Math.max(0, now - state.lastCalculatedAt);
  const sleepWindows = state.sleepWindows?.length
    ? normalizeRelationshipSleepWindows(state.sleepWindows)
    : state.config.quietHoursEnabled
      ? relationshipSleepWindowFromClocks(state.config.quietHoursStart, state.config.quietHoursEnd)
      : [];
  const rate = ratePerMs(state.config.initiativeStyle);
  const awakeNeeded = rate > 0 ? Math.max(0, 100 - state.longing) / rate : 0;
  const awakeElapsed = awakeRelationshipElapsedMs(
    state.lastCalculatedAt,
    now,
    state.tzId,
    sleepWindows,
    Math.min(elapsed, awakeNeeded),
  );
  state.longing = clamp(state.longing + awakeElapsed * rate);
  // 即使整段都在睡眠，也必须推进游标；醒来后不会把睡眠时间补涨回来。
  state.lastCalculatedAt = now;
};

/**
 * pendingTaskUuid 只是关系层的防重复锁。原版任务如果已经 sent / failed，或终态行已被
 * 保留期清掉，锁必须按原版事实源自愈；查询失败时宁可继续锁住，也不能误判后双发。
 */
const reconcilePendingTaskLocks = async (env: RelationshipEngineEnv, state: RelationshipRecord) => {
  const uuids = [state.pendingTaskUuid, state.criticalPendingTaskUuid]
    .filter((uuid): uuid is string => typeof uuid === 'string' && uuid.length > 0);
  if (!uuids.length) return;
  const placeholders = uuids.map(() => '?').join(', ');
  const result = await dbOf(env)
    .prepare(`SELECT uuid, status FROM scheduled_messages WHERE user_id = ? AND uuid IN (${placeholders})`)
    .bind(state.userId, ...uuids)
    .all<{ uuid?: string; status?: string }>();
  const plans = planRelationshipTaskLockReconciliation(state, result.results || []);
  for (const plan of plans) {
    if (plan.critical) state.criticalPendingTaskUuid = undefined;
    else state.pendingTaskUuid = undefined;
    if (plan.sent && !plan.critical) {
      state.longing = clamp(state.longing - sentRelief(state.config.initiativeStyle));
      state.nextThreshold = clamp(state.longing + 30);
      state.lastDispatchAt = Date.now();
      state.dailySent += 1;
    }
  }
};

/**
 * 用户回来的“安心感”取决于离开多久：热聊里不能每句都大幅扣分。
 * 内部保留小数，关系卡只显示取整，且 clamp 保证永不跌到负数。
 */
const replyDelta = (gapMs: number, signal: RelationshipSyncInput['userSignal']) => {
  const gapMinutes = Math.max(0, gapMs) / 60_000;
  const relief = gapMinutes >= 180 ? -8 : gapMinutes >= 60 ? -4 : gapMinutes >= 20 ? -1.5 : -0.35;
  return relief + (signal === 'affectionate' ? 2 : signal === 'distant' ? 1 : 0);
};

const createRelationshipState = (userId: string, input: RelationshipSyncInput, now: number, initialJealousy?: number): RelationshipRecord => ({
  v: 1, userId, charId: input.charId, charName: input.charName, tzId: input.tzId || 'UTC',
  credRef: input.credRef || `char:${input.charId}/chat`, config: input.config,
  sleepWindows: normalizeRelationshipSleepWindows(input.sleepWindows),
  longing: clamp(input.initialLonging ?? 20), nextThreshold: 30,
  affection: clamp(input.affection ?? 58), jealousy: clamp(initialJealousy ?? input.jealousy ?? 8),
  innerVoice: String(input.innerVoice || '把想说的话先悄悄留在心里。'),
  lastCalculatedAt: now, lastUserAt: input.lastUserAt || 0, lastAssistantAt: input.lastAssistantAt || 0,
  lastDispatchAt: 0, dailyDate: dayKey(now, input.tzId || 'UTC'), dailySent: 0,
  jealousyForceEnabled: input.jealousyForceEnabled !== false,
  ...((input.config.followUpPromises || isTakeoutPromise(input.promise?.kind)) && input.promise && input.promise.dueAt > now
    ? { promiseDueAt: input.promise.dueAt, promiseKind: input.promise.kind }
    : {}),
});

export const syncRelationshipState = async (env: RelationshipEngineEnv, userId: string, input: RelationshipSyncInput) => {
  const now = Date.now();
  let state = await load(env, userId, input.charId);
  if (!state) {
    state = createRelationshipState(userId, input, now);
  } else {
    advance(state, now);
    const receivedNewUserMessage = (input.lastUserAt || 0) > state.lastUserAt;
    if (receivedNewUserMessage) state.longing = clamp(state.longing + replyDelta((input.lastUserAt || now) - state.lastUserAt, input.userSignal));
    state.lastUserAt = Math.max(state.lastUserAt, input.lastUserAt || 0);
    state.lastAssistantAt = Math.max(state.lastAssistantAt, input.lastAssistantAt || 0);
    state.charName = input.charName || state.charName;
    state.tzId = input.tzId || state.tzId;
    state.credRef = input.credRef || state.credRef;
    state.config = input.config;
    if (Array.isArray(input.sleepWindows)) state.sleepWindows = normalizeRelationshipSleepWindows(input.sleepWindows);
    if (typeof input.jealousyForceEnabled === 'boolean') state.jealousyForceEnabled = input.jealousyForceEnabled;
    if (typeof input.affection === 'number') state.affection = clamp(input.affection);
    // 醋意是 Worker 的事件账本状态，不能被每次聊天同步传来的旧前端快照覆盖。
    if (typeof input.innerVoice === 'string' && input.innerVoice.trim()) state.innerVoice = input.innerVoice.trim();
    if ((input.config.followUpPromises || isTakeoutPromise(input.promise?.kind)) && input.promise && input.promise.dueAt > now && input.promise.dueAt - now < 3 * 60 * 60_000) {
      state.promiseDueAt = input.promise.dueAt;
      state.promiseKind = input.promise.kind;
    }
  }
  // 手动校正是 D1 账本的正式写入，不是前端展示覆写。两项都严格限制在 0–100。
  if (Number.isFinite(input.manual?.longing)) state.longing = clamp(Number(input.manual?.longing));
  if (Number.isFinite(input.manual?.nextThreshold)) state.nextThreshold = clamp(Math.round(Number(input.manual?.nextThreshold)));
  for (const event of input.jealousyEvents || []) applyJealousySignal(state, event);
  // 兼容修复前可能已超过 100 的旧阈值，后续任意同步都会自然收敛。
  state.nextThreshold = clamp(state.nextThreshold);
  await save(env, state);
  return publicState(state);
};

const verify = async (request: Request, env: RelationshipEngineEnv) => {
  const token = (env.AMSG_SERVER_TOKEN || '').trim();
  if (token && !(await constantTimeEqual(request.headers.get('X-Client-Token') || '', token))) return null;
  const userId = request.headers.get('X-User-Id') || '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId) ? userId : null;
};

const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, X-Client-Token' } });

/** HTTP 路由。返回 null 表示不是关系层路径，交回上游 amsg-server。 */
export const handleRelationshipRequest = async (
  request: Request,
  env: RelationshipEngineEnv,
  scheduleCritical?: (state: RelationshipRecord) => Promise<{ uuid?: string; error?: string }>,
): Promise<Response | null> => {
  const url = new URL(request.url);
  const isStatePath = url.pathname.endsWith('/relationship/state');
  const isJealousyPath = url.pathname.endsWith('/relationship/jealousy');
  if (!isStatePath && !isJealousyPath) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, X-Client-Token' } });
  const userId = await verify(request, env);
  if (!userId) return response(401, { success: false, error: { code: 'RELATIONSHIP_AUTH_REQUIRED', message: '关系层需要有效的用户标识和共享密钥。' } });
  if (isStatePath && request.method === 'GET') {
    const charId = url.searchParams.get('charId') || '';
    const state = charId ? await load(env, userId, charId) : null;
    return response(200, { success: true, data: state ? publicState(state) : null });
  }
  if (request.method !== 'POST') return response(405, { success: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 GET 或 POST' } });
  try {
    if (isJealousyPath) {
      const body = await request.json() as { forceEnabled?: boolean; targets?: RelationshipJealousyTarget[] };
      const targets = Array.isArray(body?.targets) ? body.targets.slice(0, 64) : [];
      if (!targets.every(target => target?.charId && target?.config)) {
        return response(400, { success: false, error: { code: 'INVALID_JEALOUSY_EVENTS', message: '醋意事件缺少角色或关系配置。' } });
      }
      const now = Date.now();
      const results: Array<ReturnType<typeof publicState>> = [];
      for (const target of targets) {
        const syncInput: RelationshipSyncInput = {
          charId: target.charId, charName: target.charName, tzId: target.tzId,
          credRef: target.credRef, config: target.config,
          initialLonging: target.initialLonging, affection: target.affection,
          innerVoice: target.innerVoice,
        };
        let state = await load(env, userId, target.charId);
        if (!state) state = createRelationshipState(userId, syncInput, now, target.initialJealousy);
        else {
          advance(state, now);
          state.charName = target.charName || state.charName;
          state.tzId = target.tzId || state.tzId;
          state.credRef = target.credRef || state.credRef;
          state.config = target.config;
          if (typeof target.affection === 'number') state.affection = clamp(target.affection);
          if (typeof target.innerVoice === 'string' && target.innerVoice.trim()) state.innerVoice = target.innerVoice.trim();
        }
        state.jealousyForceEnabled = body.forceEnabled !== false;
        for (const signal of target.signals || []) applyJealousySignal(state, signal);
        if (isCriticalDue(state, now) && scheduleCritical) {
          const result = await scheduleCritical(state);
          if (result.uuid) {
            state.criticalPendingTaskUuid = result.uuid;
            state.jealousyCriticalLatched = true;
            state.criticalRetryAt = undefined;
            state.lastScheduleError = undefined;
            state.lastScheduleErrorAt = undefined;
          } else {
            state.criticalRetryAt = now + 5 * 60_000;
            state.lastScheduleError = (result.error || '醋意高优先级任务创建没有返回任务 ID。').slice(0, 400);
            state.lastScheduleErrorAt = now;
          }
        }
        await save(env, state);
        results.push(publicState(state));
      }
      return response(200, { success: true, data: results });
    }
    const input = await request.json() as RelationshipSyncInput;
    if (!input?.charId || !input?.config) return response(400, { success: false, error: { code: 'INVALID_RELATIONSHIP_STATE', message: '缺少角色或关系配置。' } });
    const synced = await syncRelationshipState(env, userId, input);
    // 私聊中的明确刺激同样不必等到下一分钟 Cron；只有跨过阈值且未锁定时才会走一次。
    const state = await load(env, userId, input.charId);
    if (state && isCriticalDue(state, Date.now()) && scheduleCritical) {
      const result = await scheduleCritical(state);
      if (result.uuid) {
        state.criticalPendingTaskUuid = result.uuid;
        state.jealousyCriticalLatched = true;
        state.criticalRetryAt = undefined;
        state.lastScheduleError = undefined;
        state.lastScheduleErrorAt = undefined;
      } else {
        state.criticalRetryAt = Date.now() + 5 * 60_000;
        state.lastScheduleError = (result.error || '醋意高优先级任务创建没有返回任务 ID。').slice(0, 400);
        state.lastScheduleErrorAt = Date.now();
      }
      await save(env, state);
      return response(200, { success: true, data: publicState(state) });
    }
    return response(200, { success: true, data: synced });
  } catch (error) {
    return response(400, { success: false, error: { code: 'RELATIONSHIP_STATE_FAILED', message: error instanceof Error ? error.message : '关系状态保存失败。' } });
  }
};

/**
 * Cron 只推进分数并挑出可派发对象。真正的原版任务由 index.ts 注入的 schedule 回调创建。
 */
export const runRelationshipTick = async (env: RelationshipEngineEnv, schedule: (state: RelationshipRecord, kind?: 'normal' | 'jealousy-critical') => Promise<{ uuid?: string; error?: string }>) => {
  await ensureTable(env);
  const rows = await dbOf(env).prepare('SELECT user_id, char_id, payload FROM sully_relationship_state WHERE next_tick_at <= ? LIMIT 200').bind(Date.now()).all<{ user_id?: string; char_id?: string; payload?: string }>();
  const now = Date.now();
  let scheduled = 0;
  for (const row of rows.results || []) {
    if (!row.payload) continue;
    let state: RelationshipRecord | null = null;
    try {
      if (!row.user_id || !row.char_id) continue;
      const key = await deriveUserEncryptionKey(row.user_id, env.AMSG_MASTER_KEY);
      state = JSON.parse(await decryptFromStorage(row.payload, key)) as RelationshipRecord;
    } catch { continue; }
    const criticalDueBeforeAdvance = isCriticalDue(state, now);
    if (!state.config.enabled && !criticalDueBeforeAdvance) continue;
    // `lastCalculatedAt` 会在前端每次同步时推进，不能拿它节流 Cron；否则打开聊天页
    // 反而会让检查永远达不到 10 分钟。Cron 专用的 lastTickAt 只在本循环成功检查后更新。
    if (!criticalDueBeforeAdvance && state.lastTickAt && now - state.lastTickAt < 10 * 60_000) continue;
    advance(state, now);
    try {
      await reconcilePendingTaskLocks(env, state);
    } catch (error) {
      // 额度耗尽、表暂时不可读时必须保留锁；下一轮恢复后再核对，绝不能冒险双发。
      console.warn('[relationship] pending task reconciliation failed', state.charId, error);
    }
    state.nextThreshold = clamp(state.nextThreshold);
    state.lastTickAt = now;
    const target = Math.max(0, state.config.dailyLimit || 0);
    const minGap = minimumGapMs(state);
    const inactiveEnough = now - Math.max(state.lastUserAt, state.lastAssistantAt) >= minGap;
    const thresholdDue = state.longing >= state.nextThreshold;
    const promiseDue = Boolean((state.config.followUpPromises || isTakeoutPromise(state.promiseKind)) && state.promiseDueAt && now >= state.promiseDueAt);
    // 数字目标的补足仅在自然空档中加速；无限模式严格只看阈值。
    const targetDue = target > 0 && state.dailySent < target && inactiveEnough;
    if (isCriticalDue(state, now)) {
      const result = await schedule(state, 'jealousy-critical');
      if (result.uuid) {
        state.criticalPendingTaskUuid = result.uuid;
        state.jealousyCriticalLatched = true;
        state.criticalRetryAt = undefined;
        state.lastScheduleError = undefined;
        state.lastScheduleErrorAt = undefined;
        scheduled += 1;
      } else {
        state.criticalRetryAt = now + 5 * 60_000;
        state.lastScheduleError = (result.error || '醋意高优先级任务创建没有返回任务 ID。').slice(0, 400);
        state.lastScheduleErrorAt = now;
      }
    } else {
      const canDispatch = canDispatchNow(state, now);
      if (canDispatch && (thresholdDue || targetDue || promiseDue)) {
        const result = await schedule(state, 'normal');
        if (result.uuid) {
          state.pendingTaskUuid = result.uuid;
          state.lastScheduleError = undefined;
          state.lastScheduleErrorAt = undefined;
          state.promiseDueAt = undefined;
          state.promiseKind = undefined;
          scheduled += 1;
        } else {
          state.lastScheduleError = (result.error || '原版主动消息任务创建没有返回任务 ID。').slice(0, 400);
          state.lastScheduleErrorAt = now;
        }
      }
    }
    await save(env, state);
  }
  return { scheduled };
};

/** 原版 fire 确认真正送达/跳过后回写关系账本，避免 pending 锁把后续阈值永久卡住。 */
export const settleRelationshipTask = async (args: { userId: string; charId: string; taskUuid: string; sent: boolean }) => {
  const env = configuredEnv;
  if (!env || !args.userId || !args.charId || !args.taskUuid) return;
  const state = await load(env, args.userId, args.charId);
  if (!state || (state.pendingTaskUuid !== args.taskUuid && state.criticalPendingTaskUuid !== args.taskUuid)) return;
  const now = Date.now();
  advance(state, now);
  const critical = state.criticalPendingTaskUuid === args.taskUuid;
  if (critical) state.criticalPendingTaskUuid = undefined;
  else state.pendingTaskUuid = undefined;
  if (args.sent) {
    if (critical) {
      // 强势联系本身不等于被安抚。醋意只会由之后明确的安抚事实回落。
      await save(env, state);
      return;
    }
    // 只有用户实际收到了角色消息，才视为角色获得一次情绪释放。
    // 以回落后的实时思念值重新设定下一个 +30 阈值，而不是沿用旧阈值累加。
    state.longing = clamp(state.longing - sentRelief(state.config.initiativeStyle));
    state.nextThreshold = clamp(state.longing + 30);
    state.lastDispatchAt = now;
    state.dailySent += 1;
  }
  await save(env, state);
};
