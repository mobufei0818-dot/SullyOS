import { describe, it, expect, vi } from 'vitest';

// 角色关掉「时间感知强化」后，日程块曾经照旧写着「当前时段：22:00 你正在睡觉」——
// 精确钟点从这条缝里漏了出去，而挡住它正是那个开关存在的意义。
// 天气块早就按 includeTime 处理过同一件事（天气照给、只抽掉时间行），日程这条补齐。
// 日程本身不受这个开关影响：它有自己的总开关。

vi.mock('./dailySchedule', () => ({
    getDailyScheduleForChar: vi.fn(async () => ({
        id: 'char-clock_2026-08-19',
        charId: 'char-clock',
        date: '2026-08-19',
        generatedAt: Date.now(),
        slots: [
            { startTime: '00:00', activity: '睡觉', location: '家' },
            { startTime: '23:30', activity: '看剧' },
        ],
    })),
}));

import { ChatPrompts } from './chatPrompts';

const userProfile = { name: '小明' } as any;

const buildVolatile = async (timeAwarenessEnabled: boolean | undefined) => {
    const char = {
        id: 'char-clock',
        name: '阿一',
        scheduleFeatureEnabled: true,
        ...(timeAwarenessEnabled === undefined ? {} : { timeAwarenessEnabled }),
    } as any;
    const parts = await ChatPrompts.buildSystemPromptParts(
        char, userProfile, [], [], [], [],
        undefined, undefined, undefined, undefined, undefined, undefined,
        undefined,
    );
    return parts.volatileState;
};

describe('日程块的钟点跟着「时间感知」开关走', () => {
    it('开着（默认）时照常报时段', async () => {
        const volatile = await buildVolatile(undefined);
        expect(volatile).toContain('当前时段：00:00 你正在睡觉');
        expect(volatile).toContain('- 23:30 看剧');
    });

    it('关掉后活动还在，但钟点整个消失', async () => {
        const volatile = await buildVolatile(false);
        expect(volatile).toContain('你正在睡觉');
        expect(volatile).toContain('看剧');
        expect(volatile).not.toContain('00:00');
        expect(volatile).not.toContain('23:30');
    });

    it('关掉后也不教改日程——那条指令拿时段当定位符', async () => {
        const volatile = await buildVolatile(false);
        expect(volatile).not.toContain('CHANGE_SCHEDULE');
    });
});
