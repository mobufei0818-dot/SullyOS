/**
 * roomPlateCore — 门牌整理的提示词、解析与合并（环境无关叶子模块）
 *
 * 门牌整理这件事有两个地方要做：浏览器里（没配主动消息 2.0 的用户照旧本地跑）和
 * 用户自己的 CF Worker 里（页面关着也能跑完）。两边必须是同一份提示词、同一套解析、
 * 同一份合并语义——各写一份的话，同一批材料在两条路上会整理出不一样的门牌，而这种
 * 漂移在界面上完全看不出来。所以「怎么问、怎么读、怎么并」全住在这里。
 *
 * 这里**不发请求**：浏览器侧继续走 safeFetchJson（那份带着「设置 → API 调用记录」的
 * 埋点），worker 侧的请求由上游 amsg-server 按任务里的凭据引用去发。叶子只负责把
 * 提示词拼出来、把回复读回来。
 *
 * 往这里加代码前先确认：不 import 任何带浏览器依赖的模块（db / safeApi / context 等）。
 * `pnpm build:workers` 会把这份打进 amsg worker bundle，带进浏览器依赖会在构建期直接暴露。
 * 现在只依赖 ./types（纯常量与类型）和 ./jsonUtils（纯解析），两者都是零 import。
 */

import type { PlateEntry, PlateRoom } from './types';
import {
    PLATE_ENTRY_CAPS,
    PLATE_ENTRY_HARD_MAX_CHARS,
    PLATE_ENTRY_TARGET_CHARS,
    PLATE_ROOMS,
    PLATE_TITLES,
} from './types';
import { safeParseJsonArray } from './jsonUtils';

// ─── 请求参数（两条路共用一份，别各写各的） ───────────

/** 整理是「照着材料重排」不是「创作」，温度压低 */
export const PLATE_LLM_TEMPERATURE = 0.3;
/** 四块门牌全量输出一次要不少字，给足 */
export const PLATE_LLM_MAX_TOKENS = 8000;
/**
 * 单次整理的硬超时。两条路都用这一个值：浏览器侧交给 safeFetchJson，worker 侧作为这次
 * fire 的 `totalTimeoutMs` 交给上游（见 worker/amsg/src/plateFire.ts 的 beforeFire）。
 * 不显式交上去的话云端会落到库自己的默认值（四分钟），改这个常量对云端毫无影响。
 */
export const PLATE_LLM_TIMEOUT_MS = 120_000;

// ─── 基础工具 ─────────────────────────────────────────

export function isPlateRoom(room: string): room is PlateRoom {
    return (PLATE_ROOMS as string[]).includes(room);
}

