// utils/amsg2ExpireGuard.test.ts
import { describe, it, expect } from 'vitest';
import {
  ACTIVE_CHAT_WINDOW_MS,
  FIRE_GRACE_MS,
  detectExpiredOccurrences,
  getLastRealUserMessageAt,
  hasDeliveredProactiveNear,
  hasRealUserMessageBetween,
  shouldExpireFire,
} from './amsg2ExpireGuard';

const H = 3600_000;
const user = (timestamp: number, proactiveHint = false) => ({
  role: 'user', timestamp, metadata: proactiveHint ? { proactiveHint: true } : undefined,
});
const assistantPush = (timestamp: number, taskId: string | null = 't1') => ({
  role: 'assistant', timestamp, metadata: { source: 'active_msg_2', activeMsg2: { taskId } },
});

describe('shouldExpireFire', () => {
  // 一次性和循环共用同一条规则：到点前后十分钟内用户在不在聊天。窗口锚在触发时刻，
  // 所以任务排了多久都不影响——早先一次性任务走的是「排完之后用户再开过口就作废」的
  // 锚点规则，它没有时间窗，跨夜任务几乎必然被误杀（角色半夜说「明早叫你」，用户回
  // 一句「晚安」，第二天的早安就没了）。「这事是不是已经聊过了」交给角色自己判，
  // 见 amsg2ExpireGuard.ts 文件头。
  const base = { policy: 'expire', nowMs: 10 * 60_000, occurrenceMs: 10 * 60_000 };

  it('到点前窗口内在聊 → 作废；窗口外聊过 → 放行', () => {
    expect(shouldExpireFire({ ...base, lastUserMessageAt: 10 * 60_000 - ACTIVE_CHAT_WINDOW_MS + 1 })).toBe(true);
    expect(shouldExpireFire({ ...base, lastUserMessageAt: 10 * 60_000 - ACTIVE_CHAT_WINDOW_MS - 1 })).toBe(false);
  });

  // 线上事故的最小复现，钉死不许回退：角色半夜排的「明早九点半叫你」，用户回过话，
  // 第二天早上照发。这条一挂就说明锚点规则又被加回来了。
  it('跨夜任务照发：八小时前排的，中间用户开过口，到点时早就不在聊了', () => {
    const occurrenceMs = 9 * H;
    expect(shouldExpireFire({
      policy: 'expire',
      lastUserMessageAt: H + 60_000,   // 排完任务之后回了句「晚安」
      occurrenceMs,
      nowMs: occurrenceMs,
    })).toBe(false);
  });

  it('热聊窗口锚在到点时刻，判定晚十几分钟也不放行（worker 与客户端送达兜底同一口径）', () => {
    // 到点 24h，客户端送达兜底在 15 分钟后才判：窗口仍是到点前后各十分钟，
    // 拿 nowMs 当锚点的话这条 9 分钟前的用户消息会落到窗外被误放行。
    const late = { policy: 'expire', occurrenceMs: 24 * H, nowMs: 24 * H + 15 * 60_000 };
    expect(shouldExpireFire({ ...late, lastUserMessageAt: 24 * H - 9 * 60_000 })).toBe(true);
    expect(shouldExpireFire({ ...late, lastUserMessageAt: 24 * H - 11 * 60_000 })).toBe(false);
  });

  // 窗口的**右**边界也必须锚在到点时刻。右界拿 nowMs 的话，窗口在晚判定的路径上会一路
  // 撑成 (到点-10min, 现在]：推送晚送达、或者 48h 补收把消息捞回来时，用户到点之后随便
  // 哪个时刻开过一次口，这条定时消息就被吞掉 + 销账 + 撤掉云端自述日志。更糟的是排程
  // 现状块用的是对称窗 (到点±10min]，它查不到这次吞没，作废回执整段失联——角色既没说
  // 那句话，也不知道自己那条排程已经没了。
  it('到点两小时后才开的口，晚判定时也不算热聊（右界跟检出侧的对称窗一致）', () => {
    const occurrenceMs = 9 * H;
    expect(shouldExpireFire({
      policy: 'expire',
      lastUserMessageAt: 11 * H,       // 到点两小时后随口说了句话
      occurrenceMs,
      nowMs: 14 * H,                   // 五小时后补收才把这条消息捞回来判定
    })).toBe(false);
  });

  it('到点后五分钟内开的口照旧算热聊（对称窗的右半边没被改坏）', () => {
    const occurrenceMs = 9 * H;
    expect(shouldExpireFire({
      policy: 'expire',
      lastUserMessageAt: occurrenceMs + 5 * 60_000,
      occurrenceMs,
      nowMs: 14 * H,
    })).toBe(true);
  });

  it('到点之后才开的口不算（那是消息发出去之后用户回的话）', () => {
    expect(shouldExpireFire({
      policy: 'expire', occurrenceMs: 10 * 60_000, nowMs: 10 * 60_000, lastUserMessageAt: 10 * 60_000 + 1,
    })).toBe(false);
  });

  it('force / 未知策略 / 旧任务无策略 → 永远放行', () => {
    expect(shouldExpireFire({ ...base, policy: 'force', lastUserMessageAt: 10 * 60_000 - 1 })).toBe(false);
    expect(shouldExpireFire({ ...base, policy: undefined, lastUserMessageAt: 10 * 60_000 - 1 })).toBe(false);
  });

  // 缺数据 = 判不了 = 放行。这道闸只挡它能确定的那一档，剩下的交给角色自己判。
  it('缺触发时刻 / 一条用户消息都没有 → 放行', () => {
    expect(shouldExpireFire({ ...base, occurrenceMs: undefined, lastUserMessageAt: 10 * 60_000 - 1 })).toBe(false);
    expect(shouldExpireFire({ ...base, lastUserMessageAt: null })).toBe(false);
  });
});

