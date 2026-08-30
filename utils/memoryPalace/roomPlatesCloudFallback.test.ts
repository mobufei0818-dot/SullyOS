// utils/memoryPalace/roomPlatesCloudFallback.test.ts
//
// 回归守卫（门牌整理交云端失败之后往哪走）。两件事分开钉：
//
//   1. **交不出去** → 退回本地跑，但送达保证当场并入的那些房间不能丢。丢了的话消化
//      日志会写「这次一块门牌都没动」，而门牌上明明多了几条——本地那条路末尾的兜底
//      并入是按文本去重的，那批已经在里面了，它一条也不会再报。
//
//   2. **没等到答复**（请求发出去了，答复丢在路上）→ 任务可能已经在云端建起来了，
//      这时候绝不能退回本地：那是拿同一份快照烧两次 API，两份结果还先后落地互相盖。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { plateCloudGate, submitPlateConsolidation, readPlateJobInFlight, safeFetchJson } = vi.hoisted(() => ({
  plateCloudGate: vi.fn(async () => 'submit' as string),
  submitPlateConsolidation: vi.fn(async () => ({ jobId: 'job-1', uuid: 'remote-uuid' })),
  readPlateJobInFlight: vi.fn(() => null as { jobId: string; at: number; snapshotAt: number } | null),
  // 本地那条路的 LLM 调用。回一份空列表就够：这里要看的是「本地这条路跑没跑」，
  // 以及跑完之后 updated 里有没有把已经保底并入的房间报出来。
  safeFetchJson: vi.fn(async () => ({ choices: [{ message: { content: '[]' } }] })),
}));

vi.mock('./roomPlateCloud', () => ({ plateCloudGate, submitPlateConsolidation, readPlateJobInFlight }));
vi.mock('../safeApi', () => ({ safeFetchJson }));
// 身份上下文那段拿不到就裸跑（源码里是 try/catch），这里给个空的省得去碰 IndexedDB。
vi.mock('../db', () => ({ DB: { getAllCharacters: async () => [], getUserProfile: async () => null } }));
vi.mock('../context', () => ({ ContextBuilder: { buildCoreContext: () => '' } }));

const savedPlates: Array<{ room: string; entries: Array<{ text: string }> }> = [];
/** 门牌上本来就有的条目（按房间）。默认全空，个别用例拿它模拟「候选已经在门牌上」。 */
const plateSeed: Record<string, Array<{ id: string; text: string; firstLearnedAt: number; updatedAt: number; sourceCount: number }>> = {};
vi.mock('./db', () => {
  const loadOrCreatePlate = vi.fn(async (charId: string, room: string) => ({
    id: `${charId}:${room}`, charId, room, entries: [...(plateSeed[room] ?? [])], updatedAt: 0, version: 0,
  }));
  const save = vi.fn(async (plate: any) => { savedPlates.push(plate); });
  return {
    MemoryNodeDB: { getByCharId: vi.fn(async () => []) },
    RoomPlateDB: { save },
    loadOrCreatePlate,
    // 真身按门牌排队串行；这里只要保住「现读一份 → 改 → 存回去」这三步。
    mutatePlate: vi.fn(async (charId: string, room: string, change: (p: any) => any) => {
      const next = change(await loadOrCreatePlate(charId, room));
      if (!next) return null;
      await save(next);
      return next;
    }),
  };
});

import { consolidateAllPlates } from './roomPlates';

const LLM = { baseUrl: 'https://light.example.dev/v1', apiKey: 'sk-light', model: 'cheap' };
const SUBMISSIONS = { user_room: ['[居住] 小明搬去和同学合租了'] };

const run = () => consolidateAllPlates('c1', '小满', '小明', LLM as any, SUBMISSIONS, 0);

beforeEach(() => {
  savedPlates.length = 0;
  for (const room of Object.keys(plateSeed)) delete plateSeed[room];
  plateCloudGate.mockClear().mockResolvedValue('submit');
  submitPlateConsolidation.mockClear().mockResolvedValue({ jobId: 'job-1', uuid: 'remote-uuid' });
  readPlateJobInFlight.mockClear().mockReturnValue(null);
  safeFetchJson.mockClear();
});

