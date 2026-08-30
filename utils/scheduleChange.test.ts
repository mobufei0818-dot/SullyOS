import { describe, expect, it } from 'vitest';
import type { DailySchedule } from '../types';
import { applyAssistantScheduleChanges, applyScheduleChanges, extractScheduleChangeDirectives } from './scheduleChange';
import { DB } from './db';

const schedule: DailySchedule = {
    id: 'char-1_2026-08-15',
    charId: 'char-1',
    date: '2026-08-15',
    generatedAt: new Date(2026, 7, 15, 8).getTime(),
    slots: [
        { startTime: '08:00', activity: '起床', location: '家' },
        { startTime: '14:00', activity: '写稿', description: '完成第三章', innerThought: '别再拖稿了' },
        { startTime: '18:30', activity: '健身', location: '健身房', theater: { generatedAt: 1, lines: [{ text: '跑步' }] } },
        { startTime: '22:00', activity: '看电影' },
    ],
    flowNarrative: { afternoon: '晚上还得去健身。' },
};

const at = (hour: number, minute = 0) => new Date(2026, 7, 15, hour, minute);

describe('extractScheduleChangeDirectives', () => {
    it('识别规范格式并把控制标签从聊天正文隐藏', () => {
        const result = extractScheduleChangeDirectives('那今晚就不练啦。\n[[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]]');
        expect(result.cleanedText).toBe('那今晚就不练啦。');
        expect(result.directives).toEqual([{ startTime: '18:30', activity: '去超市' }]);
        expect(result.malformedCount).toBe(0);
    });

    it.each([
        '【【修改日程：18:30：去超市】】',
        '[[change schedule: (18:30): 去超市]]',
        '【change schedue：（18：30）：去超市】',
        '【【修改日程：18点30分：去超市】】',
        'change_schedule：18时30分：去超市',
        '[[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]',
        '[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]]',
        '[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]',
        '[[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市',
        'ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]]',
        'ACTION:CHANGE_SCHEDULE | 18:30 | 去超市',
    ])('容错括号、标点、中文别名与 schedue 拼写：%s', (raw) => {
        const result = extractScheduleChangeDirectives(raw);
        expect(result.cleanedText).toBe('');
        expect(result.directives).toEqual([{ startTime: '18:30', activity: '去超市' }]);
    });

    // push 路径上这个标签不是原样送到客户端的：worker classifier 把它摘成
    // change_schedule directive（不摘的话会被 sanitize 连 raw 一起剥掉），客户端再由
    // reconstructDirectiveTags 拼回标签交给这里解析。拼回来的是**不带空格**的形态，
    // 跟提示词里教的规范写法差一层空格——这条钉住那个往返，别哪天正则收紧就断了。
    it('客户端把 worker directive 拼回的无空格形态解析得动', () => {
        const result = extractScheduleChangeDirectives('[[ACTION:CHANGE_SCHEDULE|22:00|陪你聊天]]');
        expect(result.directives).toEqual([{ startTime: '22:00', activity: '陪你聊天' }]);
        expect(result.cleanedText).toBe('');
    });

    it('无法确定时段时只隐藏控制标签并记为 malformed，不猜测目标', () => {
        const result = extractScheduleChangeDirectives('好。\n[[ACTION:CHANGE_SCHEDULE | 晚一点 | 去超市]]');
        expect(result.cleanedText).toBe('好。');
        expect(result.directives).toEqual([]);
        expect(result.malformedCount).toBe(1);
    });

    // 无括号那一层只从行首起算。这几条是它的边界：说到「改日程」三个字的大白话必须
    // 原样留在正文里，既不能凭空多出一条日程改动，也不能把后半句吃掉。这份解析跑在
    // 每一条模型输出上，误判一次的代价是全局的。
    describe('大白话提到「改日程」不算指令', () => {
        it.each([
            ['好，我改日程：22点陪你聊天', []],
            ['那我把今天的安排改一下，改日程 22:00 陪你', []],
            ['I will change schedule tomorrow, ok?', []],
            ['刚才说要修改日程的事，我再想想', []],
        ])('%s → 正文原样保留，不产生指令', (raw) => {
            const result = extractScheduleChangeDirectives(raw as string);
            expect(result.cleanedText).toBe(raw);
            expect(result.directives).toEqual([]);
            expect(result.malformedCount).toBe(0);
        });

        // 清洗（剥标签留下的空行、去首尾空白）只在真剥掉了东西时才发生。没认出标签
        // 还照样清洗的话，每一条普通回复都会被顺手改一遍格式。
        it('没认出日程标签时连空行和尾随空格都不动', () => {
            const raw = '第一段。\n\n\n第二段。   \n';
            const result = extractScheduleChangeDirectives(raw);
            expect(result.cleanedText).toBe(raw);
            expect(result.directives).toEqual([]);
            expect(result.malformedCount).toBe(0);
        });

        // 这条是取舍本身，不是漏洞：跟在正文后面的**裸**标签（一个括号都没打）就此
        // 不再识别。要认它就得允许无括号那一层从行中起算，而那一层一旦不锚行首，上面
        // 那几条大白话会被从「改日程」一路吃到行尾——既凭空造出一条改动，又把用户看到
        // 的正文截断。漏认一条要靠猜才认得出的指令，比误改一条日程 + 吞掉半句话便宜。
        // 规范写法有括号兜底，走上面那一层，不受影响。
        it('裸标签跟在正文同一行时不识别，正文一个字都不动', () => {
            const raw = '那今晚不睡了陪你。ACTION:CHANGE_SCHEDULE | 22:00 | 陪你聊天';
            const result = extractScheduleChangeDirectives(raw);
            expect(result.cleanedText).toBe(raw);
            expect(result.directives).toEqual([]);
            expect(result.malformedCount).toBe(0);
        });

        it('前半句是正文、后半句才是标签时，标签仍走带括号那一层，正文不被吞', () => {
            const result = extractScheduleChangeDirectives('那今晚不练了 [[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]]');
            expect(result.cleanedText).toBe('那今晚不练了');
            expect(result.directives).toEqual([{ startTime: '18:30', activity: '去超市' }]);
        });
    });

    // 反向守卫：锚行首不能把「独占一行、只是漏了括号」这类真指令一起收紧掉。
    it.each([
        'ACTION:CHANGE_SCHEDULE | 18:30 | 去超市',
        '  [[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]]',
        '\t修改日程：18:30：去超市',
    ])('行首（含缩进）的无括号 / 漏括号指令照旧识别：%s', (raw) => {
        const result = extractScheduleChangeDirectives(raw);
        expect(result.directives).toEqual([{ startTime: '18:30', activity: '去超市' }]);
    });

    it('多行里第二行才是指令时，前一行正文完整保留', () => {
        const result = extractScheduleChangeDirectives('今晚有别的安排。\nACTION:CHANGE_SCHEDULE | 18:30 | 去超市');
        expect(result.cleanedText).toBe('今晚有别的安排。');
        expect(result.directives).toEqual([{ startTime: '18:30', activity: '去超市' }]);
    });
});

