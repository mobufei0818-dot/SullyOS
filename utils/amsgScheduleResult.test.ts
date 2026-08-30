import { describe, expect, it } from 'vitest';
import { buildScheduleChangeResult, parseScheduleChangeResult, SCHEDULE_CHANGE_RESULT_KIND } from './amsgScheduleResult';

// 这条结果是 worker 写、客户端读的跨端形状。形状对不上时必须返回 null——客户端据此
// 销账丢弃，而不是拿着半份数据去改用户的日程表。
describe('schedule-change 结果的往返', () => {
    it('组出来的结果读得回去', () => {
        const built = buildScheduleChangeResult({
            charId: 'char-1',
            spokenAt: 1755600000000,
            directives: [{ startTime: '22:00', activity: '陪你聊天' }],
        });
        expect(built.resultKind).toBe(SCHEDULE_CHANGE_RESULT_KIND);
        expect(parseScheduleChangeResult(built)).toEqual(built);
    });

    it.each([
        ['不是对象', 'nope'],
        ['resultKind 对不上', { resultKind: 'other', v: 1, charId: 'c', spokenAt: 1, directives: [{ startTime: '22:00', activity: 'x' }] }],
        ['版本对不上', { resultKind: SCHEDULE_CHANGE_RESULT_KIND, v: 2, charId: 'c', spokenAt: 1, directives: [{ startTime: '22:00', activity: 'x' }] }],
        ['没有 charId', { resultKind: SCHEDULE_CHANGE_RESULT_KIND, v: 1, spokenAt: 1, directives: [{ startTime: '22:00', activity: 'x' }] }],
        ['spokenAt 不是数字', { resultKind: SCHEDULE_CHANGE_RESULT_KIND, v: 1, charId: 'c', spokenAt: '昨晚', directives: [{ startTime: '22:00', activity: 'x' }] }],
        ['一条有效指令都没有', { resultKind: SCHEDULE_CHANGE_RESULT_KIND, v: 1, charId: 'c', spokenAt: 1, directives: [{ startTime: '', activity: '' }] }],
    ])('%s → null', (_label, raw) => {
        expect(parseScheduleChangeResult(raw)).toBeNull();
    });

    it('混着坏条目时只留下能用的那些', () => {
        const parsed = parseScheduleChangeResult({
            resultKind: SCHEDULE_CHANGE_RESULT_KIND,
            v: 1,
            charId: 'char-1',
            spokenAt: 1755600000000,
            directives: [
                { startTime: '22:00', activity: '陪你聊天' },
                { startTime: '23:00' },
                null,
                { startTime: '  ', activity: '空的' },
            ],
        });
        expect(parsed?.directives).toEqual([{ startTime: '22:00', activity: '陪你聊天' }]);
    });
});
