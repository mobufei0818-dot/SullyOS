/**
 * 关系主动消息层：独立于 amsg-server 的任务表，只保存「何时值得创建一条原版任务」。
 *
 * 内容生成、推送、收件箱、取消与失败重试仍完全交给原版 amsg-server；本模块绝不直接
 * 伪造聊天消息。D1 中的 payload 以用户派生密钥加密，避免把关系状态明文留库。
 */
import { decryptFromStorage, deriveUserEncryptionKey, encryptForStorage } from '@rei-standard/amsg-server/cloudflare';
import { constantTimeEqual } from './instantChat';

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
}

interface RelationshipRecord {
  v: 1;
  userId: string;
  charId: string;
  charName: string;
  tzId: string;
  credRef: string;
  config: RelationshipConfigWire;
  longing: number;
  nextThreshold: number;
  affection: number;
  jealousy: number;
  innerVoice: string;
  lastCalculatedAt: number;
  lastUserAt: number;
  lastAssistantAt: number;
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
}

export interface RelationshipSyncInput {
  charId: string;
  charName: string;
  tzId: string;
  credRef?: string;
  config: RelationshipConfigWire;
  /** 首次启用时前端按已有聊天/人设给出的合理估值，不是固定从 0 开始。 */
  initialLonging?: number;
  lastUserAt?: number;
  lastAssistantAt?: number;
  /** 只传关系方向，不上传聊天正文。 */
  userSignal?: 'neutral' | 'affectionate' | 'distant';
  affection?: number;
  jealousy?: number;
  innerVoice?: string;
  promise?: { dueAt: number; kind: string };
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
const canDispatchNow = (state: RelationshipRecord, now: number) => !state.pendingTaskUuid
  && now - state.lastDispatchAt >= minimumGapMs(state)
  && !inQuietHours(now, state.config, state.tzId);

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
  const shouldCheckImmediately = record.config.enabled && canDispatchNow(record, now)
    && (record.longing >= record.nextThreshold
      || Boolean((record.config.followUpPromises || isTakeoutPromise(record.promiseKind)) && record.promiseDueAt && record.promiseDueAt <= now));
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
  if (!state.config.enabled) return '关系主动消息已关闭。';
  if (state.pendingTaskUuid) return '已有一条关系任务正在等待原版主动消息 2.0 结算。';
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
    lastDispatchAt: state.lastDispatchAt || undefined,
    lastTickAt: state.lastTickAt,
    nextTickAt: state.nextTickAt,
    lastScheduleError: state.lastScheduleError,
    lastScheduleErrorAt: state.lastScheduleErrorAt,
    status: dispatchStatus(state),
  },
});

