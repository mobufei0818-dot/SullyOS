/**
 * 日程修改标签的容错解析 —— 纯函数，零依赖（连 type import 都没有），浏览器与
 * Cloudflare Worker 共用同一份。
 *
 * 为什么要单独立一个叶子：apply 那半边拖着 DB / dailySchedule，worker 引不动；
 * 而 worker 侧**必须**认得出这个标签——它留在正文里的话，会被 sanitizeIntoSegments
 * 的 stripBusinessTagsForNotification（正则含 ACTION）整块剥掉，连 raw 都不留，
 * 客户端永远收不到，角色嘴上说「日程改好了」而表其实没动。走 directive 通道才到得了。
 * 同 utils/transferFormat.ts 之于转账，是同一条路子。
 *
 * 两边各写一份解析的话，前台认得的写法后台不认，同一个角色在聊天里改得动日程、
 * 在主动消息里改不动。
 */

export interface ScheduleChangeDirective {
    startTime: string;
    activity: string;
}

export interface ExtractedScheduleChanges {
    cleanedText: string;
    directives: ScheduleChangeDirective[];
    malformedCount: number;
}

const KEYWORD_RE = /^\s*(?:ACTION\s*[:：]\s*CHANGE_SCHEDULE|change[\s_-]*(?:schedule|schedue)|modify[\s_-]*schedule|修改(?:未来)?日程|更改(?:未来)?日程|改日程)(?=\s|[:：|=→>\-（(]|\d|$)/iu;

type ParsedBody =
    | { recognized: false }
    | { recognized: true; directive: ScheduleChangeDirective | null };

const parseDirectiveBody = (input: string): ParsedBody => {
    const body = input
        .replace(/^[\s【\[]+|[\s】\]]+$/gu, '')
        .trim();
    const keyword = body.match(KEYWORD_RE);
    if (!keyword) return { recognized: false };

    const rest = body
        .slice(keyword[0].length)
        .replace(/^\s*[:：|=→>\-]+\s*/u, '');
    // canonical: 18:30；同时兜底 18：30 /（18:30）/ 18点30分 / 18时。
    const time = rest.match(/[（(]?\s*(\d{1,2})\s*(?:[:：点时])\s*(\d{1,2})?\s*(?:分)?\s*[）)]?/u);
    if (!time || time.index == null) return { recognized: true, directive: null };

    const hour = Number(time[1]);
    const minute = time[2] == null || time[2] === '' ? 0 : Number(time[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return { recognized: true, directive: null };
    }

    const activity = rest
        .slice(time.index + time[0].length)
        .replace(/^\s*(?:[:：|=→>\-]+)\s*/u, '')
        .replace(/[】\]]+\s*$/gu, '')
        .trim();
    if (!activity) return { recognized: true, directive: null };

    return {
        recognized: true,
        directive: {
            startTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
            // 日程卡本来就是短标题；截断异常长输出，避免一条标签撑坏 UI / prompt。
            activity: activity.slice(0, 120),
        },
    };
};

/**
 * 从回复里取出日程修改标签并隐藏标签本身。
 *
 * 正式格式跟其它动作一致：`[[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]]`。解析端额外接受：
 * - 单层 / 中文括号；
 * - `change schedule`、旧版 `change schedue`、中文「修改日程」；
 * - 全角冒号、圆括号时段、`18点30分`；
 * - 忘记闭合括号但整条指令仍独占一行。
 */
export const extractScheduleChangeDirectives = (text: string): ExtractedScheduleChanges => {
    const directives: ScheduleChangeDirective[] = [];
    let malformedCount = 0;

    const consumeBody = (body: string, original: string): string => {
        const parsed = parseDirectiveBody(body);
        if (!parsed.recognized) return original;
        if (parsed.directive) directives.push(parsed.directive);
        else malformedCount += 1;
        return '';
    };

    // 先吃带括号的块。允许左右各一层或两层，避免少打一枚括号时留下孤立的 `[` / `]`。
    let cleanedText = (text || '').replace(
        /(?:【{1,2}|\[{1,2})([^【】\[\]\r\n]{1,360})(?:】{1,2}|\]{1,2})/gu,
        (whole, body) => consumeBody(body ?? '', whole),
    );

    // 兜底模型漏掉一侧或全部括号的情况。能力标签要求独占一行，所以这一层**从行首起算**、
    // 也只消费到本行末尾（`m` 让 `^` 认每一行的行首）。
    //
    // 行首这个锚是硬要求：不锚的话「好，我改日程：22点陪你聊天」这种纯叙述会从「改日程」
    // 一路被吃到行尾——既凭空造出一条 22:00 的改动，又把用户看到的正文截成「好，我」。
    // 而这份解析跑在每一条模型输出上，代价是全局的。跟在同一行别的内容后面的写法就此不再
    // 识别：漏掉一条要靠猜才认得出的指令，比误改一条日程 + 吞掉半句话便宜。规范写法
    // （`[[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]]`）有括号兜底，走上面那一层。
    //
    // 各处空白都用 `[ \t]` 而不是 `\s`：`\s` 含换行，会让这一层跨行吞到下一段正文里去。
    cleanedText = cleanedText.replace(
        /^[ \t]*(?:【【?|\[\[?)?[ \t]*(?:ACTION[ \t]*[:：][ \t]*CHANGE_SCHEDULE|change[ \t_-]*(?:schedule|schedue)|modify[ \t_-]*schedule|修改(?:未来)?日程|更改(?:未来)?日程|改日程)[ \t]*[:：|]?[^\r\n]{0,360}/gimu,
        (whole) => consumeBody(whole, whole),
    );

    // 一个日程标签都没认出来时原样奉还，连空白都不碰。
    //
    // 清洗那几步（剥标签留下的空行、去首尾空白）只有在「确实剥掉了什么」时才说得通。
    // 没认出东西还照样清洗的话，每一条普通回复都会被顺手压掉空行——而这份解析跑在
    // 所有模型输出上。更要紧的是它得**由解析器自己保证**：客户端和 worker 都调这里，
    // 谁忘了在外面加一道「没认出就别用 cleanedText」的守卫，谁那一侧的正文就会悄悄
    // 少一截，同一条回复走推送和走本地长得不一样（这份文件顶部说的就是这件事）。
    const recognizedSomething = directives.length > 0 || malformedCount > 0;
    if (!recognizedSomething) {
        return { cleanedText: text || '', directives, malformedCount };
    }

    return {
        cleanedText: cleanedText
            .replace(/[ \t]+\r?\n/gu, '\n')
            .replace(/\n{3,}/gu, '\n\n')
            .trim(),
        directives,
        malformedCount,
    };
};
