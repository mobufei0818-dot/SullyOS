import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DB, openDB } from './db';

// fake-indexeddb 已由 test-setup.ts 注入。
//
// 这组用例钉住 db.ts 里几个写函数的「落盘可感知」：IndexedDB 的 put 失败（最常见的
// QuotaExceededError，iOS Safari 快满时天天见）走的是 error 事件 → 事务 abort，
// 而不是同步抛异常。谁要是发完 put 就 resolve，调用方拿到的永远是「保存成功」，
// 库里却什么都没写进去——「一键优化」就是这么报出「已转 N 张、释放约 X」，
// 而表行其实还是 base64、转出来的 Blob 全成了孤儿。
//
// 正确写法见同文件的 saveAsset：等 transaction.oncomplete 再 resolve，
// onerror / onabort 一律 reject。

const DB_SOURCE = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');

// 被 review 点名的六个写函数：以前都是「发完 put 就 resolve」
const DURABLE_WRITERS = [
    'updateMessage',
    'saveEmoji',
    'saveTheme',
    'saveGalleryImage',
    'saveCustomCreatorPart',
    'saveSong',
] as const;

const originalPut = IDBObjectStore.prototype.put;

/**
 * 造一次「put 失败」。
 *
 * fake-indexeddb 造不出真的配额不足，但配额不足的最终形态就是事务被 abort，
 * 所以这里直接在 put 被调用的瞬间掐掉它所属的事务，等价于真机上的
 * QuotaExceededError → abort。只掐指定的表，别把测试自己的准备工作也带崩。
 */
function abortOnPut(storeName: string) {
    return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: any[]) {
        if (this.name === storeName) {
            this.transaction.abort();
            // 事务已经没了，返回值没人会去监听，给个占位壳即可
            return { onsuccess: null, onerror: null } as unknown as IDBRequest;
        }
        return (originalPut as any).apply(this, args);
    });
}

async function clearStore(name: string): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        tx.objectStore(name).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

beforeEach(async () => {
    // 先把库打开，免得 openDB 的建表流程撞上后面装的 put 拦截
    await openDB();
    for (const s of ['messages', 'emojis', 'themes', 'gallery', 'cc_custom_parts', 'songs']) {
        await clearStore(s);
    }
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('写入失败必须让调用方感知（不再静默 resolve）', () => {
    // 五个「一句 put 了事」的保存函数，写法一致，用表格跑
    const cases: { name: string; store: string; run: () => Promise<void> }[] = [
        {
            name: 'saveEmoji',
            store: 'emojis',
            run: () => DB.saveEmoji('表情A', 'data:image/png;base64,AQID', 'default'),
        },
        {
            name: 'saveTheme',
            store: 'themes',
            run: () => DB.saveTheme({ id: 'theme-1', name: '测试主题' } as any),
        },
        {
            name: 'saveGalleryImage',
            store: 'gallery',
            run: () => DB.saveGalleryImage({ id: 'g-1', charId: 'c-1', url: 'data:image/png;base64,AQID', timestamp: 1 } as any),
        },
        {
            name: 'saveCustomCreatorPart',
            store: 'cc_custom_parts',
            run: () => DB.saveCustomCreatorPart({ id: 'part-1', createdAt: 1 } as any),
        },
        {
            name: 'saveSong',
            store: 'songs',
            run: () => DB.saveSong({ id: 'song-1', title: '测试' } as any),
        },
    ];

    for (const c of cases) {
        it(`${c.name}: put 失败（事务 abort）时 reject，而不是假装成功`, async () => {
            abortOnPut(c.store);
            await expect(c.run()).rejects.toBeTruthy();
        });
    }

    it('updateMessage: put 失败（事务 abort）时 reject，而不是假装改写成功', async () => {
        const id = await DB.saveMessage({ charId: 'c-1', role: 'user', content: '原文' } as any);
        abortOnPut('messages');
        await expect(DB.updateMessage(id, '改写后')).rejects.toBeTruthy();
    });

    it('updateMessage: 消息不存在时照旧 reject', async () => {
        await expect(DB.updateMessage(99999, '随便')).rejects.toThrow('Message not found');
    });
});

describe('写入成功时行为不变', () => {
    it('saveEmoji resolve 之后，数据已经能读到', async () => {
        await DB.saveEmoji('表情B', 'data:image/png;base64,BAUG');
        const all = await DB.getEmojis();
        expect(all.map(e => e.name)).toContain('表情B');
    });

    it('updateMessage resolve 之后，改写已经落库', async () => {
        const id = await DB.saveMessage({ charId: 'c-2', role: 'assistant', content: '旧内容' } as any);
        await DB.updateMessage(id, '新内容');
        const msgs = await DB.getMessagesByCharId('c-2');
        expect(msgs.find(m => m.id === id)?.content).toBe('新内容');
    });
});

describe('源码锚点：六个写函数都得等事务完成', () => {
    /** 截出 DB 里某个成员函数的源码（从签名到那一行 `  },`） */
    function sliceMember(name: string): string {
        const start = DB_SOURCE.indexOf(`\n  ${name}: async (`);
        expect(start, `db.ts 里找不到 ${name}`).toBeGreaterThan(-1);
        const end = DB_SOURCE.indexOf('\n  },', start);
        expect(end, `${name} 的函数体没找到结尾`).toBeGreaterThan(start);
        return DB_SOURCE.slice(start, end);
    }

    for (const name of DURABLE_WRITERS) {
        it(`${name} 挂了 oncomplete / onerror / onabort`, () => {
            const body = sliceMember(name);
            expect(body).toMatch(/\.oncomplete\s*=/);
            expect(body).toMatch(/\.onerror\s*=/);
            expect(body).toMatch(/\.onabort\s*=/);
        });
    }
});
