// 日程注入文本的回归守卫。
//
// 主动消息到点生成跟前台聊天共用 buildScheduleInjection，而主动消息把「凌晨触发」变成了
// 常态：日程第一条在 07:00，凌晨一点触发时按「今天刚要开始」写，角色就会顶着清晨的心境
// 说话。凌晨 0-5 点算前一夜的尾巴，独白取「晚」档、措辞也得是夜里的说法。
import { describe, expect, it } from 'vitest';
import { buildScheduleInjection, getFlowNarrativeKey, type RenderableSchedule } from './scheduleInjection';

const schedule: RenderableSchedule = {
    slots: [
        { startTime: '07:00', activity: '晨跑' },
        { startTime: '13:00', activity: '写稿' },
        { startTime: '22:00', activity: '看剧' },
    ],
    flowNarrative: {
        morning: '清晨的空气很好，今天想跑远一点。',
        afternoon: '稿子卡在第三段。',
        evening: '夜里安静下来了，脑子还转着。',
    },
};

/** 用本地时间构造，getHours() 就是写死的那个点，不受机器时区影响。 */
const at = (hour: number, minute = 0) => new Date(2026, 7, 2, hour, minute);

describe('凌晨 0-5 点算前一夜的延续', () => {
    it('凌晨一点、今天第一条还没到 → 独白取「晚」档，不是清晨那句', () => {
        const out = buildScheduleInjection(schedule, undefined, at(1));
        expect(out).toContain('夜里安静下来了');
        expect(out).not.toContain('清晨的空气很好');
    });

    it('凌晨的措辞是夜里的说法，不带「稍后先」那种白天感', () => {
        const out = buildScheduleInjection(schedule, undefined, at(3, 40));
        expect(out).toContain('夜深了');
        expect(out).not.toContain('稍后先');
        // 最早那件事还是要说清楚，只是换个语气
        expect(out).toContain('晨跑');
        expect(out).toContain('07:00');
    });

    it('过了 5 点还没到第一条 → 回到原来的白天措辞与「早」档独白', () => {
        const out = buildScheduleInjection(schedule, undefined, at(6));
        expect(out).toContain('今天还没开始活动，稍后先晨跑（07:00）');
        expect(out).toContain('清晨的空气很好');
        expect(out).not.toContain('夜深了');
    });

    it('白天正落在某条日程上时一切照旧', () => {
        const out = buildScheduleInjection(schedule, undefined, at(14));
        expect(out).toContain('当前时段：13:00 你正在写稿');
        expect(out).toContain('之后安排：22:00 看剧');
        expect(out).toContain('稿子卡在第三段');
    });

    it('ChatApp 主请求可注入完整日程，并用一个简单标签教角色调整计划', () => {
        const out = buildScheduleInjection(schedule, undefined, at(14), {
            includeFullDay: true,
            includeChangeInstruction: true,
        });
        expect(out).toContain('你今天的完整日程：');
        expect(out).toContain('- 07:00 晨跑');
        expect(out).toContain('- 13:00 写稿');
        expect(out).toContain('- 22:00 看剧');
        expect(out).toContain('[[ACTION:CHANGE_SCHEDULE | 22:00 | 去超市]]');
        expect(out).toContain('正在进行的这一条和它之后的都能改，已经过去的不能');
    });
});

// 一天最后一条日程开始之后就没有「下一条」了，而那条通常是睡觉。以前这个能力说明
// 挂在「有下一条」上，于是最需要「我今晚不睡了」这个出口的时候恰恰不教。
describe('夜里最后一条日程之后仍然教改日程', () => {
    it('已经落在最后一条上时，示例时段退回当前这一条', () => {
        const out = buildScheduleInjection(schedule, undefined, at(23, 30), {
            includeFullDay: true,
            includeChangeInstruction: true,
        });
        expect(out).toContain('当前时段：22:00 你正在看剧');
        expect(out).toContain('[[ACTION:CHANGE_SCHEDULE | 22:00 | 去超市]]');
    });

    it('说明里点破「表跟实际对不上就改」，别让角色把日程当成必须履行的命令', () => {
        const out = buildScheduleInjection(schedule, undefined, at(23, 30), {
            includeChangeInstruction: true,
        });
        expect(out).toContain('不是必须履行的命令');
        expect(out).toContain('改成你实际在做的事');
    });
});