describe('applyScheduleChanges', () => {
    it('只改未来已有时段，并清掉围绕旧活动生成的冲突信息', () => {
        const result = applyScheduleChanges(
            schedule,
            [{ startTime: '18:30', activity: '去超市' }],
            null,
            at(14, 5),
        );
        expect(result.changes).toEqual([{ startTime: '18:30', before: '健身', after: '去超市' }]);
        expect(result.schedule.slots[2]).toEqual({ startTime: '18:30', activity: '去超市' });
        expect(result.schedule.flowNarrative).toBeUndefined();
        expect(schedule.slots[2].activity).toBe('健身');
    });

    it('拒绝已经过去的时段和表里不存在的时段', () => {
        const result = applyScheduleChanges(schedule, [
            { startTime: '08:00', activity: '睡懒觉' },
            { startTime: '19:00', activity: '散步' },
        ], null, at(14));
        expect(result.changes).toEqual([]);
        expect(result.rejectedCount).toBe(2);
        expect(result.schedule).toBe(schedule);
    });

    // 夜里最后一条日程通常是睡觉，人却还在聊天。当前这一条要是也改不了，角色读到的
    // 「你正在睡觉」就永远撤不下来，每轮都被它推着去道晚安。
    it('当前正在进行的那一条可以改', () => {
        const result = applyScheduleChanges(
            schedule,
            [{ startTime: '14:00', activity: '陪对方聊天' }],
            null,
            at(15, 20),
        );
        expect(result.changes).toEqual([{ startTime: '14:00', before: '写稿', after: '陪对方聊天' }]);
        expect(result.schedule.slots[1]).toEqual({ startTime: '14:00', activity: '陪对方聊天' });
    });

    it('放开当前时段没有顺带放开更早的：同一轮里改早上会被单独拒掉', () => {
        const result = applyScheduleChanges(schedule, [
            { startTime: '08:00', activity: '睡懒觉' },
            { startTime: '14:00', activity: '陪对方聊天' },
        ], null, at(15));
        expect(result.changes).toEqual([{ startTime: '14:00', before: '写稿', after: '陪对方聊天' }]);
        expect(result.rejectedCount).toBe(1);
        expect(result.schedule.slots[0].activity).toBe('起床');
    });

    it('凌晨还没轮到今天第一条时没有当前时段，整张表都算未来、照常能改', () => {
        const result = applyScheduleChanges(
            schedule,
            [{ startTime: '08:00', activity: '睡懒觉' }],
            null,
            at(3),
        );
        expect(result.changes).toEqual([{ startTime: '08:00', before: '起床', after: '睡懒觉' }]);
        expect(result.rejectedCount).toBe(0);
    });

    it('同一时段重复输出时折叠为“最初计划 → 最终计划”', () => {
        const result = applyScheduleChanges(schedule, [
            { startTime: '22:00', activity: '看书' },
            { startTime: '22:00', activity: '早点睡' },
        ], null, at(18));
        expect(result.changes).toEqual([{ startTime: '22:00', before: '看电影', after: '早点睡' }]);
        expect(result.schedule.slots[3].activity).toBe('早点睡');
    });

    // 「当前是第几条」跟日程卡 / 首页小组件用同一个函数，落点也从当前时段起找。一张表里
    // 万一有两条一样的 startTime，要改的是还没过去的那条。
    it('同一个 startTime 出现两次时，改的是当前时段那条', () => {
        const dup: DailySchedule = {
            ...schedule,
            slots: [
                { startTime: '08:00', activity: '起床' },
                { startTime: '22:00', activity: '早先那条' },
                { startTime: '22:00', activity: '当前这条' },
            ],
        };
        const result = applyScheduleChanges(dup, [{ startTime: '22:00', activity: '陪你聊天' }], null, at(22, 30));
        expect(result.schedule.slots[1].activity).toBe('早先那条');
        expect(result.schedule.slots[2].activity).toBe('陪你聊天');
        expect(result.rejectedCount).toBe(0);
    });
});

