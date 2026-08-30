/**
 * 「角色在后台改了自己的日程」这条结果的形状 —— 纯函数零依赖，浏览器与 Cloudflare
 * Worker 共用同一份（同 utils/scheduleChangeParse.ts 的路子）。
 *
 * 为什么日程改动要单独走一条结果通道：一次 fire 只要没写出正文就整条不发（空正文的
 * 推送横幅是空白的，而订阅按 userVisibleOnly 建，发一条不弹的就是跟浏览器违约）。
 * 别的副作用丢了就丢了——角色一个字没说却在小红书点了赞，本身就穿帮，该等客户端上线
 * 时主动拉。日程改动不一样：它不是做给用户看的动作，是角色在纠正自己的表。丢掉的话，
 * 下一次 fire 读到的还是那条旧安排，角色会反复想改又反复改不掉。
 *
 * 所以走 `ctx.emitResult`：落进服务端收件箱（客户端下次 `GET /outbox?since=` 一定
 * 拿得到），不占聊天正文，也不需要为它硬发一条没内容的推送。
 */

/** 一条日程改动：把某个时段换成另一件事。与 scheduleChangeParse 的同名结构一致。 */
export interface AmsgScheduleChangeItem {
    startTime: string;
    activity: string;
}

/** 结果的名字（`emitResult` 的 resultKind），客户端按它分流。 */
export const SCHEDULE_CHANGE_RESULT_KIND = 'schedule-change';

export interface AmsgScheduleChangeResult {
    resultKind: typeof SCHEDULE_CHANGE_RESULT_KIND;
    v: 1;
    charId: string;
    /**
     * 这句话**说出口**的时刻（epoch 毫秒）。
     *
     * 结果可能在收件箱里躺一夜，用户第二天早上才打开 App。按拿到它的那一刻判的话，
     * 昨晚那句「22:00 改成陪你聊天」会落到今天的 22:00 上——角色昨晚的一句话，改了
     * 今天的安排。客户端拿这个时刻判时段，隔天的整批丢弃。
     */
    spokenAt: number;
    directives: AmsgScheduleChangeItem[];
}

/** 组一条结果（版本号只有这一处写，别在调用点手抄）。 */
export function buildScheduleChangeResult(args: {
    charId: string;
    spokenAt: number;
    directives: AmsgScheduleChangeItem[];
}): AmsgScheduleChangeResult {
    return {
        resultKind: SCHEDULE_CHANGE_RESULT_KIND,
        v: 1,
        charId: args.charId,
        spokenAt: args.spokenAt,
        directives: args.directives.map((d) => ({ startTime: d.startTime, activity: d.activity })),
    };
}

/** 读回一条结果；形状对不上返回 null（客户端据此销账丢弃并留日志，不改任何表）。 */
export function parseScheduleChangeResult(raw: unknown): AmsgScheduleChangeResult | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    if (o.resultKind !== SCHEDULE_CHANGE_RESULT_KIND || o.v !== 1) return null;
    if (typeof o.charId !== 'string' || !o.charId) return null;
    if (typeof o.spokenAt !== 'number' || !Number.isFinite(o.spokenAt)) return null;
    if (!Array.isArray(o.directives)) return null;

    const directives: AmsgScheduleChangeItem[] = [];
    for (const d of o.directives) {
        if (!d || typeof d !== 'object') continue;
        const row = d as Record<string, unknown>;
        if (typeof row.startTime !== 'string' || typeof row.activity !== 'string') continue;
        if (!row.startTime.trim() || !row.activity.trim()) continue;
        directives.push({ startTime: row.startTime, activity: row.activity });
    }
    // 一条有效的都没有 = 这条结果没有内容可执行，当形状坏了处理（销账丢弃）。
    if (directives.length === 0) return null;

    return {
        resultKind: SCHEDULE_CHANGE_RESULT_KIND,
        v: 1,
        charId: o.charId,
        spokenAt: o.spokenAt,
        directives,
    };
}