// 「时间感知」关掉的角色不该从日程块里读到精确钟点——那正是这个开关要挡的东西。
// 日程本身照给：它有自己的总开关。对齐天气块 includeTime 的处理。
describe('includeClock=false 时日程不报钟点', () => {
    const noClock = { includeFullDay: true, includeChangeInstruction: true, includeClock: false };

    it('当前时段与之后安排都只剩活动本身', () => {
        const out = buildScheduleInjection(schedule, undefined, at(14), noClock);
        expect(out).toContain('当前时段：你正在写稿');
        expect(out).toContain('之后安排：看剧');
        expect(out).not.toContain('13:00');
        expect(out).not.toContain('22:00');
    });

    it('完整日程表保留顺序但不带时刻', () => {
        const out = buildScheduleInjection(schedule, undefined, at(14), noClock);
        expect(out).toContain('- 晨跑');
        expect(out).toContain('- 写稿');
        expect(out).not.toContain('07:00');
    });

    it('不教改日程——那条指令拿时段当定位符，角色看不到时刻就写不出来', () => {
        const out = buildScheduleInjection(schedule, undefined, at(14), noClock);
        expect(out).not.toContain('CHANGE_SCHEDULE');
    });

    it('凌晨那句同样不带钟点', () => {
        const out = buildScheduleInjection(schedule, undefined, at(3), noClock);
        expect(out).toContain('夜深了');
        expect(out).toContain('晨跑');
        expect(out).not.toContain('07:00');
    });
});

describe('意识流档位', () => {
    it('一天三档的通用取法本身没变（小剧场、桌面小屋还按它取色）', () => {
        expect(getFlowNarrativeKey(1)).toBe('morning');
        expect(getFlowNarrativeKey(9)).toBe('morning');
        expect(getFlowNarrativeKey(13)).toBe('afternoon');
        expect(getFlowNarrativeKey(21)).toBe('evening');
    });
});

describe('日程不是给对方列的待办', () => {
    // 病象：用户随口说「今天想看书」，之后每一轮结尾都被问「书看到哪了」。日程这条路
    // 走得通——生成侧明写「对话里提到的事必须严格遵循」，意识系那档还把「惦记对方」
    // 列为推荐动作，对方的计划因此会渗进 slot 的 description；角色也能用
    // CHANGE_SCHEDULE 往表里写任意文本。而这张表每轮全量注入、贴着生成点。
    // 「不是台词」那句 footnote 只跟着意识流独白，管不到日程行，所以那两段一直是裸的。
    const withUserPlan: RenderableSchedule = {
        slots: [
            { startTime: '13:00', activity: '写稿' },
            { startTime: '20:00', activity: '看书', description: '小明说他今天也想看书，顺手翻两页' },
        ],
    };
    const SCOPE = '不是给对方列的待办';

    it('完整日程那份带上分寸句', () => {
        const out = buildScheduleInjection(withUserPlan, undefined, at(14), { includeFullDay: true });
        expect(out).toContain('小明说他今天也想看书'); // 内容照给，管的是怎么读它
        expect(out).toContain(SCOPE);
        expect(out).toContain('不用追着问进展');
    });

    it('没有意识流独白时也带 —— 那句「不是台词」管的不是这件事', () => {
        const out = buildScheduleInjection(withUserPlan, undefined, at(14), { includeFullDay: true });
        expect(out).not.toContain('不是台词'); // 这份没有独白，footnote 本就不出现
        expect(out).toContain(SCOPE);
    });

    it('主动消息到点那份（不列完整日程）同样带', () => {
        const out = buildScheduleInjection(withUserPlan, '脑子里还转着那段稿子。', at(14), {
            includeChangeInstruction: true,
        });
        expect(out).toContain('不是台词');  // 有独白，footnote 在
        expect(out).toContain(SCOPE);       // 分寸句也在，两句各管各的
    });

    it('分寸句在块尾，排在改期教学之后', () => {
        const out = buildScheduleInjection(withUserPlan, undefined, at(14), {
            includeFullDay: true,
            includeChangeInstruction: true,
        });
        expect(out.indexOf(SCOPE)).toBeGreaterThan(out.indexOf('CHANGE_SCHEDULE'));
    });
});
