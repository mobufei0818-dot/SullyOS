/**
 * 日程 → prompt 文本的纯渲染层。
 *
 * 零运行时依赖（只 import type），浏览器与 Cloudflare Worker 共用同一份：
 *  - 前台聊天走 ContextBuilder.buildScheduleInjection（转发到这里）；
 *  - 主动消息到点生成走 utils/amsgFireScene.ts，由 worker 在 fire 时刻按角色时区调用。
 *
 * 放在这里而不是 utils/context.ts：那个模块拖着 DB / 记忆宫殿等一堆浏览器依赖，
 * worker 引不动。两边各写一份的话，角色在聊天里和到点生成时会说出不一样的作息。
 */

import type { DailySchedule, ScheduleSlot } from '../types';

/**
 * 渲染真正会读到的那部分日程。
 *
 * 单独立一个类型是给主动消息用的：fire_pack 只带这些字段上云。整份 DailySchedule 里
 * 还挂着每个时段缓存的小剧场（整段演出台词）和 coverImage（可能是 base64 看板图），
 * 那些渲染一个字都用不到，带上去就是白占几十上百 KB 的云端状态。
 */
export type RenderableSchedule = Pick<DailySchedule, 'slots' | 'flowNarrative'>;

export interface ScheduleInjectionOptions {
    /** ChatApp 主请求需要让角色看到今天的整张表；主动消息到点场景仍只看当前与下一条。 */
    includeFullDay?: boolean;
    /**
     * 教不教角色改自己的日程。前台聊天和主动消息到点生成都能落地——后者的标签由
     * worker classifier 摘成 change_schedule directive 随 push 回来，客户端落库
     * （不摘的话会被 sanitize 连 raw 一起剥掉，见 utils/scheduleChangeParse.ts）。
     * 措辞对两边都成立：主动消息里没有「完整日程表」可指，所以只让它抄上面出现过的时段。
     */
    includeChangeInstruction?: boolean;
    /**
     * 能不能报钟点（默认能）。角色关掉「时间感知」时传 false：日程照给——那是这个
     * 功能自己的开关——但 `07:00` 这种精确钟点属于时间感知的范畴，不该从日程块漏出去。
     * 跟天气块的处理对齐（那边天气照给、只抽掉 timeLine）。
     * 关掉钟点时也不教改日程：那条指令拿时段当定位符，角色看不到时刻就写不出来。
     */
    includeClock?: boolean;
}

/** 意识流独白按一天三档取：早 / 午 / 晚。 */
export function getFlowNarrativeKey(hour: number): 'morning' | 'afternoon' | 'evening' {
    if (hour < 12) return 'morning';
    if (hour < 18) return 'afternoon';
    return 'evening';
}

/** 几点之前算「还在前一夜里」。凌晨 0-5 点属于昨晚的尾巴，不是今天的早晨。 */
const PRE_DAWN_END_HOUR = 5;

/** 当前时刻落在哪一条日程上，以及紧接着的下一条。都可能为 null（表还没开始 / 表是空的）。 */
export const resolveScheduleSlots = (
    schedule: RenderableSchedule | null,
    now: Date,
): { current: ScheduleSlot | null; next: ScheduleSlot | null } => {
    if (!schedule?.slots?.length) return { current: null, next: null };
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    for (let i = schedule.slots.length - 1; i >= 0; i--) {
        const [h, m] = schedule.slots[i].startTime.split(':').map(Number);
        if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
        if (currentMinutes >= h * 60 + m) {
            return {
                current: schedule.slots[i],
                next: i < schedule.slots.length - 1 ? schedule.slots[i + 1] : null,
            };
        }
    }
    // 今天第一条还没到点：没有「当前」，只有「稍后先做什么」。
    return { current: null, next: schedule.slots[0] };
};

/**
 * 构建日程注入文本
 *
 * 两段式，独立叠加：
 * 1) 当前时段硬事实——每轮都注入，不受 evolvedNarrative 影响
 * 2) 意识流独白——evolvedNarrative > flowNarrative > 当前 slot innerThought
 */