describe('消息扫描 helpers', () => {
  it('getLastRealUserMessageAt 跳过 proactiveHint 和 assistant', () => {
    expect(getLastRealUserMessageAt([user(1), assistantPush(2), user(3, true)])).toBe(1);
    expect(getLastRealUserMessageAt([assistantPush(2)])).toBe(null);
  });
  it('hasRealUserMessageBetween 是 (after, before] 半开区间', () => {
    const msgs = [user(100), user(200)];
    expect(hasRealUserMessageBetween(msgs, 100, 200)).toBe(true);
    expect(hasRealUserMessageBetween(msgs, 200, 300)).toBe(false);
  });
  it('hasDeliveredProactiveNear 只认 taskId 非空的 active_msg_2 消息', () => {
    const withCid = (taskId: string | null) => ({
      role: 'assistant', timestamp: 1000,
      metadata: { source: 'active_msg_2', activeMsg2: { taskId }, amsgClientTaskId: 'cid-A' },
    });
    expect(hasDeliveredProactiveNear([withCid('t1')], 1000, 'cid-A')).toBe(true);
    expect(hasDeliveredProactiveNear([withCid(null)], 1000, 'cid-A')).toBe(false); // instant 回复不算
  });
  it('hasDeliveredProactiveNear 按精确 id 归属：id 不同或缺 id 都不算本任务的送达', () => {
    const withCid = { role: 'assistant', timestamp: 1000, metadata: { source: 'active_msg_2', activeMsg2: { taskId: 't1' }, amsgClientTaskId: 'cid-A' } };
    expect(hasDeliveredProactiveNear([withCid], 1000, 'cid-A')).toBe(true);
    expect(hasDeliveredProactiveNear([withCid], 1000, 'cid-B')).toBe(false); // A 的送达不能抹掉 B 的回执
    expect(hasDeliveredProactiveNear([assistantPush(1000)], 1000, 'cid-A')).toBe(false); // 缺 amsgClientTaskId 的消息不是本任务的送达
  });
});

describe('detectExpiredOccurrences（排程现状块的作废检出）', () => {
  const NOW = 100 * H;

  // 检出口径必须跟闸本身一模一样（见 shouldExpireFire）：这里说「作废了」而闸其实
  // 放行了的话，角色会为一条用户明明收到的消息道歉，比不说还糟。
  it('一次性：到点前后窗口内在聊 → 检出；窗口外聊过 → 不检出', () => {
    const fireAt = NOW - 2 * H;
    const base = {
      taskUuid: 'u1', policy: 'expire', recurrenceType: 'none',
      firstSendTime: new Date(fireAt).toISOString(), nowMs: NOW,
    };
    expect(detectExpiredOccurrences({ ...base, messages: [user(fireAt - 60_000)] }))
      .toEqual([{ id: 'u1', occurrenceMs: fireAt }]);
    // 到点之后一会儿开的口也算：Cron 可能晚几分钟才 fire，对称窗把这一段盖住。
    // 「其实已正常送达」的排除由调用方用 hasDeliveredProactiveNear 按任务归属做。
    expect(detectExpiredOccurrences({ ...base, messages: [user(fireAt + 60_000)] }))
      .toEqual([{ id: 'u1', occurrenceMs: fireAt }]);
    // 五小时前聊过的不算——早先的锚点规则会把这一条判成作废，正是跨夜误杀的来源。
    expect(detectExpiredOccurrences({ ...base, messages: [user(fireAt - 5 * H)] })).toEqual([]);
  });
  it('循环：只检出「到点前窗口内在聊」的那几次，id 带 occurrence 时间戳', () => {
    const first = NOW - 30 * H;
    const o2 = first + 24 * H;
    const out = detectExpiredOccurrences({
      taskUuid: 'u1', policy: 'expire', recurrenceType: 'daily',
      firstSendTime: new Date(first).toISOString(),
      messages: [user(o2 - 60_000)], nowMs: NOW,
    });
    expect(out).toEqual([{ id: `u1:${o2}`, occurrenceMs: o2 }]);
  });
  it('循环 weekly：周期 7 天，快进到回看期后只检出到点前窗口内在聊的那次', () => {
    const first = NOW - 8 * 24 * H;
    const o2 = first + 7 * 24 * H;
    const out = detectExpiredOccurrences({
      taskUuid: 'w1', policy: 'expire', recurrenceType: 'weekly',
      firstSendTime: new Date(first).toISOString(),
      messages: [user(o2 - 60_000)], nowMs: NOW,
    });
    expect(out).toEqual([{ id: `w1:${o2}`, occurrenceMs: o2 }]);
  });
  it('未来的任务 / force 策略 → 空', () => {
    expect(detectExpiredOccurrences({
      taskUuid: 'u1', policy: 'expire', recurrenceType: 'none',
      firstSendTime: new Date(NOW + H).toISOString(),
      messages: [user(NOW - 1)], nowMs: NOW,
    })).toEqual([]);
    expect(detectExpiredOccurrences({
      taskUuid: 'u1', policy: 'force', recurrenceType: 'none',
      firstSendTime: new Date(NOW - H).toISOString(),
      messages: [user(NOW - 1)], nowMs: NOW,
    })).toEqual([]);
  });
});
