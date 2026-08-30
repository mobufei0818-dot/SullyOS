// blobref 令牌合并——「同一张图在库里存了好几份」的收尾那一半。
//
// 重复是这么长出来的：同一张图有好几条互不相识的迁移入口（壁纸加载器的惰性迁移、
// 「优化资源存储」的批量转换、外观预设导入……），各 put 各的，于是令牌不同、内容
// 逐字节相同。SDK 负责「找出哪些令牌装的是同一份内容」，本文件负责宿主特有的另一半：
// 把重复令牌在**全部引用面**上改写成组内保留的那个（canonical）。
//
// 改完不删 Blob。失去引用的那几份自然变成孤儿，交给已有的孤儿 GC（utils/blobGc.ts）收——
// 删除不可逆，走那条已经带着安全阀（新鲜豁免、整轮放弃）的老路，比在这里现删稳当。
//
// ─── 引用面与 GC 同源 ───
// 面的清单直接复用 blobGc 的 REF_SOURCE_STORES + localStorage 全量，两边永远一致：
// GC 能 mark 到的地方，这里就能改写到（blobDedupe.test.ts 有守卫钉这条）。
// 万一漏了某个面，那个面会继续指着旧令牌 —— 旧 Blob 因此仍被引用、GC 也不会删它，
// 方向是安全的（少省一点空间，不会破图）。
//
// ─── 有一批令牌不参与合并 ───
// 合并会让两个原本各存一份的字段共享同一个 Blob。多数面无所谓（它们要么不删、要么删
// 之前先查引用），但有几个字段的删除是裸删（deleteBlobRef）：它们的图来自用户当场选的
// 文件，一份令牌只归自己，所以换图 / 移除时直接把旧 Blob 删掉。一旦合并让它和别处共享，
// 那一删就把别人的图也删了。collectUnmergeableRefs 把这些令牌捞出来，整组跳过。
//
// ─── 为什么不 JSON.stringify 整行再字符串替换 ───
// 那样写回时得 JSON.parse 回来，行里的 Blob / Date / undefined 字段会被顺手毁掉。
// 这里改成深度遍历、只碰 string 值：普通对象和数组往下走，其余（Blob、Date、Map、
// TypedArray……）一律不进去翻。嵌套 JSON 字符串（如 assets 的 appearance_preset_*）
// 里的令牌照样命中——令牌在 JSON 文本里也是原样的一段纯文本。

import { DB } from './db';
import { BLOBREF_PREFIX, getBlobForRef } from './blobRef';
import { REF_SOURCE_STORES } from './blobGc';

// 与 blobGc 的分页大小同值：批间事务各自独立，内存峰值只有一批。
const PAGE_SIZE = 200;

// 令牌整体匹配：前缀 + 最长的 [A-Za-z0-9_] 段。字符集与 SDK 的 extractRefs / GC 同源，
// 贪婪到边界为止，所以「A 是 B 的前缀」这种令牌（blobref:b_x 与 blobref:b_x_y）不会
// 被切错——匹配出来的永远是完整的那个，再拿去查 mapping，命不中就原样留下。
const TOKEN_PATTERN = new RegExp(
    `${BLOBREF_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[A-Za-z0-9_]+`,
    'g',
);

/**
 * 一段文本里的令牌按 mapping 改写；表里没有的原样留下。
 * 传了 hits 就把真正改掉的那些令牌记进去——调用方据此如实统计「实际合并了几份」，
 * 而不是按计划数虚报（计划里的令牌可能早就没人引用了）。
 */
export function rewriteRefsInText(text: string, mapping: Map<string, string>, hits?: Set<string>): string {
    return text.replace(TOKEN_PATTERN, m => {
        const to = mapping.get(m);
        if (to === undefined) return m;
        hits?.add(m);
        return to;
    });
}

/** 只有「普通对象」才往下翻。Blob / File / Date / Map / Set / TypedArray 全被这道判断挡在外面。 */
const isPlainContainer = (v: object): boolean => Object.prototype.toString.call(v) === '[object Object]';

/** 原地改写容器里某个位置的值，返回是否动过。 */
function rewriteSlot(
    container: any, key: string | number, mapping: Map<string, string>,
    seen: WeakSet<object>, hits?: Set<string>,
): boolean {
    const value = container[key];
    if (typeof value === 'string') {
        const next = rewriteRefsInText(value, mapping, hits);
        if (next === value) return false;
        container[key] = next;
        return true;
    }
    if (value && typeof value === 'object') return rewriteRefsDeep(value, mapping, seen, hits);
    return false;
}

/**
 * 深度遍历对象树，原地把令牌改写成 canonical，返回是否动过。
 * seen 挡循环引用（角色行里的对象图不保证是树）。
 */
