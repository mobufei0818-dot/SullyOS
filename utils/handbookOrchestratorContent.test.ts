import { describe, it, expect, vi, afterEach } from 'vitest';
import { todayChatLines } from './handbookOrchestrator';
import { DB } from './db';
import { getLocalDateKey, getLocalDayRange } from './localDate';

// 手账 v2 拼「今天聊了什么」时，每条消息都会被塞进给模型的提示词。
//
// 这里历来是 `content.slice(0, 200)` 的裸截断。图片改存 `blobref:<id>` 令牌（~28 字）之后
// 这道截断就拦不住了：整个令牌能完好通过 200 字，卡片 JSON 里的 charAvatar 也就排在开头
// 几十字的位置。到网络出口（utils/apiBlobRefs.ts）令牌会被还原成整张 base64，
// 于是每轮请求都白发一张头像。
//
// 正确姿势是先过 normalizeMessageContent：卡片压成一行摘要，图片/表情换成占位符。

const CHAR = { id: 'c1', name: '小角色' } as any;
const USER = '小明';

const DATE = getLocalDateKey(new Date());
const { start } = getLocalDayRange(DATE)!;

const BLOB_TOKEN = 'blobref:b_0123456789abcdef';

/** 交换日记卡：content 是整段 JSON，charAvatar 排在最前面几十字里。 */
const DIARY_CARD_JSON = JSON.stringify({
    type: 'diary_card',
    charAvatar: BLOB_TOKEN,
    date: DATE,
    userName: USER,
    userText: '今天去看了海',
    charText: '下次一起去',
});

const MESSAGES = [
    { id: 1, charId: 'c1', role: 'user', type: 'text', content: '今天去看海啦', timestamp: start + 1_000 },
    { id: 2, charId: 'c1', role: 'assistant', type: 'score_card', content: DIARY_CARD_JSON, timestamp: start + 2_000 },
    { id: 3, charId: 'c1', role: 'user', type: 'image', content: BLOB_TOKEN, timestamp: start + 3_000 },
    { id: 4, charId: 'c1', role: 'user', type: 'emoji', content: BLOB_TOKEN, timestamp: start + 4_000 },
];

afterEach(() => vi.restoreAllMocks());

const collect = async (): Promise<string> => {
    vi.spyOn(DB, 'getMessagesByCharId').mockResolvedValue(MESSAGES as any);
    const { lines } = await todayChatLines(CHAR, DATE, USER);
    return lines.join('\n');
};

describe('手账 v2「今天聊了什么」不泄漏图片值', () => {
    it('整段文本里出现不了 blobref 令牌', async () => {
        const text = await collect();
        expect(text).not.toContain('blobref:');
    });

    it('图片 / 表情消息压成占位符', async () => {
        const text = await collect();
        expect(text).toContain(`${USER}: [图片]`);
        expect(text).toContain(`${USER}: [表情包]`);
    });

    it('卡片翻成一行摘要，而不是 dump 原始 JSON', async () => {
        const text = await collect();
        expect(text).toContain('[交换日记');
        expect(text).toContain('今天去看了海');
        expect(text).not.toContain('"charAvatar"');
    });

    it('普通文字消息原样保留', async () => {
        const text = await collect();
        expect(text).toContain(`${USER}: 今天去看海啦`);
    });
});
