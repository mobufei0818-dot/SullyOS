import { describe, it, expect } from 'vitest';
import { ChatPrompts } from './chatPrompts';
import { buildGroupHistoryBlock } from './groupChat/prompts';
import type { CharacterProfile, Message } from '../types';

// 钉住「图片值不许当正文进 prompt」这条线。
//
// 背景：图片二进制存在 IndexedDB，字段里只留 `blobref:<id>` 短令牌（~28 字）。发请求时
// utils/apiBlobRefs.ts 会在网络出口把请求体里的令牌还原成完整 data URL——所以令牌一旦混进
// prompt 文本，出门就是几 MB 的 base64，且每轮对话重发一次。长度截断拦不住它（令牌比截断
// 阈值还短），只能在拼 prompt 时就认出来换成占位符。
//
// 下面两类漏点都是真实线上问题：引用回复的摘要，以及没被认领的卡片走 JSON 原文兜底。

const char = { id: 'c1', name: '小角色' } as any;
const userProfile = { name: '我' } as any;

const BLOB_TOKEN = 'blobref:b_abcdef0123456789';
const DATA_URL = 'data:image/jpeg;base64,' + 'A'.repeat(600);

const t0 = Date.now() - 60_000;

/** 用户引用了一条图片消息，然后回了一句话。 */
const replyToMediaMessage = (mediaValue: string): Message[] => ([
    {
        id: 2, charId: 'c1', role: 'user', type: 'text',
        content: '这张图好可爱',
        timestamp: t0 + 1000,
        replyTo: { id: 1, content: mediaValue, name: '小角色' },
    },
] as any[]);

describe('私聊引用回复：被引用的是图片消息', () => {
    it('引用 blobref 令牌图片时，令牌不进 prompt', () => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(
            replyToMediaMessage(BLOB_TOKEN), 10, char, userProfile, [],
        );
        const payload = JSON.stringify(apiMessages);
        expect(payload).not.toContain('blobref:');
        // 用户真正说的那句话必须还在
        expect(payload).toContain('这张图好可爱');
    });

    it('引用 data URL 图片时，base64 不进 prompt', () => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(
            replyToMediaMessage(DATA_URL), 10, char, userProfile, [],
        );
        const payload = JSON.stringify(apiMessages);
        expect(payload).not.toContain('data:image');
        expect(payload).not.toContain('AAAA');
        expect(payload).toContain('这张图好可爱');
    });

    it('引用 http 外链图片时，链接不进 prompt', () => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(
            replyToMediaMessage('https://example.com/pic/very-long-name.png'), 10, char, userProfile, [],
        );
        const payload = JSON.stringify(apiMessages);
        expect(payload).not.toContain('example.com');
    });

    it('引用普通文字消息时仍按原样摘要（不误伤正文）', () => {
        const longText = '这是一段很长的普通文字'.repeat(20);
        const { apiMessages } = ChatPrompts.buildMessageHistory(
            replyToMediaMessage(longText), 10, char, userProfile, [],
        );
        const payload = JSON.stringify(apiMessages);
        expect(payload).toContain('这是一段很长的普通文字');
        expect(payload).toContain('…');
    });
});

describe('群聊引用回复：被引用的是图片消息', () => {
    const chars: CharacterProfile[] = [{ id: 'c1', name: '小夏' } as CharacterProfile];

    const groupReply = (mediaValue: string): Message[] => ([
        {
            id: 2, role: 'user', type: 'text', charId: '',
            content: '哈哈哈这张',
            timestamp: t0 + 1000,
            replyTo: { id: 1, content: mediaValue, name: '小夏' },
        },
    ] as any[]);

    it('引用 blobref 令牌图片时，令牌不进群历史', () => {
        const { text } = buildGroupHistoryBlock(groupReply(BLOB_TOKEN), chars, [], '用户');
        expect(text).not.toContain('blobref:');
        expect(text).toContain('哈哈哈这张');
    });

    it('引用 data URL 图片时，base64 不进群历史', () => {
        const { text } = buildGroupHistoryBlock(groupReply(DATA_URL), chars, [], '用户');
        expect(text).not.toContain('data:image');
        expect(text).not.toContain('AAAA');
        expect(text).toContain('哈哈哈这张');
    });
});

describe('score_card 兜底：没被认领的卡片', () => {
    // 认不出类型的活动卡（比如 520 活动卡）会掉进 [系统卡片] 兜底分支。
    // 它的 JSON 里 charAvatar 就在最前面，值是令牌。
    const unknownCard = {
        type: 'anniv520_card',
        version: 1,
        charAvatar: BLOB_TOKEN,
        userAvatar: 'blobref:b_9876543210fedcba',
        title: '520 心动瞬间',
        score: 88,
    };

    const cardMessage = (overrides: Record<string, any> = {}): Message[] => ([
        {
            id: 1, charId: 'c1', role: 'assistant', type: 'score_card',
            content: JSON.stringify(unknownCard),
            timestamp: t0,
            metadata: { scoreCard: unknownCard },
            ...overrides,
        },
    ] as any[]);

    it('metadata.scoreCard 里的图片令牌不进 prompt', () => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(cardMessage(), 10, char, userProfile, []);
        const payload = JSON.stringify(apiMessages);
        expect(payload).not.toContain('blobref:');
        expect(payload).toContain('[系统卡片]');
        // 卡片里的正常字段还要留着，兜底不能退化成一句空占位
        expect(payload).toContain('520 心动瞬间');
    });

    it('只有 content JSON（没有 metadata.scoreCard）时同样不漏令牌', () => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(
            cardMessage({ metadata: {} }), 10, char, userProfile, [],
        );
        const payload = JSON.stringify(apiMessages);
        expect(payload).not.toContain('blobref:');
        expect(payload).toContain('[系统卡片]');
    });

    it('卡片里带 data URL 头像时也剥掉', () => {
        const dataCard = { ...unknownCard, charAvatar: DATA_URL };
        const { apiMessages } = ChatPrompts.buildMessageHistory(
            cardMessage({ content: JSON.stringify(dataCard), metadata: { scoreCard: dataCard } }),
            10, char, userProfile, [],
        );
        const payload = JSON.stringify(apiMessages);
        expect(payload).not.toContain('data:image');
        expect(payload).not.toContain('AAAA');
    });
});