export const buildScheduleInjection = (
    schedule: RenderableSchedule | null,
    evolvedNarrative?: string,
    now: Date = new Date(),
    options: ScheduleInjectionOptions = {},
): string => {
    if (!schedule || !schedule.slots || schedule.slots.length === 0) return '';
    const { current: currentSlot, next: nextSlot } = resolveScheduleSlots(schedule, now);
    const withClock = options.includeClock !== false;
    /** 报钟点时写「活动（07:00）」，不报时只留活动本身。 */
    const withTime = (text: string, startTime: string) => (withClock ? `${text}（${startTime}）` : text);

    // 凌晨还没轮到今天第一条日程时，人其实还在昨晚里没睡。主动消息经常在这个点触发，
    // 按「今天刚要开始」写，半夜一点的角色就会顶着清晨的心境说话。
    const isPreDawnCarryOver = !currentSlot && now.getHours() < PRE_DAWN_END_HOUR;

    // 1. 当前时段硬事实（每轮独立注入）
    let slotHeader = '';
    if (currentSlot) {
        slotHeader = withClock
            ? `当前时段：${currentSlot.startTime} 你正在${currentSlot.activity}`
            : `当前时段：你正在${currentSlot.activity}`;
        if (currentSlot.location) slotHeader += `（${currentSlot.location}）`;
        if (nextSlot) {
            slotHeader += withClock
                ? `\n之后安排：${nextSlot.startTime} ${nextSlot.activity}`
                : `\n之后安排：${nextSlot.activity}`;
        }
        slotHeader += '\n';
    } else if (nextSlot) {
        slotHeader = isPreDawnCarryOver
            ? `夜深了，今天的安排还没开始，最早的一件是${withTime(nextSlot.activity, nextSlot.startTime)}\n`
            : `今天还没开始活动，稍后先${withTime(nextSlot.activity, nextSlot.startTime)}\n`;
    }

    // 2. 意识流独白
    let narrative = '';
    if (evolvedNarrative) {
        narrative = evolvedNarrative;
    } else if (schedule.flowNarrative && Object.keys(schedule.flowNarrative).length > 0) {
        // 前一夜的延续取「晚」档；其余照一天三档走。
        const key = isPreDawnCarryOver ? 'evening' : getFlowNarrativeKey(now.getHours());
        narrative = schedule.flowNarrative[key]
            || schedule.flowNarrative['evening']
            || schedule.flowNarrative['afternoon']
            || schedule.flowNarrative['morning']
            || '';
    } else if (currentSlot?.innerThought) {
        narrative = currentSlot.innerThought;
    }

    // 3. 拼接：硬事实 → 意识流（可选）
    const preamble = `此刻你的心中盘旋着这些想法……\n`;
    const footnote = `\n（不是台词，不用说出口——让它影响你的语气和情绪就好。）`;
    // footnote 只跟着意识流独白走，管不到上面的日程行——那两段是「你正在做什么」的硬事实，
    // 每轮全量注入且贴着生成点。日程是照着聊天记录生成的（生成侧明写「对话里提到的事
    // 必须严格遵循」，意识系那档还把「惦记对方」列为推荐动作），对方随口说的计划因此
    // 会渗进 slot 的 description；再加上角色能用 CHANGE_SCHEDULE 往里写任意文本，
    // 表上就可能出现一件「跟对方有关、每轮都摆在眼前、没人说过该怎么对待」的事。
    // 这块的注释自己就写过这条硬事实的推力：表上停在睡觉，角色每轮都被推着去道晚安。
    // 换成「问问书看到哪了」，就是每轮追问进度的由来。
    const scopeNote = '（这张表是你自己的一天，不是给对方列的待办。里头要是有跟对方相关的事，'
        + '那也是你自己的惦记——话赶到了顺口带一句就够，不用追着问进展，也不用催对方去做。）';

    let out = '';
    if (options.includeFullDay) {
        const rows = schedule.slots.map((slot) => {
            let line = withClock ? `- ${slot.startTime} ${slot.activity}` : `- ${slot.activity}`;
            if (slot.location) line += `（${slot.location}）`;
            if (slot.description) line += `：${slot.description}`;
            return line;
        });
        out += `你今天的完整日程：\n${rows.join('\n')}\n`;
    }
    out += slotHeader;
    if (narrative) {
        out += preamble + narrative + footnote;
    }
    // 能改的是「当前这一条和它之后的」，所以两者有一个在就有落点。落点优先取下一条；
    // 一天最后一条日程开始之后没有下一条了，这时用当前这条——那条通常是睡觉，正好是
    // 最需要「我今晚不睡了」这个出口的时候。
    const changeTarget = nextSlot ?? currentSlot;
    if (options.includeChangeInstruction && withClock && changeTarget) {
        out += '\n日程是你早上给自己排的计划，不是必须履行的命令。真实发生的事跟它对不上时'
            + '（比如这会儿表上写着睡觉、你却醒着在跟对方说话），把它改成你实际在做的事就好。\n'
            + '需要时在回复末尾单独输出：'
            + `[[ACTION:CHANGE_SCHEDULE | ${changeTarget.startTime} | 去超市]]`
            + '（时段要原样抄上面出现过的那几个；正在进行的这一条和它之后的都能改，已经过去的不能）。';
    }
    // 放块尾：上面几段是条件拼的，挂在其中一段里的话，另一种形态就是裸的。
    out += `\n${scopeNote}`;
    out += '\n';
    return out;
};
