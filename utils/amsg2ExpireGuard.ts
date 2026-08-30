// utils/amsg2ExpireGuard.ts
/**
 * amsg2 防穿帮闸 — 纯判定逻辑。
 *
 * ⚠️ 叶子模块：会被 worker/amsg 打进 Cloudflare bundle，同时被客户端送达兜底
 * （activeMsgRuntime）与排程现状块（amsg2TaskContext）复用——不得 import
 * 浏览器 / DB / React 依赖（与 utils/agenticTools.ts 同一约束）。
 *
 * 语义（设计：claude-notes/2026-07-21-amsg2-liveness-design.md「防穿帮闸」）：
 *   - expire（默认）：到点那会儿用户正在聊天 → 作废，转「排程现状块」告知；
 *   - force：闹钟型，照发。
 *
 * 这道闸只判一件确定的事：**到点前后 ACTIVE_CHAT_WINDOW_MS 内，用户在不在聊天**。
 * 一次性任务和循环任务同一条规则，窗口都锚在触发时刻，两边都锚——左右界都是触发时刻
 * 加减这个窗宽，跟排程现状块的检出（detectExpiredOccurrences）用的是同一个对称窗。
 *
 * 「这件事是不是已经聊过了」不归它管——那是语义问题，判据在角色自己手上（提示词里
 * 那段「开口之前」：已经发生过的事就一个字都不要输出，走 worker 的 skip-push 出口）。
 * 早先这里对一次性任务用的是锚点规则「排完任务之后用户只要再开过一次口就作废」，
 * 它没有时间窗，跨夜任务几乎必然中招：角色半夜说「明早九点半叫你起床」，用户回一句
 * 「晚安」，第二天的早安就被判死。锚在触发时刻的窗口没有这个毛病，任务排了多久都不影响。
 */

export type AmsgExpirePolicy = 'expire' | 'force';

/** 「正在聊天」窗口：触发时刻前后 10 分钟内有真实用户消息就算热聊。 */
export const ACTIVE_CHAT_WINDOW_MS = 10 * 60_000;

/** 触发时刻附近的推理/送达宽限（fire 后 10-30s 才送达，判定窗口向后放这么多）。 */
export const FIRE_GRACE_MS = 90_000;

/** 排程现状块只回看这么久内的触发时刻，太老的不再提。 */
const DEFAULT_LOOKBACK_MS = 48 * 3600_000;

const DAY_MS = 24 * 3600_000;

/** 循环任务两次触发之间隔多久；一次性任务没有周期，返回 null。 */
export const recurrencePeriodMs = (recurrenceType: string | undefined): number | null =>
  recurrenceType === 'daily' ? DAY_MS
    : recurrenceType === 'weekly' ? 7 * DAY_MS
      : null;

export interface ExpireFireInput {
  policy: string | undefined;
  /** 判定时刻已知的最后一条真实用户消息时间戳。 */
  lastUserMessageAt: number | null | undefined;
  nowMs: number;
  /**
   * 本次触发时刻。「正在聊天」窗口锚定它而不是 nowMs——生成+送达可能比到点晚十几分钟，
   * 拿判定时刻算 10 分钟窗会把撞上对话的消息误放行。worker 在到点当时判定（两者几乎
   * 相等），客户端送达兜底则晚得多，所以必须显式给。
   */
  occurrenceMs: number | null | undefined;
}

/**
 * fire 时刻该不该作废这次触发。worker onBeforeFire（数据来自 fire_pack /
 * task metadata）与客户端送达兜底（数据来自本地历史 / push metadata）共用，
 * 一次性和循环任务同一条规则：到点前后十分钟内用户在不在聊天。
 *
 * 判不了（缺策略 / 缺触发时刻 / 一条用户消息都没有）一律放行——这道闸只挡它能确定的
 * 那一档，剩下的交给角色自己在提示词里判（见文件头）。
 */
export function shouldExpireFire(input: ExpireFireInput): boolean {
  if (input.policy !== 'expire') return false;
  // 缺触发时刻就算不出窗口，放行。客户端送达兜底闸会碰上（老版本 SW 落的收件箱行
  // 没有这个顶层字段）；worker 侧走不到，occurrenceMs 由 onBeforeFire 校验过。
  if (input.occurrenceMs == null) return false;
  const last = input.lastUserMessageAt;
  if (last == null) return false;
  // 两边都锚在触发时刻，跟 detectExpiredOccurrences 的对称窗同一个口径。
  // 右界要是拿 nowMs：worker 在到点当时判（now≈到点）看不出差别，客户端送达兜底 /
  // 48h 补收却是 now=Date.now()，窗口会一路撑成 (到点-10min, 现在]——用户到点之后
  // 随便哪个时刻开过一次口，晚送到的定时消息就被吞掉、销账、连云端自述日志一起撤销，
  // 而检出那边用对称窗根本查不到这次吞没，作废回执整段失联。
  return last > input.occurrenceMs - ACTIVE_CHAT_WINDOW_MS
    && last <= input.occurrenceMs + ACTIVE_CHAT_WINDOW_MS
    // last 是过去的消息时间戳，这条理论上恒真；留着挡时钟歪掉时冒出来的未来时间戳。
    && last <= input.nowMs;
}

