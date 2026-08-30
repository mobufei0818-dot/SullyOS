import type { CharacterProfile, DailySchedule, ScheduleSlot } from '../types';
import { DB } from './db';
import { getDailyScheduleForChar } from './dailySchedule';
import { getCurrentScheduleSlotIndex, getScheduleWallClock } from './scheduleTime';
import { getLocalDateKey } from './localDate';
import { extractScheduleChangeDirectives } from './scheduleChangeParse';
import type { ExtractedScheduleChanges, ScheduleChangeDirective } from './scheduleChangeParse';

export const SCHEDULE_CHANGE_EVENT = 'schedule-change-applied';

// 解析层住在 utils/scheduleChangeParse.ts —— 那是零依赖叶子，worker 侧的业务标签
// classifier 也要用它（见那份文件顶部的说明）。这里转发一道，现有调用点不用改 import。
export type { ExtractedScheduleChanges, ScheduleChangeDirective } from './scheduleChangeParse';
export { extractScheduleChangeDirectives } from './scheduleChangeParse';

export interface AppliedScheduleChange {
    startTime: string;
    before: string;
    after: string;
}

export interface ScheduleChangeEventDetail {
    charId: string;
    date: string;
    changes: AppliedScheduleChange[];
    schedule: DailySchedule;
    eventId: string;
}

export interface AppliedScheduleChangeResult extends ExtractedScheduleChanges {
    schedule: DailySchedule | null;
    changes: AppliedScheduleChange[];
    rejectedCount: number;
    /**
     * rejectedCount > 0 时说明是哪一种拒绝，给调用方拼准确的提示语用。
     * `cross-day` 是这句话不是今天说的、整批作废；`no-slot` 是今天的表里没有能落的时段。
     */
    rejectedReason?: 'cross-day' | 'no-slot';
}

