// utils/memoryPalace/plateMutex.test.ts
//
// 回归守卫（门牌的「读一份 → 改 → 整块存回去」必须排队）。
//
// 门牌是整块对象存回去的形状，而动它的路有四条，彼此完全不知道对方存在：云端整理结果
// 落地、本地整理落库、送达保证兜底并入、门牌面板上用户手改。任意两条撞在一起就是后写
// 的把先写的整块盖掉——用户刚敲的字没了，或者一整轮整理的成果没了，而两边日志都显示
// 成功。各自在自己那条路里排队是不够的（面板原先就是这么做的），队伍必须是**按门牌**
// 的一条，所有路共用。
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 假门牌库：底层是 IndexedDB，node 上没有。排队逻辑（本文件要测的）原样跑真身。 */
const store = new Map<string, any>();

describe('mutatePlate — 同一块门牌上的改动排队走', () => {
  let mutatePlate: typeof import('./db').mutatePlate;
  let RoomPlateDB: typeof import('./db').RoomPlateDB;

  beforeEach(async () => {
    vi.resetModules();
    store.clear();
    const db = await import('./db');
    mutatePlate = db.mutatePlate;
    RoomPlateDB = db.RoomPlateDB;
    // 读写换成内存版 + 一拍延迟：不延迟的话两条路根本撞不上，测试永远绿。
    vi.spyOn(RoomPlateDB, 'get').mockImplementation(async (charId, room) => {
      await new Promise((r) => setTimeout(r, 5));
      return store.get(`${charId}:${room}`);
    });
    vi.spyOn(RoomPlateDB, 'save').mockImplementation(async (plate) => {
      await new Promise((r) => setTimeout(r, 5));
      store.set(plate.id, plate);
    });
  });

  // 这条是整件事的意义所在：两条路同时改一块门牌会怎样。
  it('两条路同时改同一块门牌 → 一前一后，谁的改动都不会被整块盖掉', async () => {
    store.set('c1:user_room', {
      id: 'c1:user_room', charId: 'c1', room: 'user_room',
      entries: [{ id: 'e0', text: '原有', firstLearnedAt: 1, updatedAt: 1, sourceCount: 1 }],
      updatedAt: 1, version: 1,
    });

    // 一条是「云端整理结果落地」，一条是「用户在面板上手改」。谁先谁后不重要，
    // 重要的是后跑那条**看得见**先跑那条的结果。
    await Promise.all([
      mutatePlate('c1', 'user_room', (p) => ({
        ...p, entries: [...p.entries, { id: 'e1', text: '云端整理加的', firstLearnedAt: 2, updatedAt: 2, sourceCount: 1 }],
        version: p.version + 1,
      })),
      mutatePlate('c1', 'user_room', (p) => ({
        ...p, entries: [...p.entries, { id: 'e2', text: '用户手改加的', firstLearnedAt: 2, updatedAt: 2, sourceCount: 1 }],
        version: p.version + 1,
      })),
    ]);

    const final = store.get('c1:user_room');
    expect(final.entries.map((e: any) => e.id).sort(), '并发就是后写的整块盖掉先写的').toEqual(['e0', 'e1', 'e2']);
    expect(final.version, '版本号两次都要跳').toBe(3);
  });

  // 不同门牌之间没有任何共享状态，排在一起只是白白变慢。
  it('不同门牌各排各的，不互相堵', async () => {
    const order: string[] = [];
    await Promise.all([
      mutatePlate('c1', 'user_room', (p) => { order.push('a'); return { ...p, version: p.version + 1 }; }),
      mutatePlate('c1', 'study', (p) => { order.push('b'); return { ...p, version: p.version + 1 }; }),
    ]);
    expect(order).toHaveLength(2);
    expect(store.has('c1:user_room')).toBe(true);
    expect(store.has('c1:study')).toBe(true);
  });

  it('change 回 null（不用改）→ 不落库，也不占着队不放', async () => {
    const saved = await mutatePlate('c1', 'user_room', () => null);

    expect(saved).toBeNull();
    expect(RoomPlateDB.save).not.toHaveBeenCalled();
    // 后面的照常排得上
    await expect(mutatePlate('c1', 'user_room', (p) => ({ ...p, version: 9 }))).resolves.toMatchObject({ version: 9 });
  });

  // 一次落库失败不能把这块门牌的队伍掐断——后面每一次都排不上的话，整理结果和用户的
  // 手改会一起卡死，而卡住的原因（一次 IDB 抖动）早就过去了。
  it('一次落库炸了 → 照常抛给调用方，但不把后面的堵死', async () => {
    vi.mocked(RoomPlateDB.save).mockRejectedValueOnce(new Error('IDB 配额满了'));

    await expect(mutatePlate('c1', 'user_room', (p) => ({ ...p, version: 1 }))).rejects.toThrow('IDB 配额满了');
    await expect(mutatePlate('c1', 'user_room', (p) => ({ ...p, version: 2 }))).resolves.toMatchObject({ version: 2 });
  });
});