const advance = (state: RelationshipRecord, now: number) => {
  const date = dayKey(now, state.tzId);
  if (state.dailyDate !== date) { state.dailyDate = date; state.dailySent = 0; }
  const elapsed = Math.max(0, now - state.lastCalculatedAt);
  state.longing = clamp(state.longing + elapsed * ratePerMs(state.config.initiativeStyle));
  state.lastCalculatedAt = now;
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

export const syncRelationshipState = async (env: RelationshipEngineEnv, userId: string, input: RelationshipSyncInput) => {
  const now = Date.now();
  let state = await load(env, userId, input.charId);
  if (!state) {
    state = {
      v: 1, userId, charId: input.charId, charName: input.charName, tzId: input.tzId || 'UTC',
      credRef: input.credRef || `char:${input.charId}/chat`, config: input.config,
      longing: clamp(input.initialLonging ?? 20), nextThreshold: 30,
      affection: clamp(input.affection ?? 58), jealousy: clamp(input.jealousy ?? 8),
      innerVoice: String(input.innerVoice || '把想说的话先悄悄留在心里。'),
      lastCalculatedAt: now, lastUserAt: input.lastUserAt || 0, lastAssistantAt: input.lastAssistantAt || 0,
      lastDispatchAt: 0, dailyDate: dayKey(now, input.tzId || 'UTC'), dailySent: 0,
      ...((input.config.followUpPromises || isTakeoutPromise(input.promise?.kind)) && input.promise && input.promise.dueAt > now
        ? { promiseDueAt: input.promise.dueAt, promiseKind: input.promise.kind }
        : {}),
    };
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
    if (typeof input.affection === 'number') state.affection = clamp(input.affection);
    if (typeof input.jealousy === 'number') state.jealousy = clamp(input.jealousy);
    if (typeof input.innerVoice === 'string' && input.innerVoice.trim()) state.innerVoice = input.innerVoice.trim();
    if ((input.config.followUpPromises || isTakeoutPromise(input.promise?.kind)) && input.promise && input.promise.dueAt > now && input.promise.dueAt - now < 3 * 60 * 60_000) {
      state.promiseDueAt = input.promise.dueAt;
      state.promiseKind = input.promise.kind;
    }
  }
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
export const handleRelationshipRequest = async (request: Request, env: RelationshipEngineEnv): Promise<Response | null> => {
  const url = new URL(request.url);
  if (!url.pathname.endsWith('/relationship/state')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, X-Client-Token' } });
  const userId = await verify(request, env);
  if (!userId) return response(401, { success: false, error: { code: 'RELATIONSHIP_AUTH_REQUIRED', message: '关系层需要有效的用户标识和共享密钥。' } });
  if (request.method === 'GET') {
    const charId = url.searchParams.get('charId') || '';
    const state = charId ? await load(env, userId, charId) : null;
    return response(200, { success: true, data: state ? publicState(state) : null });
  }
  if (request.method !== 'POST') return response(405, { success: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 GET 或 POST' } });
  try {
    const input = await request.json() as RelationshipSyncInput;
    if (!input?.charId || !input?.config) return response(400, { success: false, error: { code: 'INVALID_RELATIONSHIP_STATE', message: '缺少角色或关系配置。' } });
    return response(200, { success: true, data: await syncRelationshipState(env, userId, input) });
  } catch (error) {
    return response(400, { success: false, error: { code: 'RELATIONSHIP_STATE_FAILED', message: error instanceof Error ? error.message : '关系状态保存失败。' } });
  }
};

/**
 * Cron 只推进分数并挑出可派发对象。真正的原版任务由 index.ts 注入的 schedule 回调创建。
 */
export const runRelationshipTick = async (env: RelationshipEngineEnv, schedule: (state: RelationshipRecord) => Promise<{ uuid?: string; error?: string }>) => {
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
    if (!state.config.enabled) continue;
    // `lastCalculatedAt` 会在前端每次同步时推进，不能拿它节流 Cron；否则打开聊天页
    // 反而会让检查永远达不到 10 分钟。Cron 专用的 lastTickAt 只在本循环成功检查后更新。
    if (state.lastTickAt && now - state.lastTickAt < 10 * 60_000) continue;
    advance(state, now);
    state.lastTickAt = now;
    const target = Math.max(0, state.config.dailyLimit || 0);
    const minGap = minimumGapMs(state);
    const inactiveEnough = now - Math.max(state.lastUserAt, state.lastAssistantAt) >= minGap;
    const thresholdDue = state.longing >= state.nextThreshold;
    const promiseDue = Boolean((state.config.followUpPromises || isTakeoutPromise(state.promiseKind)) && state.promiseDueAt && now >= state.promiseDueAt);
    // 数字目标的补足仅在自然空档中加速；无限模式严格只看阈值。
    const targetDue = target > 0 && state.dailySent < target && inactiveEnough;
    const canDispatch = canDispatchNow(state, now);
    if (canDispatch && (thresholdDue || targetDue || promiseDue)) {
      const result = await schedule(state);
      if (result.uuid) {
        state.pendingTaskUuid = result.uuid;
        state.lastDispatchAt = now;
        state.lastScheduleError = undefined;
        state.lastScheduleErrorAt = undefined;
        state.nextThreshold = Math.max(state.nextThreshold + 30, state.longing + 30);
        state.promiseDueAt = undefined;
        state.promiseKind = undefined;
        scheduled += 1;
      } else {
        state.lastScheduleError = (result.error || '原版主动消息任务创建没有返回任务 ID。').slice(0, 400);
        state.lastScheduleErrorAt = now;
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
  if (!state || state.pendingTaskUuid !== args.taskUuid) return;
  advance(state, Date.now());
  state.pendingTaskUuid = undefined;
  if (args.sent) state.dailySent += 1;
  await save(env, state);
};
