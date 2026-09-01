import { describe, expect, it } from 'vitest';
import { buildPhoneEvidenceChatCard, normalizePhoneEvidence, phoneFieldToText } from './phoneEvidence';

describe('phone evidence safety', () => {
    it('把 LLM 返回的对象字段转成可读文本，而不是 React 对象子节点', () => {
        const value = phoneFieldToText({ tags: ['悬疑', '连载'], reading_progress: 42 });
        expect(value).toBe('tags: 悬疑\n连载\nreading_progress: 42');
    });

    it('处理数组、空值和循环引用时不会抛错', () => {
        const cyclic: any = { excerpt: '片段' };
        cyclic.self = cyclic;
        expect(phoneFieldToText(cyclic)).toContain('self: [循环引用]');
        expect(phoneFieldToText(null, '缺省')).toBe('缺省');
    });

    it('能修复已经存进 phoneState 的旧记录供 UI 安全渲染', () => {
        const record = normalizePhoneEvidence({
            id: 'bad-record',
            type: 'novel',
            title: { chapter: '第一章' },
            detail: ['第一段', '第二段'],
            value: { reading_progress: '70%' },
            timestamp: 1,
        } as any);
        expect(record.title).toBe('chapter: 第一章');
        expect(record.detail).toBe('第一段\n第二段');
        expect(record.value).toBe('reading_progress: 70%');
    });

    it('事后同步复用首次生成时的 phone_card 内容和元数据', () => {
        const card = buildPhoneEvidenceChatCard({
            id: 'record-1',
            type: 'novel',
            title: '第三章 夜航',
            detail: '她把没发出去的话藏进草稿箱。',
            value: '1.2万字',
            timestamp: 1,
        }, '阅读');
        expect(card.content).toBe('[你手机的阅读] 第三章 夜航 · 1.2万字 — 她把没发出去的话藏进草稿箱。');
        expect(card.metadata.phoneCard).toMatchObject({ app: '阅读', kind: 'novel', title: '第三章 夜航' });
    });
});