describe('交云端整理之后往哪走', () => {
  it('交出去了 → 报 cloudPending（消化日志才不会说成「一块门牌都没动」）', async () => {
    const result = await run();

    expect(result.cloudPending).toBe(true);
    expect(safeFetchJson, '交出去了就不该在本地再跑一次').not.toHaveBeenCalled();
    // 送达保证是**提交之前**先并进去保底的：云端最终没回来，这批也已经在门牌上了
    expect(result.updated).toContain('user_room');
  });

  // `cloudPending` 问的是「门牌等会儿还会不会动」，不是「这一轮交没交」。上一份还在云端
  // 跑着的时候，答案同样是「会」——它几分钟后就落地。报 false 的话，候选恰好都已经在门牌
  // 上（送达保证按文本去重、一条都没并进去）的那次消化，日志上会写成「⚠️ 本次提交的候选
  // 未合并进门牌（整理未跑成或未被采纳）」，而云端正好好地替我们干着这件事。
  it('上一份还在跑（skip）→ 只做送达保证，不重复交也不退回本地', async () => {
    plateCloudGate.mockResolvedValue('skip');

    const result = await run();

    expect(submitPlateConsolidation).not.toHaveBeenCalled();
    expect(safeFetchJson).not.toHaveBeenCalled();
    expect(result.updated).toContain('user_room');
    expect(result.cloudPending, '云端确实有一份在跑，日志别说成「整理未跑成」').toBe(true);
  });

  // 回归守卫：送达保证按文本去重，候选已经在门牌上时一条都不会并进去——`updated` 于是
  // 是空的。这正是上面那个语义唯一会露馅的场合：报 false 就会被消化日志写成「整理未跑成」。
  it('上一份还在跑、候选又都已经在门牌上 → 照样报「结果在路上」', async () => {
    plateCloudGate.mockResolvedValue('skip');
    // 这条候选门牌上已经有了 → 送达保证按文本去重，一条都并不进去。
    plateSeed.user_room = [{
      id: 'pe_0', text: '小明搬去和同学合租了', firstLearnedAt: 1, updatedAt: 1, sourceCount: 1,
    }];

    const result = await run();

    expect(result.updated).toEqual([]);
    expect(result.cloudPending, '一块门牌没动 + 不说在路上 = 日志报「整理未跑成」').toBe(true);
  });

  // 回归守卫：**没更新 Worker 的用户**走的就是这条。老 bundle 的 /config-check 里没有
  // backgroundJobs 这个字段，探测得到「不支持」→ 这一轮压根不碰云端，原地在本地把整理
  // 跑完，跟上云之前一模一样。这条断了的话，那批用户的门牌会彻底停止更新，而界面上
  // 一片正常——最难发现的那种坏法。副 API 没配、没填 Worker 地址、没开主动消息 2.0
  // 也都落在这个出口。
  it('这台 Worker 不认识后台任务（老 bundle）→ 本地照常跑完，不建云端任务', async () => {
    plateCloudGate.mockResolvedValue('local');

    const result = await run();

    expect(submitPlateConsolidation, '老 worker 会把它当聊天任务跑然后终态失败').not.toHaveBeenCalled();
    expect(safeFetchJson, '不在本地跑的话，这批用户的门牌就永远不更新了').toHaveBeenCalled();
    expect(result.cloudPending, '云端根本没接手，别让日志说结果在路上').toBeFalsy();
    // 本地这条路的老规矩照旧：LLM 没给出有效条目时，本轮候选机械兜底并入，不许蒸发。
    expect(result.updated).toContain('user_room');
  });

  it('服务端答复了「不行」→ 退回本地跑，已经保底并入的房间照样报出来', async () => {
    submitPlateConsolidation.mockRejectedValueOnce(new Error('worker 说不行'));

    const result = await run();

    expect(safeFetchJson, '交不出去就得退回本地把活儿干了，不然门牌永远不更新').toHaveBeenCalled();
    expect(
      result.updated,
      '丢掉的话消化日志会说「一块门牌都没动」，而门牌上明明多了几条',
    ).toContain('user_room');
    expect(result.cloudPending).toBeFalsy();
  });

  // 回归守卫：快照时刻原先是提交那一刻现取的。可门牌是更早读出来的——中间还夹着拼身份
  // 上下文、过「能不能交云端」那几道门（其中一道要发请求）、把消化刚提交的候选先保底并
  // 进去。用户在这一段里改的字 LLM 根本没看到，却因为 updatedAt 早于提交时刻被判成
  // 「LLM 见过」，结果回来把刚敲的字原样盖回去。这里拿那道门模拟这段耗时。
  it('交上去的快照时刻是「读门牌那一刻」，不是提交那一刻', async () => {
    let gateEnteredAt = 0;
    plateCloudGate.mockImplementation(async () => {
      gateEnteredAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'submit';
    });

    await run();

    const { snapshotAt } = (submitPlateConsolidation.mock.calls[0] as unknown as [any])[0];
    expect(snapshotAt).toBeGreaterThan(0);
    expect(snapshotAt, '门牌是在过这几道门之前就读出来的').toBeLessThanOrEqual(gateEnteredAt);
  });

  it('没等到答复（记号还留着）→ 不退回本地，等它回来', async () => {
    submitPlateConsolidation.mockRejectedValueOnce(new Error('Failed to fetch'));
    readPlateJobInFlight.mockReturnValue({ jobId: 'job-1', at: Date.now(), snapshotAt: Date.now() });

    const result = await run();

    expect(
      safeFetchJson,
      '任务可能真在云端跑着，本地再全量跑一遍就是同一份快照烧两次 API、两份结果互相盖',
    ).not.toHaveBeenCalled();
    expect(result.cloudPending).toBe(true);
    expect(result.updated).toContain('user_room');
  });
});