export interface RealUserMessageLike {
  role: string;
  timestamp: number;
  metadata?: Record<string, unknown> | null;
}

/** 「真实用户消息」定义与 activeMsgClient.buildTimeGapHint 保持一致。 */
const isRealUserMessage = (m: RealUserMessageLike): boolean =>
  m.role === 'user' && !(m.metadata as { proactiveHint?: unknown } | null | undefined)?.proactiveHint;

export function getLastRealUserMessageAt(messages: RealUserMessageLike[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRealUserMessage(messages[i])) return messages[i].timestamp;
  }
  return null;
}

/** (afterMs, beforeMs] 内是否有真实用户消息。 */
export function hasRealUserMessageBetween(
  messages: RealUserMessageLike[],
  afterMs: number,
  beforeMs: number,
): boolean {
  return messages.some((m) =>
    isRealUserMessage(m) && m.timestamp > afterMs && m.timestamp <= beforeMs);
}

/** 送达判定的回看窗：触发时刻之后这么久内的消息才算这次触发的产物。 */
const DELIVERED_WINDOW_MS = 30 * 60_000;

/**
 * 某个触发时刻附近是否真的送达过定时主动消息（区分「作废了」和「发出去之后
 * 用户才回复」）。定时任务的落库消息带 metadata.activeMsg2.taskId（非空）；
 * instant 聊天回复的 taskId 是 null，不算。
 *
 * 按精确 id 归属：任务的送达一定带同源 amsgClientTaskId，id 不同或缺 id 的消息都不算
 * 本任务的送达——否则会拿别的任务的送达当证据、误抹掉本任务的作废回执。
 */
export function hasDeliveredProactiveNear(
  messages: RealUserMessageLike[],
  occurrenceMs: number,
  clientTaskId: string,
): boolean {
  return messages.some((m) => {
    if (m.role !== 'assistant') return false;
    const meta = m.metadata as { activeMsg2?: { taskId?: unknown }; amsgClientTaskId?: unknown } | null | undefined;
    if (meta?.activeMsg2?.taskId == null) return false;
    if (meta.amsgClientTaskId !== clientTaskId) return false;
    return m.timestamp >= occurrenceMs - FIRE_GRACE_MS && m.timestamp <= occurrenceMs + DELIVERED_WINDOW_MS;
  });
}

export interface ExpiredNoticeCandidate {
  /** 一次性 = taskUuid；循环 = `${taskUuid}:${occurrenceMs}`。 */
  id: string;
  occurrenceMs: number;
}

export interface DetectExpiredInput {
  taskUuid: string;
  policy: string | undefined;
  recurrenceType: string | undefined;
  /** ISO 字符串，任务首次触发时间。 */
  firstSendTime: string;
  messages: RealUserMessageLike[];
  nowMs: number;
  lookbackMs?: number;
}

/**
 * 排程现状块的作废检出：回看期内哪些触发时刻满足作废条件。调用方需另用
 * hasDeliveredProactiveNear 排除实际送达过的（这里不做，方便单测各管一半）。
 */
export function detectExpiredOccurrences(input: DetectExpiredInput): ExpiredNoticeCandidate[] {
  if (input.policy !== 'expire') return [];
  const first = new Date(input.firstSendTime).getTime();
  if (!Number.isFinite(first)) return [];
  const horizon = input.nowMs - (input.lookbackMs ?? DEFAULT_LOOKBACK_MS);

  const periodMs = recurrencePeriodMs(input.recurrenceType);
  if (periodMs === null) {
    if (first > input.nowMs || first < horizon) return [];
    // 跟循环那支同一个对称窗，因为闸本身已经是同一条规则了（见 shouldExpireFire）。
    // 两边必须一致：这里说「作废了」而闸其实放行了的话，角色会为一条用户明明收到的
    // 消息道歉——比不说还糟。
    // 「其实已正常送达」由调用方用 hasDeliveredProactiveNear 按任务归属排除。
    if (!hasRealUserMessageBetween(
      input.messages, first - ACTIVE_CHAT_WINDOW_MS, first + ACTIVE_CHAT_WINDOW_MS,
    )) return [];
    return [{ id: input.taskUuid, occurrenceMs: first }];
  }

  // 快进到回看期起点，别从几个月前逐个迭代。
  let t = first;
  if (t < horizon) t = first + Math.ceil((horizon - first) / periodMs) * periodMs;
  const out: ExpiredNoticeCandidate[] = [];
  for (; t <= input.nowMs; t += periodMs) {
    // 「到点前后都在聊」的对称窗：覆盖 fire 略晚于到点的 Cron 延迟场景。
    if (hasRealUserMessageBetween(input.messages, t - ACTIVE_CHAT_WINDOW_MS, t + ACTIVE_CHAT_WINDOW_MS)) {
      out.push({ id: `${input.taskUuid}:${t}`, occurrenceMs: t });
    }
  }
  return out;
}