export function rewriteRefsDeep(
    root: object, mapping: Map<string, string>,
    seen: WeakSet<object> = new WeakSet(), hits?: Set<string>,
): boolean {
    if (seen.has(root)) return false;
    seen.add(root);

    let changed = false;
    if (Array.isArray(root)) {
        for (let i = 0; i < root.length; i++) {
            if (rewriteSlot(root, i, mapping, seen, hits)) changed = true;
        }
        return changed;
    }
    if (!isPlainContainer(root)) return false;
    for (const key of Object.keys(root)) {
        if (rewriteSlot(root, key, mapping, seen, hits)) changed = true;
    }
    return changed;
}

export interface RewriteRefsResult {
    /** 被改写并写回的表行数 */
    rewrittenRows: number;
    /** 被改写并写回的 localStorage 键数 */
    rewrittenLocalKeys: number;
    /** 扫过的表行总数（进度/体感用） */
    scannedRows: number;
    /**
     * 真正改掉的那些重复令牌。映射里的令牌不一定都还有人引用——上一轮合并留下的
     * 孤儿 Blob 还躺在库里，下一轮扫描照样把它当重复报出来。按这个集合统计才不会虚报。
     */
    mergedRefs: Set<string>;
}

/**
 * 把 mapping 里的重复令牌在全部引用面上改写成 canonical。
 *
 * 调用方须先持有 maintenanceLock：改写是「引用搬家」，撞上 GC 进行中的 mark 会让
 * 同一个令牌在两个面之间瞬间消失，被误判成孤儿删掉（SDK README 的宿主义务之一）。
 *
 * mapping 必须是「一跳到底」的：canonical 自己不能再是别人的 key，否则改写完还剩一层
 * 指向，两轮结果不一致。入参不合格直接抛，不猜意图。
 */
export async function rewriteBlobRefs(
    mapping: Map<string, string>,
    opts: { onProgress?: (scannedRows: number) => void } = {},
): Promise<RewriteRefsResult> {
    const result: RewriteRefsResult = {
        rewrittenRows: 0, rewrittenLocalKeys: 0, scannedRows: 0, mergedRefs: new Set(),
    };
    if (mapping.size === 0) return result;

    // ── 入参体检（都是「改错了不可逆」的前提，宁可吵着抛）──
    const canonicals = new Set(mapping.values());
    for (const [from, to] of mapping) {
        if (from === to) throw new Error(`合并映射非法：${from} 指向自己。`);
        if (canonicals.has(from)) throw new Error(`合并映射非法：${from} 既是被合并方又是保留方，需先收敛成一跳。`);
    }
    // canonical 必须真有 Blob 在——把好引用改到一个空令牌上就是实打实的破图。
    for (const canonical of canonicals) {
        if (!(await getBlobForRef(canonical))) {
            throw new Error(`合并映射非法：保留方 ${canonical} 读不到 Blob，已中止（引用未改动）。`);
        }
    }

    // ── 表面：分页读 → 原地改 → 脏行写回 ──
    for (const storeName of REF_SOURCE_STORES) {
        let afterKey: IDBValidKey | null = null;
        for (;;) {
            const { rows, lastKey } = await DB.getStoreRowsPage(storeName, afterKey, PAGE_SIZE);
            const dirty: unknown[] = [];
            for (const row of rows) {
                result.scannedRows++;
                if (!row || typeof row !== 'object') continue;
                if (rewriteRefsDeep(row as object, mapping, new WeakSet(), result.mergedRefs)) dirty.push(row);
            }
            if (dirty.length > 0) {
                await DB.putStoreRows(storeName, dirty);
                result.rewrittenRows += dirty.length;
            }
            opts.onProgress?.(result.scannedRows);
            if (lastKey === null || rows.length < PAGE_SIZE) break;
            afterKey = lastKey;
        }
    }

    // ── localStorage 面：先把键快照下来再逐条改，避免边写边移位漏扫 ──
    if (typeof localStorage !== 'undefined') {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key !== null) keys.push(key);
        }
        for (const key of keys) {
            const value = localStorage.getItem(key);
            if (value === null) continue;
            const next = rewriteRefsInText(value, mapping, result.mergedRefs);
            if (next === value) continue;
            localStorage.setItem(key, next);
            result.rewrittenLocalKeys++;
        }
    }

    return result;
}


// ─── 不参与合并的令牌 ───────────────────────────────────────────