// 主动消息把「说出口」和「落库」拉开了距离：一条 push 可能在收件箱里躺一夜，用户第二天
// 早上才打开 App。按处理那一刻判的话，昨晚那句「22:00 改成陪你聊天」会落到**今天**的
// 22:00 上——角色昨晚的一句话，改了今天的安排。调用方传 push 的 sentAt，隔天整批丢弃。
describe('applyAssistantScheduleChanges — 按说出口那一刻判，不是按处理那一刻', () => {
    const char = { id: 'char-overnight' } as any;
    const tag = '[[ACTION:CHANGE_SCHEDULE | 22:00 | 陪你聊天]]';

    /** 今天这张表（日期 key 跟着「今天」走，测试不依赖固定日期）。 */
    const todaySchedule = () => {
        const now = new Date();
        const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        return {
            id: `${char.id}_${key}`,
            charId: char.id,
            date: key,
            generatedAt: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8).getTime(),
            slots: [
                { startTime: '08:00', activity: '起床' },
                { startTime: '22:00', activity: '睡觉' },
            ],
        };
    };

    /** 昨天那张表（用户昨天用过 App 就会留着）。 */
    const yesterdaySchedule = () => {
        const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return {
            id: `${char.id}_${key}`,
            charId: char.id,
            date: key,
            generatedAt: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 8).getTime(),
            slots: [
                { startTime: '08:00', activity: '起床' },
                { startTime: '22:00', activity: '睡觉' },
            ],
        };
    };

    // 关键在于「昨天那张表还在库里」：没有日历日门槛的话，昨晚说出口的改动会照着
    // 昨天的日期 key 取到那张表并改写它——改一张已经翻篇的表，白写一次库；而真正
    // 危险的是调用方压根不传时刻（旧行为），那时它取的是**今天**的表，昨晚的一句话
    // 会盖掉今天晚上的安排。门槛把这两种都堵掉：隔天的整批不落库。
    it('昨晚说出口的改动隔天已经没有落点 → 整批丢弃，两天的表都不动', async () => {
        await DB.saveDailySchedule(todaySchedule() as any);
        await DB.saveDailySchedule(yesterdaySchedule() as any);
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const result = await applyAssistantScheduleChanges(tag, char, yesterday);

        expect(result.changes).toEqual([]);
        expect(result.rejectedCount).toBe(1);
        // 标签仍然从正文里摘掉（不能漏给用户看）
        expect(result.cleanedText).toBe('');
        const storedYesterday = await DB.getDailySchedule(char.id, yesterdaySchedule().date);
        expect(storedYesterday?.slots[1].activity).toBe('睡觉');
        const storedToday = await DB.getDailySchedule(char.id, todaySchedule().date);
        expect(storedToday?.slots[1].activity).toBe('睡觉');
    });

    it('同一天说出口的照常落库', async () => {
        await DB.saveDailySchedule(todaySchedule() as any);
        // 23:30 说的：22:00 那条是「当前正在进行」，可以改
        const spokenAt = new Date();
        spokenAt.setHours(23, 30, 0, 0);

        const result = await applyAssistantScheduleChanges(tag, char, spokenAt);

        expect(result.changes).toEqual([{ startTime: '22:00', before: '睡觉', after: '陪你聊天' }]);
        const stored = await DB.getDailySchedule(char.id, todaySchedule().date);
        expect(stored?.slots[1].activity).toBe('陪你聊天');
    });
});

