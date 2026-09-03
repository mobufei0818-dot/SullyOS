import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMomentsRuntimeActors, getMomentsWorkerDiagnostics, hasPendingMomentsSyncWork, isD1DailyLimitError, outboxToSyncPayload } from './momentsSync';

afterEach(() => vi.unstubAllGlobals());

const outbox = Array.from({ length: 230 }, (_, index) => ({
  id: `event-${index}`, type: 'post' as const, payload: { postId: `post-${index}` }, createdAt: index, retryCount: 0,
}));
const jobs = Array.from({ length: 230 }, (_, index) => ({
  id: `job-${index}`, type: 'interaction' as const, postId: `post-${index}`, dueAt: index, state: 'pending' as const, createdAt: index,
}));

describe('朋友圈 Worker 同步分批契约', () => {
  it('每类 payload 最多 200 条，超出的 outbox 不能被误认为已发送', () => {
    const payload = outboxToSyncPayload(outbox, jobs, 'user-a');
    expect(payload.events).toHaveLength(200);
    expect(payload.tasks).toHaveLength(200);
    expect(payload.events.map(item => item.id)).toEqual(outbox.slice(0, 200).map(item => item.id));
    expect(payload.tasks.map(item => item.id)).toEqual(jobs.slice(0, 200).map(item => item.id));
  });

  it('互动 outbox 会占用任务批次，不会让一批超过 200 条', () => {
    const delayed = Array.from({ length: 30 }, (_, index) => ({
      id: `delayed-${index}`, type: 'interaction' as const, payload: { dueAt: index + 1, postId: `post-${index}` }, createdAt: index, retryCount: 0,
    }));
    const payload = outboxToSyncPayload(delayed, jobs, 'user-a');
    expect(payload.events).toHaveLength(0);
    expect(payload.tasks).toHaveLength(200);
    expect(payload.tasks.slice(-30).map(item => item.id)).toEqual(delayed.map(item => item.id));
  });

  it('能区分 D1 日额度历史错误和其它同步失败', () => {
    expect(isD1DailyLimitError("D1_ERROR: Your account has exceeded D1's free tier daily row read limit.")).toBe(true);
    expect(isD1DailyLimitError('Worker HTTP 500: upstream timeout')).toBe(false);
  });

  it('无 outbox 且无 pending 任务时视为无待同步内容', () => {
    expect(hasPendingMomentsSyncWork([], [])).toBe(false);
    expect(hasPendingMomentsSyncWork([], [{ ...jobs[0], state: 'done' }])).toBe(false);
    expect(hasPendingMomentsSyncWork([], [jobs[0]])).toBe(true);
    expect(hasPendingMomentsSyncWork([outbox[0]], [])).toBe(true);
  });

  it('诊断会把角色运行表状态转换成可核对的排程信息', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      counts: [{ state: 'pending', count: 2 }],
      diagnostics: [],
      runtimeActors: [{
        actorId: 'moments:character:a', actorType: 'character', displayName: '角色甲', postingMode: 'high',
        enabled: 1, lastDecisionAt: null, nextDecisionAt: 1788408000000, lastPostAt: null, failureCount: 0, updatedAt: 1788400000000,
      }],
    }), { status: 200 })));

    const result = await getMomentsWorkerDiagnostics({ url: 'https://worker.example' }, 'user-a');
    expect(result.counts.pending).toBe(2);
    expect(result.runtimeActors).toEqual([expect.objectContaining({
      actorId: 'moments:character:a', displayName: '角色甲', postingMode: 'high', enabled: true,
      nextDecisionAt: 1788408000000, failureCount: 0,
    })]);
    expect(result.runtimeActors?.[0].lastDecisionAt).toBeUndefined();
  });

  it('启动恢复只读取轻量角色运行表接口', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      runtimeActors: [{
        actorId: 'moments:npc:b', actorType: 'npc', displayName: '路人乙', postingMode: 'low',
        enabled: 1, nextDecisionAt: 1788409000000, failureCount: 0, updatedAt: 1788400000000,
      }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getMomentsRuntimeActors({ url: 'https://worker.example/' }, 'user-b');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://worker.example/moments/runtime-status?userId=user-b',
      expect.any(Object),
    );
    expect(result).toEqual([expect.objectContaining({
      actorId: 'moments:npc:b', postingMode: 'low', enabled: true, nextDecisionAt: 1788409000000,
    })]);
  });
});