/**
 * 裸删（deleteBlobRef，而不是 deleteBlobRefIfUnreferenced）的字段清单。
 * 这几个字段换图 / 移除时会直接删掉旧 Blob，前提是「这份令牌只归我」——
 * 合并一旦让它和别处共享，那一删就连别人的图一起删了。
 *
 * | 字段 | 裸删发生在 |
 * |---|---|
 * | characters.companionAvatar.imageRef | apps/Appearance.tsx（换图 / 移除桌面静态形象） |
 * | characters.companionAvatar.imageWardrobe[].imageRef | 同上：衣柜条目跟顶层 imageRef 共用同一个
 * |                                     | 令牌（令牌兼任条目 id，见 utils/companionWardrobe.ts），
 * |                                     | 换图时衣柜里没留着这套就跟着一起删 |
 * | characters.videoCallBackground      | apps/CallApp.tsx（换 / 清视频舞台背景） |
 * | characters.companionBackground      | components/os/CompanionHome.tsx（换 / 清桌面背景） |
 * | messages.metadata.cameraSnapshotRef | apps/CallApp.tsx（快照替换 / 过期淘汰 / 删通话记录） |
 * | localStorage 假摄像头图片            | apps/CallApp.tsx（换图 / 移除假摄像头） |
 *
 * ⚠️ 新增 deleteBlobRef 的裸删调用点时，把那个字段一并加进来（blobRef.ts 的
 *    deleteBlobRef 注释里也指着这份清单）。漏登记的后果是那个字段的图可能被别处删掉。
 */
const UNMERGEABLE_LOCAL_KEYS = ['sully-call-fake-camera-image-v1'] as const;

/** 捞出所有「不能参与合并」的令牌。读不出来就上抛——宁可整轮不合并，也不能漏登记。 */
export async function collectUnmergeableRefs(): Promise<Set<string>> {
    const refs = new Set<string>();
    const take = (v: unknown) => {
        if (typeof v === 'string' && v.startsWith(BLOBREF_PREFIX)) refs.add(v);
    };

    let afterKey: IDBValidKey | null = null;
    for (;;) {
        const { rows, lastKey } = await DB.getStoreRowsPage('characters', afterKey, PAGE_SIZE);
        for (const row of rows as any[]) {
            if (!row || typeof row !== 'object') continue;
            take(row.companionAvatar?.imageRef);
            // 衣柜条目：令牌同时占着 id 和 imageRef 两个值位，两个都收——只登记一半的话，
            // 另一半仍会被当成普通令牌合并进共享组。
            const wardrobe = row.companionAvatar?.imageWardrobe;
            if (Array.isArray(wardrobe)) {
                for (const outfit of wardrobe) {
                    take(outfit?.imageRef);
                    take(outfit?.id);
                }
            }
            take(row.videoCallBackground);
            take(row.companionBackground);
        }
        if (lastKey === null || rows.length < PAGE_SIZE) break;
        afterKey = lastKey;
    }

    afterKey = null;
    for (;;) {
        const { rows, lastKey } = await DB.getStoreRowsPage('messages', afterKey, PAGE_SIZE);
        for (const row of rows as any[]) {
            if (!row || typeof row !== 'object') continue;
            take(row.metadata?.cameraSnapshotRef);
        }
        if (lastKey === null || rows.length < PAGE_SIZE) break;
        afterKey = lastKey;
    }

    if (typeof localStorage !== 'undefined') {
        for (const key of UNMERGEABLE_LOCAL_KEYS) take(localStorage.getItem(key));
    }
    return refs;
}

/** SDK scanContent 吐出来的重复组（只取本文件用得着的字段）。 */
export interface DuplicateGroupLike {
    canonical: string;
    duplicates: string[];
    size: number;
    wastedBytes: number;
}

export interface MergePlan {
    /** 重复令牌 → 保留令牌。可直接喂给 rewriteBlobRefs */
    mapping: Map<string, string>;
    /** 每个重复令牌对应的字节数——按「实际改写掉的那些」求和才是真能回收的空间 */
    bytesByToken: Map<string, number>;
    /** 因为触到裸删字段而整组跳过的组数 */
    skippedGroups: number;
    /** 合并后能让 GC 回收的字节数（只算真的会合并的那些组） */
    reclaimableBytes: number;
}

/**
 * 把扫描结果收敛成一份「一跳到底」的合并映射。
 * 只要组里有任何一个令牌被裸删字段引用着，整组跳过——保留方也可能是那一个，
 * 只剔掉单个令牌并不能让剩下的变安全。
 */
export function buildMergePlan(
    groups: readonly DuplicateGroupLike[],
    unmergeable: ReadonlySet<string>,
): MergePlan {
    const plan: MergePlan = { mapping: new Map(), bytesByToken: new Map(), skippedGroups: 0, reclaimableBytes: 0 };
    for (const group of groups) {
        if (group.duplicates.length === 0) continue;
        if (unmergeable.has(group.canonical) || group.duplicates.some(t => unmergeable.has(t))) {
            plan.skippedGroups++;
            continue;
        }
        for (const dup of group.duplicates) {
            plan.mapping.set(dup, group.canonical);
            plan.bytesByToken.set(dup, group.size);
        }
        plan.reclaimableBytes += group.wastedBytes;
    }
    return plan;
}
