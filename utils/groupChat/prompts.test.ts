import { describe, it, expect } from 'vitest';
import {
    buildDirectorInstruction,
    buildGroupHistoryBlock,
    buildRoundRobinInstruction,
    GROUP_HISTORY_GAP_THRESHOLD_MS,
} from './prompts';
import type { Message, CharacterProfile } from '../../types';

const char = (id: string, name: string): CharacterProfile => ({ id, name } as CharacterProfile);

const msg = (id: number, role: Message['role'], content: string, timestamp: number, charId = ''): Message =>
    ({ id, role, type: 'text', content, timestamp, charId } as Message);

describe('buildGroupHistoryBlock 时间跳变分隔行', () => {
    const chars = [char('c1', '小夏')];
    const base = Date.UTC(2026, 6, 1, 12, 0, 0);

    it('相邻消息隔得久时插一条"隔了约 N 天"的分隔行', () => {
        const msgs: Message[] = [
            msg(1, 'assistant', '在吗', base, 'c1'),
            // 3 天后用户回来发一句
            msg(2, 'user', '我回来了', base + 3 * 24 * 60 * 60 * 1000),
        ];
        const { text } = buildGroupHistoryBlock(msgs, chars, [], '用户');
        expect(text).toContain('约 3 天');
        expect(text).toContain('中间群里没人说话');
        // 分隔行应夹在两条消息之间
        expect(text.indexOf('小夏: 在吗')).toBeLessThan(text.indexOf('约 3 天'));
        expect(text.indexOf('约 3 天')).toBeLessThan(text.indexOf('用户: 我回来了'));
    });

    it('间隔在阈值以内不插分隔行', () => {
        const msgs: Message[] = [
            msg(1, 'assistant', '早', base, 'c1'),
            msg(2, 'user', '早呀', base + 60 * 1000),
        ];
        const { text } = buildGroupHistoryBlock(msgs, chars, [], '用户');
        expect(text).not.toContain('中间群里没人说话');
        expect(text).toContain('小夏: 早');
        expect(text).toMatch(/\[(?:刚刚|约 .+前)\] 小夏: 早/);
        expect(text).toContain('用户: 早呀');
    });

    it('阈值常量为 3 小时', () => {
        expect(GROUP_HISTORY_GAP_THRESHOLD_MS).toBe(3 * 60 * 60 * 1000);
    });
});

describe('buildGroupHistoryBlock 识图 API', () => {
    it('接入时使用文字描述，不再附带 image_url 原图', () => {
        const image = {
            ...msg(10, 'user', 'data:image/jpeg;base64,AAAA', Date.now()),
            type: 'image' as const,
            metadata: { visionDescription: '三个人在海边举着写有生日快乐的横幅。' },
        };
        const history = buildGroupHistoryBlock(
            [image],
            [char('c1', '小夏')],
            [],
            '用户',
            3,
            { useVisionDescriptions: true },
        );

        expect(history.text).toContain('[图片：三个人在海边举着写有生日快乐的横幅。]');
        expect(history.attachedImages).toEqual([]);
        expect(history.attachedImagesNote).toBe('');
        expect(history.text).not.toContain('data:image');
    });
});

describe('群聊中的 U 与关系连续性', () => {
    const history = { text: '用户: 今天大家聊什么？', attachedImages: [], attachedImagesNote: '' };

    it('导演模式坚持群像，但不会因切换场景重置角色与 U 的关系', () => {
        const prompt = buildDirectorInstruction(history, '无');

        expect(prompt).toContain('群像优先，不等于忽视用户');
        expect(prompt).toContain('U 还是 U');
        expect(prompt).toContain('关系不能因场景切换而重置');
        expect(prompt).toContain('不要自动全员跟队');
        expect(prompt).toContain('不要让所有人重复同一种态度');
    });

    it('轮询模式允许自然沉默，并要求成员从自己与 U 的关系出发', () => {
        const prompt = buildRoundRobinInstruction('小夏', history, '无');

        expect(prompt).toContain('只输出 `[[SKIP]]` 保持沉默');
        expect(prompt).toContain('U 还是 U');
        expect(prompt).toContain('不能因进入群聊就重置关系');
        expect(prompt).toContain('按你自己和 U 的关系反应');
    });
});