export function generateEntryId(): string {
    return `pe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 每个房间的条目标签前缀（与消化提示词的 U0/R0 标签习惯对齐） */
export const ROOM_LABEL_PREFIX: Record<PlateRoom, string> = {
    user_room: 'U',
    self_room: 'R',
    bedroom:   'B',
    study:     'S',
};

export interface PlateLLMItem {
    room: string;
    text: string;
    /** 引用现有条目标签（如 "U2"）= 这是对旧条目的延续/更新，继承 firstLearnedAt */
    basedOn?: string | null;
    /** 2-4 字分类标签（家庭/居住/重要他人/工作/雷区/习惯…） */
    tag?: string | null;
}

export interface PlateMaterial {
    room: PlateRoom;
    /** 蒸馏原料：盒子 summary 或高价值记忆节点的内容 */
    lines: string[];
}

/**
 * 拼提示词只要「这个房间现在挂着哪几条」，不需要整份 RoomPlate。
 * entries 的**顺序就是标签顺序**（第 i 条 = 前缀 + i），上云时序列化的就是这个形状。
 */
export interface PlateSnapshot {
    room: PlateRoom;
    entries: string[];
}

// ─── 卧室硬规则 ───────────────────────────────────────

/**
 * 卧室兜底过滤：拦"给关系下定义"的条目。
 *
 * 窄匹配原则：只拦"我们(是/算是/成了)××"这种明确的命名句式，
 * 不拦定性词本身——"TA说我像她理想中的家人"是合法的质地描述。
 * 主约束在 prompt 层，这里只是最后一道窄栅栏，宁可漏过不可误杀。
 */
const BEDROOM_LABEL_RE = /我们(?:现在|如今|已经)?(?:是|算是|成了|成为|变成)[^，。；！？]{0,8}(?:恋人|情侣|男女朋友|男朋友|女朋友|夫妻|朋友|兄妹|姐弟|家人|知己|暧昧)/;

export function violatesBedroomRule(text: string): boolean {
    return BEDROOM_LABEL_RE.test(text);
}

// ─── 合并逻辑（纯函数，可测） ─────────────────────────

/**
 * 把 LLM 输出的完整新列表合并进现有门牌条目。
 *
 * - basedOn 命中现有标签 → 继承 id/firstLearnedAt，sourceCount+1，
 *   文本未变时连 updatedAt 也不动（纯保留不算更新）
 * - 无 basedOn → 新条目
 * - 现有条目未被任何输出引用且未被原样保留 → 淘汰（容量压力语义）
 * - 超长截断、卧室命名过滤、cap 裁剪
 */
export function mergePlateEntries(
    room: PlateRoom,
    existing: PlateEntry[],
    items: Array<{ text: string; basedOn?: string | null; tag?: string | null }>,
    now: number,
): PlateEntry[] {
    const prefix = ROOM_LABEL_PREFIX[room];
    const byLabel = new Map<string, PlateEntry>();
    existing.forEach((e, i) => byLabel.set(`${prefix}${i}`, e));

    const merged: PlateEntry[] = [];
    const usedIds = new Set<string>();

    for (const item of items) {
        let text = (item.text || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (text.length > PLATE_ENTRY_HARD_MAX_CHARS) {
            text = text.slice(0, PLATE_ENTRY_HARD_MAX_CHARS);
        }
        if (room === 'bedroom' && violatesBedroomRule(text)) {
            console.warn(`🚪 [RoomPlate] 卧室门牌拦截关系命名条目: "${text.slice(0, 40)}"`);
            continue;
        }
        const tag = (item.tag || '').replace(/\s+/g, '').slice(0, 6) || undefined;

        const base = item.basedOn ? byLabel.get(String(item.basedOn).trim().toUpperCase()) : undefined;
        if (base && !usedIds.has(base.id)) {
            usedIds.add(base.id);
            const changed = base.text !== text;
            merged.push({
                ...base,
                text,
                tag: tag ?? base.tag,
                updatedAt: changed ? now : base.updatedAt,
                sourceCount: base.sourceCount + 1,
            });
        } else {
            // 同文本条目已存在但 LLM 忘了标 basedOn → 按原样保留而不是当新条目重开
            const sameText = existing.find(e => e.text === text && !usedIds.has(e.id));
            if (sameText) {
                usedIds.add(sameText.id);
                merged.push({ ...sameText, tag: tag ?? sameText.tag, sourceCount: sameText.sourceCount + 1 });
            } else {
                merged.push({
                    id: generateEntryId(),
                    text,
                    tag,
                    firstLearnedAt: now,
                    updatedAt: now,
                    sourceCount: 1,
                });
            }
        }
    }

    return merged.slice(0, PLATE_ENTRY_CAPS[room]);
}

/**
 * 把 basedOn 从「提交时的标签」改写成「现在的标签」。
 *
 * 上云那条路，提示词是拿提交那一刻的门牌快照拼的，LLM 回的 `basedOn: "U0"` 说的是
 * **快照里的第 0 条**。结果晚几分钟甚至几小时才回来，这中间门牌可能已经被别的路径
 * 动过（手动回填就在本地跑），此时 `U0` 指的已经是另一条认知了——直接拿去合并，
 * 两条认知的来历（firstLearnedAt / sourceCount）会被悄悄接错。
 *
 * 所以提交时把快照每条的 id 一起带上，回来时按 id 在当前列表里找它现在排第几，
 * 把标签改写过去。标签指到快照之外（模型把序号编大了）就把 basedOn 抹成 null，
 * 当新条目收进去——认错来历比丢一次来历更糟。
 *
 * **快照里有、现在没了的那种要整条丢掉**，不能当新条目收：那说明这条认知在提交之后
 * 被删掉了（用户在门牌面板上手删，或者被上一份整理结果淘汰）。这份结果照着旧快照
 * 生成，它「保留」的是一条已经不该在的认知，收进去就是原地复活——而门牌面板恰恰是
 * 用户手删的地方，删完还眼看着它长回来。删除比这份陈旧结果新，删除说了算。
 *
 * @param snapshotEntryIds 提交时该房间的条目 id，顺序即当时的标签顺序
 * @param current 现在的条目（合并要写进去的那一份）
 */
export function remapBasedOnLabels(
    room: PlateRoom,
    items: PlateLLMItem[],
    snapshotEntryIds: string[],
    current: PlateEntry[],
): PlateLLMItem[] {
    const prefix = ROOM_LABEL_PREFIX[room];
    const currentIndexById = new Map(current.map((e, i) => [e.id, i]));

    return items.flatMap(item => {
        if (!item.basedOn) return [item];
        const label = String(item.basedOn).trim().toUpperCase();
        if (!label.startsWith(prefix)) return [{ ...item, basedOn: null }];
        // 只认「前缀 + 纯数字」。别拿 Number() 直接转：Number('') 是 0，光秃秃的前缀
        // （模型把数字掉了，回一个 "U"）会被当成第 0 条，把一条无关认知的来历接过去。
        const digits = label.slice(prefix.length);
        if (!/^\d+$/.test(digits)) return [{ ...item, basedOn: null }];
        const snapshotIndex = Number(digits);

        const entryId = snapshotEntryIds[snapshotIndex];
        if (entryId === undefined) return [{ ...item, basedOn: null }];

        const currentIndex = currentIndexById.get(entryId);
        if (currentIndex === undefined) {
            console.warn(`🚪 [RoomPlate] 「${room}」丢掉一条陈旧结果：它保留的条目在提交之后已经被删掉了`);
            return [];
        }
        return [{ ...item, basedOn: `${prefix}${currentIndex}` }];
    });
}

/**
 * 提交之后被本地改过的条目，文本以本地那份为准。
 *
 * 门牌面板是人工纠错的口子——蒸错的事实一旦常驻，角色会自信地重复很久。用户在等结果的
 * 这几分钟里把一条改对了，而这份结果是照着改之前那份快照生成的：照常合并就是拿旧认知
 * 把刚纠正的那条又盖回去，用户看着自己刚敲的字变回原样，还不知道是谁改的。
 *
 * 只换文本，别的都不动：条目照常参与这一轮的保留/淘汰、tag 照常更新，只是「它现在写着
 * 什么」由本地那份说了算。判据是条目的 updatedAt 晚于快照时刻。
 *
 * @param snapshotAt 快照是什么时候读的（epoch 毫秒）。`0` = 无从查起（结果迟到太久、
 *   在飞记号已经不在了），那时按「谁都可能被改过」保守处理：凡是有过改动痕迹的条目
 *   一律留本地文本，只有从没被改过的才让结果改写。
 */
function keepLocalEditsOverStaleRewrites(
    room: PlateRoom,
    current: PlateEntry[],
    items: Array<{ text: string; basedOn?: string | null; tag?: string | null }>,
    snapshotAt: number,
): Array<{ text: string; basedOn?: string | null; tag?: string | null }> {
    const prefix = ROOM_LABEL_PREFIX[room];
    const byLabel = new Map<string, PlateEntry>();
    current.forEach((e, i) => byLabel.set(`${prefix}${i}`, e));

    return items.map(item => {
        if (!item.basedOn) return item;
        const base = byLabel.get(String(item.basedOn).trim().toUpperCase());
        if (!base || base.text === item.text) return item;
        // 从建出来到现在一个字都没被改过的条目不算「本地改过」：它现在写着什么，快照里
        // 就写着什么。这条豁免不能省——交云端之前送达保证会先把消化刚提交的候选机械并进
        // 门牌（见 roomPlates 的 fallbackMergeSubmissions），那批的 updatedAt 就是并入
        // 那一刻、必然晚于快照。不豁免的话，云端把这批粗糙候选改写成人话的结果会被原样
        // 退回去，而改写它们正是那一轮整理最主要的目的。
        if (base.updatedAt === base.firstLearnedAt) return item;
        if (base.updatedAt <= snapshotAt) return item;
        console.warn(`🚪 [RoomPlate] 「${room}」这条在快照之后被本地改过，保留本地那份文本`);
        return { ...item, text: base.text };
    });
}

/**
 * 上云那条路专用的合并：在 mergePlateEntries 之上，护住**快照之后才出现的条目**。
 *
 * 合并语义是「LLM 输出的完整新列表说了算，没被重新输出的条目淘汰」。本地那条路上这是
 * 对的——LLM 看到的就是当前全部条目。上云之后不成立了：LLM 看到的是**提交那一刻**的
 * 快照，而结果一两分钟后才回来，这中间封盒、手动回填、上一份结果落地都可能往门牌里
 * 写了新条目。那些条目 LLM 压根没见过，谈不上「决定淘汰」，照原样合并就是把它们静默
 * 抹掉，用户这边看到的是刚沉淀的认知凭空消失。
 *
 * 所以按 id 分两类：在快照里的，照常参与淘汰；不在快照里的（= 提交之后新增的），
 * 没被引用也保留，排在整理结果后面，等下一轮整理再一起重排。
 *
 * 「提交之后被改过」的条目另算：那批还在快照里，照常参与淘汰，只是文本以本地那份为准
 * （见 keepLocalEditsOverStaleRewrites）。
 *
 * @param snapshotEntryIds 提交时该房间的条目 id（顺序即当时的标签顺序）
 * @param snapshotAt 快照是什么时候读的（epoch 毫秒），`0` = 无从查起。
 *   见 keepLocalEditsOverStaleRewrites。
 */
export function mergeCloudPlateEntries(
    room: PlateRoom,
    current: PlateEntry[],
    alignedItems: Array<{ text: string; basedOn?: string | null; tag?: string | null }>,
    snapshotEntryIds: string[],
    now: number,
    snapshotAt: number,
): PlateEntry[] {
    const items = keepLocalEditsOverStaleRewrites(room, current, alignedItems, snapshotAt);
    const merged = mergePlateEntries(room, current, items, now);
    const snapshotIds = new Set(snapshotEntryIds);
    const mergedIds = new Set(merged.map(e => e.id));
    // 同文本原样保留那条支路也会把新条目收进 merged，所以要连 mergedIds 一起排除，
    // 否则同一条会出现两次。
    const born = current.filter(e => !snapshotIds.has(e.id) && !mergedIds.has(e.id));
    if (born.length === 0) return merged;

    const cap = PLATE_ENTRY_CAPS[room];
    // 裁之前先给 born 留位子。直接 [...merged, ...born].slice(0, cap) 的话，整理结果占满
    // 上限时 born 会被整批扔掉——而它们的来源节点早就打过 digestedAt，不会再有第二次，
    // 「等下轮整理再收」是等不到的，那批认知就这么永久没了。
    // 留一半封顶：born 是还没被整理过的粗糙条目，也不该把 LLM 刚排好的那份整块挤出去。
    const bornQuota = Math.min(born.length, Math.max(1, Math.floor(cap / 2)));
    const kept = [...merged.slice(0, cap - bornQuota), ...born].slice(0, cap);

    const keptIds = new Set(kept.map(e => e.id));
    const lostBorn = born.filter(e => !keptIds.has(e.id)).length;
    const lostMerged = merged.filter(e => !keptIds.has(e.id)).length;
    if (lostBorn > 0) {
        console.warn(`🚪 [RoomPlate] 「${room}」快照之后新增的条目有 ${lostBorn} 条挤不进上限，已经丢掉（来源已消化，不会再来一次）`);
    }
    if (lostMerged > 0) {
        console.warn(`🚪 [RoomPlate] 「${room}」整理结果有 ${lostMerged} 条挤不进上限，让位给快照之后新增的条目`);
    }
    return kept;
}

/**
 * 解析消化提交的候选行："[家庭] 父母离异……" → { tag: '家庭', text: '父母离异……' }。
 * 无前缀则整行作 text。
 */
export function parseSubmissionLine(line: string): { text: string; tag?: string } {
    const m = /^\s*[\[【]([^\]】]{1,6})[\]】]\s*(.+)$/s.exec(line || '');
    if (m) return { tag: m[1].trim(), text: m[2].trim() };
    return { text: (line || '').trim() };
}

/**
 * 送达保证兜底的**纯计算部分**：把消化刚提交的候选机械并进现有条目。
 * 同文本去重、容量上限、卧室命名过滤照常，不做改写重排。落库由调用方做。
 *
 * 返回 null 表示一条都没并进去（调用方据此决定要不要 bump version / 落库）。
 */
export function mergeSubmissionsIntoEntries(
    room: PlateRoom,
    existing: PlateEntry[],
    lines: string[],
    now: number,
): PlateEntry[] | null {
    const entries = [...existing];
    const seen = new Set(entries.map(e => e.text));
    let added = 0;
    for (const line of lines) {
        if (entries.length >= PLATE_ENTRY_CAPS[room]) break;
        const { text: rawText, tag } = parseSubmissionLine(line);
        const text = rawText.replace(/\s+/g, ' ').trim().slice(0, PLATE_ENTRY_HARD_MAX_CHARS);
        if (!text || seen.has(text)) continue;
        if (room === 'bedroom' && violatesBedroomRule(text)) continue;
        seen.add(text);
        entries.push({
            id: generateEntryId(),
            text,
            tag,
            firstLearnedAt: now,
            updatedAt: now,
            sourceCount: 1,
        });
        added++;
    }
    return added > 0 ? entries : null;
}

// ─── 提示词 ───────────────────────────────────────────

const ROOM_RULES: Record<PlateRoom, string> = {
    user_room:
        `想象你在为对方写一张**角色卡**——只有必须写在卡上的内容才配上这块门牌：` +
        `基础信息（身份、职业大方向、居住）、家庭结构、重要他人（人物条目格式如「TA的朋友小美：大学室友，关系铁」）、` +
        `长期相处沉淀下来的核心事实、以及重大到足以塑造TA这个人的人生节点（亲人离世、迁居他国这种量级）。` +
        `【入卡门槛极高，宁缺毋滥】阶段性状态（最近很累、工作糟心）不收；情绪分析、性格侧写不收——那是印象档案的领域；` +
        `正在进行、没有结论的事不收——那是事件盒的事，等有了结果再说。`,
    self_room:
        `我对**自己**的稳定认知：我是谁、性格底色、重要的转变、已经内化的领悟。不收对他人的看法。`,
    bedroom:
        `我们之间的**质地**：相处的习惯与仪式、只有彼此懂的梗、未言明的默契、拿不准却真实的感觉。` +
        `【硬规则】禁止给这段关系命名或分类——不得写出"我们是恋人/情侣/朋友/家人"这类定义句。` +
        `只描述现象和感受；说不清、不确定本身就是合法条目（如「我说不清我们算什么，但TA难过时第一个找的是我」）。`,
    study:
        `我的领域：我会什么、正在学什么、和对方共同钻研的东西。只收有积累的，不收一次性话题。`,
};

/**
 * 拼一次门牌整理的 system prompt。
 * 输入：每房间的现有条目（带标签）+ 新原料；期望输出：每房间完整的新条目列表。
 */
export function buildPlateConsolidationPrompt(args: {
    charName: string;
    userName: string;
    /** ContextBuilder.buildCoreContext 的产出；拿不到就传空串裸跑 */
    identityContext: string;
    plates: PlateSnapshot[];
    materials: PlateMaterial[];
}): string {
    const { charName, userName, identityContext, plates, materials } = args;
    const materialByRoom = new Map(materials.map(m => [m.room, m.lines]));

    const roomBlocks = plates.map(plate => {
        const prefix = ROOM_LABEL_PREFIX[plate.room];
        const title = plate.room === 'user_room' ? `${userName}的事` : PLATE_TITLES[plate.room];
        const existingBlock = plate.entries.length > 0
            ? plate.entries.map((text, i) => `[${prefix}${i}] ${text}`).join('\n')
            : '（还没有条目）';
        const lines = materialByRoom.get(plate.room) || [];
        const materialBlock = lines.length > 0
            ? lines.map(l => `- ${l}`).join('\n')
            : '（本轮没有新材料，仅整理现有条目）';
        return `## 门牌「${title}」(room: ${plate.room}，上限 ${PLATE_ENTRY_CAPS[plate.room]} 条)
收录范围：${ROOM_RULES[plate.room]}

现有条目：
${existingBlock}

新材料（最近的经历/结论，从中蒸馏值得常驻的认知）：
${materialBlock}`;
    }).join('\n\n');

    return `${identityContext ? `${identityContext}
---

` : ''}你是 ${charName}，${userName} 是与你朝夕相处的人。下面的材料全部来自你们相处的记忆。

你现在在独处，安静地整理自己的"底色认知"——那些不需要刻意回忆就知道的事：关于 ${userName}、关于你自己、关于你们之间。

【身份确认】「${userName}的事」只写 ${userName} 的事实；「我是谁」只写你（${charName}）自己；不要张冠李戴——材料里"我"是你，"TA/${userName}"是对方。

下面每个"门牌"给出了现有条目和新材料。请为每个门牌输出**完整的新条目列表**：

1. **合并而非追加**：现有条目想保留就必须重新输出（带 basedOn 引用它的标签）；不输出 = 淘汰。事实变了就改写（如旧条目说「住家里」、新材料说搬去和别人同住 → 改写并 basedOn 旧条目）。
2. **只收沉淀下来的**：跨时间稳定为真的认知才配上门牌。一时的状态、没结论的进行时，都不收。
3. **每条 ${PLATE_ENTRY_TARGET_CHARS} 字以内**，写梗概不写叙事，不带日期不带"我记得"。
4. **不超过各门牌的条目上限**。位置不够时留最重要的——被迫舍弃是正常的。
5. 每条给一个 **tag**（2-4 字分类，如：家庭、居住、重要他人、工作、雷区、习惯、性格、约定、默契、技能）。
6. ${userName} 直接用名字称呼。条目内容严禁使用半角双引号 "，引用一律用「」。

${roomBlocks}

严格输出 JSON 数组（没有变化的门牌也要完整输出其保留条目）：
[{"room": "user_room", "text": "……", "basedOn": "U0", "tag": "家庭"}, {"room": "bedroom", "text": "……", "basedOn": null, "tag": "默契"}]`;
}

/** 整理请求的 user 那一句（两条路共用，别各写各的） */
export const PLATE_USER_TURN = '请开始整理。';

/**
 * 从 LLM 回复里读出条目。四层容错的 JSON 解析（能从被 max_tokens 截断的响应里
 * 逐对象抢救），再滤掉 text 非字符串 / room 不是合法房间的项。
 */
export function parsePlateLlmReply(reply: string): PlateLLMItem[] {
    return safeParseJsonArray(reply || '')
        .filter(item => item && typeof item.text === 'string' && isPlateRoom(item.room)) as PlateLLMItem[];
}