const minutesOf = (time: string): number | null => {
    const matched = /^(\d{1,2}):(\d{2})$/u.exec(time.trim());
    if (!matched) return null;
    const hour = Number(matched[1]);
    const minute = Number(matched[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return hour * 60 + minute;
};

/**
 * 纯数据层：只允许命中已有的时段，且只能是当前正在进行的这一条或它之后的；
 * 无法确定目标时宁可不改。
 *
 * 「当前这一条也能改」是有意为之：夜里最后一条日程通常是睡觉，人却还在聊天，
 * 角色说「今晚不睡了陪你」时得有地方落，否则它读到的当前时段永远停在睡觉上，
 * 每一轮都被这条硬事实推着去道晚安。已经过去的时段仍然改不了——那是既成事实。
 */
export const applyScheduleChanges = (
    schedule: DailySchedule,
    directives: ScheduleChangeDirective[],
    char?: Pick<CharacterProfile, 'customTimezoneEnabled' | 'customTimezone'> | null,
    at: Date = new Date(),
): { schedule: DailySchedule; changes: AppliedScheduleChange[]; rejectedCount: number } => {
    const wallNow = getScheduleWallClock(char, at);
    const currentMinutes = wallNow.getHours() * 60 + wallNow.getMinutes();
    const slots: ScheduleSlot[] = schedule.slots.map((slot) => ({ ...slot }));
    // 「当前是第几条」跟日程卡 / 首页小组件 / 日程注入用同一个函数。两边说的必须是同一条，
    // 否则界面高亮成「此刻」的那条，在这里会被判成不可改。
    const currentIndex = getCurrentScheduleSlotIndex(slots, char, at);
    const changeByTime = new Map<string, AppliedScheduleChange>();
    let rejectedCount = 0;

    for (const directive of directives) {
        const targetMinutes = minutesOf(directive.startTime);
        // 未来的时段一律可改；已经开始的只放行当前这一条，更早的属于既成事实。
        // 落点先在「当前时段及之后」这一段里找：同一个 startTime 万一出现两次，
        // 要改的是还没过去的那条，而不是数组里排在前面的那条。
        const editableFrom = currentIndex < 0 ? 0 : currentIndex;
        let slotIndex = slots.findIndex(
            (slot, i) => i >= editableFrom && slot.startTime === directive.startTime,
        );
        // 日程表理应按时间排好；万一乱序，位置靠前但时刻确实在未来的时段也该能改。
        if (slotIndex < 0 && targetMinutes != null && targetMinutes > currentMinutes) {
            slotIndex = slots.findIndex((slot) => slot.startTime === directive.startTime);
        }
        if (slotIndex < 0) {
            rejectedCount += 1;
            continue;
        }

        const slot = slots[slotIndex];
        if (slot.activity.trim() === directive.activity.trim()) continue;
        const originalBefore = changeByTime.get(directive.startTime)?.before ?? slot.activity;
        slots[slotIndex] = {
            startTime: slot.startTime,
            activity: directive.activity.trim(),
            // 原描述、地点、独白和小剧场都围绕旧活动生成，保留会立即穿帮。
            ...(slot.emoji ? { emoji: slot.emoji } : {}),
        };
        changeByTime.set(directive.startTime, {
            startTime: directive.startTime,
            before: originalBefore,
            after: directive.activity.trim(),
        });
    }

    const changes = [...changeByTime.values()];
    if (changes.length === 0) return { schedule, changes, rejectedCount };
    return {
        schedule: {
            ...schedule,
            slots,
            // 整日意识流同样基于旧计划生成；清掉后回落到当前 slot 的独白，避免安排都改了、念头仍旧。
            flowNarrative: undefined,
        },
        changes,
        rejectedCount,
    };
};

/**
 * 解析模型回复、落库成功的日程改动，并返回供聊天 UI 展示的差异。
 *
 * `at` 是**这句话说出口的时刻**，不是处理它的时刻。本地聊天两者只差几秒，主动消息
 * 差得可以很远：昨晚 22:05 发出的「22:00 改成陪你聊天」，用户今早九点才打开 App。
 * 按处理时刻判的话，那条会落到**今天**的 22:00 上——角色昨晚的一句话，改了今天的安排。
 * 所以调用方要把 push 的 sentAt 传进来，隔天的整批直接丢弃（见下面的日历日门槛）。
 */
export const applyAssistantScheduleChanges = async (
    text: string,
    char: Pick<CharacterProfile, 'id' | 'customTimezoneEnabled' | 'customTimezone'>,
    at: Date = new Date(),
): Promise<AppliedScheduleChangeResult> => {
    const extracted = extractScheduleChangeDirectives(text);
    if (extracted.directives.length === 0) {
        return { ...extracted, schedule: null, changes: [], rejectedCount: 0 };
    }
    const applied = await applyScheduleChangeDirectives(extracted.directives, char, at);
    return { ...extracted, ...applied };
};

/**
 * 落库那半边：已经拿到 directives 之后的取表 → 改 → 存。
 *
 * 单独开一个口子，是因为改动不只从聊天正文来。角色在后台改自己的日程时，那一轮可能
 * 一个字都没说，指令是随云端结果（`schedule-change`，见 utils/amsgScheduleResult.ts）
 * 回来的，没有正文可解析。两条路都走这里，「哪条时段能改」「隔天怎么算」只有一套说法。
 *
 * `at` 同样是**说出口**的时刻，不是处理它的时刻。
 */
export const applyScheduleChangeDirectives = async (
    directives: ScheduleChangeDirective[],
    char: Pick<CharacterProfile, 'id' | 'customTimezoneEnabled' | 'customTimezone'>,
    at: Date = new Date(),
): Promise<Omit<AppliedScheduleChangeResult, keyof ExtractedScheduleChanges>> => {
    if (directives.length === 0) {
        return { schedule: null, changes: [], rejectedCount: 0 };
    }

    // 日历日门槛：说出口那天不是角色当地的今天，这批改动就已经没有落点了
    // ——今天的日程是另一张表，昨天的意思不该盖到它头上。整批算作拒绝，
    // 调用方照常收到 rejectedCount，但一个字都不落库。
    const sameDay = getLocalDateKey(getScheduleWallClock(char, at))
        === getLocalDateKey(getScheduleWallClock(char, new Date()));
    if (!sameDay) {
        return { schedule: null, changes: [], rejectedCount: directives.length, rejectedReason: 'cross-day' };
    }

    // 上面的日历日门槛已经保证「说出口那天」就是角色当地的今天，所以这里要的就是今天
    // 那张表，用「现在」去取。传 at 会让表内的 legacy key 兜底按**设备**时区折算日期，
    // 跨时区角色可能因此探到另一天的旧键。
    const schedule = await getDailyScheduleForChar(char);
    if (!schedule) {
        return { schedule: null, changes: [], rejectedCount: directives.length, rejectedReason: 'no-slot' };
    }

    const applied = applyScheduleChanges(schedule, directives, char, at);
    if (applied.changes.length > 0) await DB.saveDailySchedule(applied.schedule);
    return {
        ...applied,
        // 只在一条都没落地时才给原因。部分成功的批次（两条指令落了一条）挂上 'no-slot'
        // 是在说谎——这个字段是给调用方拼「为什么没改成」用的，而那种情况已经改成了。
        ...(applied.changes.length === 0 && applied.rejectedCount > 0
            ? { rejectedReason: 'no-slot' as const }
            : {}),
    };
};

export const announceScheduleChanges = (
    charId: string,
    schedule: DailySchedule,
    changes: AppliedScheduleChange[],
): void => {
    if (changes.length === 0 || typeof window === 'undefined') return;
    const detail: ScheduleChangeEventDetail = {
        charId,
        date: schedule.date,
        changes,
        schedule,
        eventId: `${charId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    };
    window.dispatchEvent(new CustomEvent<ScheduleChangeEventDetail>(SCHEDULE_CHANGE_EVENT, { detail }));
};
