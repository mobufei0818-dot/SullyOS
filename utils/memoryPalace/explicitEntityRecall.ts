/**
 * Explicit Entity Recall — 明确实体的本地精确召回路径。
 *
 * “你还记得雾岚吗”已经给出了检索键，不应该再让 embedding 猜。这里先从当前
 * user burst 提取高置信实体，再对已经加载的 MemoryNode / EventBox 做规范化精确
 * 匹配。旧节点没有 entities 时仍会检查 tags/content，所以功能上线即可覆盖旧数据。
 */

import type { Message } from '../../types';
import type { EventBox, MemoryNode, ScoredMemory } from './types';
import { sanitizeQuerySourceMessages } from './querySanitizer';

export type ExplicitEntitySignalSource =
    | 'remember'
    | 'named'
    | 'quoted'
    | 'domain'
    | 'leading_name';

export interface ExplicitEntitySignal {
    value: string;
    normalized: string;
    source: ExplicitEntitySignalSource;
}

export interface ExplicitEntityAnalysis {
    analyzable: boolean;
    hasSignals: boolean;
    signals: ExplicitEntitySignal[];
}

export type ExplicitEntityMatchSource =
    | 'entity_name'
    | 'entity_alias'
    | 'memory_tag'
    | 'memory_content'
    | 'event_box_name'
    | 'event_box_tag';

export interface ExplicitEntityCandidate {
    node: MemoryNode;
    matchSource: ExplicitEntityMatchSource;
    matchStrength: number;
}

export interface ExplicitEntityLookupResult {
    candidates: ExplicitEntityCandidate[];
    matchedMemoryCount: number;
    matchedEventBoxCount: number;
}

const DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+(?:com|cn|net|org|io|ai|app|dev|co|me|xyz)\b/giu;
const REMEMBER_RE = /(?:还|仍然|依然|会)?(?:记得|认识|想得起)\s*(?:那个|这个|一个|叫)?\s*([a-z0-9][a-z0-9._@-]{1,63}|[\p{Script=Han}]{2,12}?)(?=(?:这个人|那个人|这个名字|那件事|这件事)?(?:吗|么|嘛|吧|呢|不|[?？。！!]|$))/giu;
const NAMED_RE = /(?:叫|名叫|名字叫)\s*([a-z0-9][a-z0-9._@-]{1,63}|[\p{Script=Han}]{2,10}?)(?=(?:的|这个|那个|人|朋友|同事|呢|吗|么|[，。！？、\s]|$))/giu;
const QUOTED_RE = /[「『“"【]([^」』”"】]{2,40})[」』”"】]/gu;
const BOOK_TITLE_RE = /《([^》]{2,40})》/gu;
const LEADING_NAME_RE = /^([a-z][a-z0-9._-]{1,40}|[\p{Script=Han}]{2,8}?)(?=(?:之前|以前|后来|是不是|有没有|怎么|又|也|呢))/iu;
const EXPLICIT_LOOKUP_CONTEXT_RE = /(?:记得|认识|想得起|叫|名字|那个人|这个人|域名|网站|账号|项目|作品|之前|以前)/u;

const REJECTED_ENTITY_KEYS = new Set([
    '我们', '你们', '他们', '她们', '它们', '自己', '对方', '别人',
    '这个', '那个', '这些', '那些', '这里', '那里', '现在', '之前', '以前',
    '朋友', '同事', '同学', '家人', '老师', '领导', '客户', '项目', '考试', '成绩',
]);

export function normalizeEntityKey(value: string): string {
    return value
        .normalize('NFKC')
        .trim()
        .toLocaleLowerCase()
        .replace(/^[\s“”‘’「」『』【】《》"']+|[\s“”‘’「」『』【】《》"']+$/gu, '')
        .replace(/\s+/gu, '');
}

function isUsableEntity(value: string): boolean {
    const key = normalizeEntityKey(value);
    if (!key || REJECTED_ENTITY_KEYS.has(key)) return false;
    const chars = Array.from(key);
    if (chars.length < 2 || chars.length > 64) return false;
    if (/^(?:我|你|他|她|它|这|那|好烦)/u.test(key)) return false;
    if (/(?:我们|你们|他们|她们|它们|之前|以前|这个|那个)/u.test(key)) return false;
    return /[\p{L}\p{N}]/u.test(key);
}

function currentUserBurst(messages: Message[]): Message[] {
    let end = messages.length - 1;
    while (end >= 0 && messages[end].role === 'system') end -= 1;
    if (end < 0 || messages[end].role !== 'user') return [];
    let start = end;
    while (start > 0 && messages[start - 1].role === 'user') start -= 1;
    return messages.slice(start, end + 1);
}

/** 返回值包含实体原文，只在本轮内存中用于检索；Trace 只记录数量和 source。 */
export function analyzeExplicitEntitySignals(
    messages: Message[],
    charName?: string,
    userName?: string,
): ExplicitEntityAnalysis {
    const safe = sanitizeQuerySourceMessages(currentUserBurst(messages), charName, userName);
    const text = safe.map(message => message.content.trim()).filter(Boolean).join('\n');
    if (!text) return { analyzable: false, hasSignals: false, signals: [] };

    const signals: ExplicitEntitySignal[] = [];
    const seen = new Set<string>();
    const participantKeys = new Set(
        [charName, userName]
            .filter((value): value is string => Boolean(value?.trim()))
            .map(normalizeEntityKey),
    );
    const add = (raw: string, source: ExplicitEntitySignalSource) => {
        const value = raw.trim();
        const normalized = normalizeEntityKey(value);
        // 角色名 / 用户自己的名字通常遍布整座宫殿，不是“稀有实体”检索键。
        if (!isUsableEntity(value) || participantKeys.has(normalized) || seen.has(normalized)) return;
        seen.add(normalized);
        signals.push({ value, normalized, source });
    };

    for (const match of text.matchAll(DOMAIN_RE)) add(match[0], 'domain');
    for (const match of text.matchAll(REMEMBER_RE)) add(match[1], 'remember');
    for (const match of text.matchAll(NAMED_RE)) add(match[1], 'named');

    // 引号/书名号本身不一定是实体；仅在句子同时带明确回看语境时采用。
    if (EXPLICIT_LOOKUP_CONTEXT_RE.test(text)) {
        for (const match of text.matchAll(QUOTED_RE)) add(match[1], 'quoted');
        for (const match of text.matchAll(BOOK_TITLE_RE)) add(match[1], 'quoted');
    }

    const leading = text.match(LEADING_NAME_RE);
    if (leading) add(leading[1], 'leading_name');

    return { analyzable: true, hasSignals: signals.length > 0, signals: signals.slice(0, 4) };
}

function containsExactEntity(text: string, signal: ExplicitEntitySignal): boolean {
    const raw = text.normalize('NFKC').toLocaleLowerCase();
    const compact = raw.replace(/\s+/gu, '');
    const key = signal.normalized;
    if (!key) return false;

    // 中文专名和域名按完整规范化串匹配；Latin 短标识需要边界，避免 csy 命中 abcsyx。
    if (/\p{Script=Han}/u.test(key) || /[.@_-]/u.test(key)) return compact.includes(key);
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'iu').test(raw);
}

function equalsEntity(value: string, signal: ExplicitEntitySignal): boolean {
    return normalizeEntityKey(value) === signal.normalized;
}

function representativeNode(box: EventBox, nodeMap: Map<string, MemoryNode>): MemoryNode | undefined {
    if (box.summaryNodeId) {
        const summary = nodeMap.get(box.summaryNodeId);
        if (summary && !summary.archived) return summary;
    }
    for (const id of box.liveMemoryIds) {
        const node = nodeMap.get(id);
        if (node && !node.archived) return node;
    }
    return undefined;
}

/**
 * 对本轮已经预取的本地节点做精确查找。MAX 很小是刻意的：明确实体命中负责保底，
 * 不是把所有提到过同一个常见人名的记忆一次性塞满 prompt。
 */
export function lookupExplicitEntityCandidates(
    analysis: ExplicitEntityAnalysis,
    nodes: MemoryNode[],
    eventBoxes: EventBox[],
    maxCandidates: number = 6,
): ExplicitEntityLookupResult {
    if (!analysis.hasSignals) {
        return { candidates: [], matchedMemoryCount: 0, matchedEventBoxCount: 0 };
    }

    const nodeMap = new Map(nodes.map(node => [node.id, node]));
    const boxMap = new Map(eventBoxes.map(box => [box.id, box]));
    const rawNodeMatches = new Map<string, ExplicitEntityCandidate>();
    const matchedBoxIds = new Set<string>();

    const record = (node: MemoryNode, matchSource: ExplicitEntityMatchSource, matchStrength: number) => {
        const existing = rawNodeMatches.get(node.id);
        if (!existing || matchStrength > existing.matchStrength) {
            rawNodeMatches.set(node.id, { node, matchSource, matchStrength });
        }
    };

    for (const node of nodes) {
        for (const signal of analysis.signals) {
            let matched = false;
            for (const entity of node.entities || []) {
                if (equalsEntity(entity.name, signal)) {
                    record(node, 'entity_name', 1);
                    matched = true;
                    break;
                }
                if ((entity.aliases || []).some(alias => equalsEntity(alias, signal))) {
                    record(node, 'entity_alias', 0.96);
                    matched = true;
                    break;
                }
            }
            if (matched) continue;
            if (node.tags.some(tag => equalsEntity(tag, signal))) {
                record(node, 'memory_tag', 0.92);
            } else if (containsExactEntity(node.content, signal)) {
                record(node, 'memory_content', 0.86);
            }
        }
    }

    const eventBoxMatches: ExplicitEntityCandidate[] = [];
    for (const box of eventBoxes) {
        for (const signal of analysis.signals) {
            let source: ExplicitEntityMatchSource | null = null;
            let strength = 0;
            if (equalsEntity(box.name, signal) || containsExactEntity(box.name, signal)) {
                source = 'event_box_name';
                strength = 0.98;
            } else if (box.tags.some(tag => equalsEntity(tag, signal))) {
                source = 'event_box_tag';
                strength = 0.93;
            }
            if (!source) continue;
            const node = representativeNode(box, nodeMap);
            if (node) {
                matchedBoxIds.add(box.id);
                eventBoxMatches.push({ node, matchSource: source, matchStrength: strength });
            }
            break;
        }
    }

    // archived 命中不能直接交给 formatter（会被过滤）；映射到所属 EventBox 的 summary/live 代表。
    const resolved: ExplicitEntityCandidate[] = [];
    for (const hit of rawNodeMatches.values()) {
        if (!hit.node.archived) {
            resolved.push(hit);
            continue;
        }
        const box = hit.node.eventBoxId ? boxMap.get(hit.node.eventBoxId) : undefined;
        const node = box ? representativeNode(box, nodeMap) : undefined;
        if (box && node) {
            matchedBoxIds.add(box.id);
            resolved.push({ node, matchSource: hit.matchSource, matchStrength: hit.matchStrength });
        }
    }
    resolved.push(...eventBoxMatches);

    const deduped = new Map<string, ExplicitEntityCandidate>();
    for (const candidate of resolved) {
        const existing = deduped.get(candidate.node.id);
        if (!existing || candidate.matchStrength > existing.matchStrength) {
            deduped.set(candidate.node.id, candidate);
        }
    }

    const candidates = [...deduped.values()]
        .sort((a, b) => {
            if (b.matchStrength !== a.matchStrength) return b.matchStrength - a.matchStrength;
            if (b.node.importance !== a.node.importance) return b.node.importance - a.node.importance;
            return b.node.createdAt - a.node.createdAt;
        })
        .slice(0, Math.max(0, maxCandidates));

    return {
        candidates,
        matchedMemoryCount: rawNodeMatches.size,
        matchedEventBoxCount: matchedBoxIds.size,
    };
}

/** 精确命中使用独立高分保底，剩余 formatter quota 仍由原 hybrid recall 竞争。 */
export function mergeExplicitEntityCandidates(
    semanticResults: ScoredMemory[],
    explicitCandidates: ExplicitEntityCandidate[],
): ScoredMemory[] {
    const merged = new Map(semanticResults.map(result => [result.node.id, result]));
    explicitCandidates.forEach((candidate, index) => {
        const guaranteedScore = 1.6 - index * 0.01;
        const existing = merged.get(candidate.node.id);
        if (existing) {
            merged.set(candidate.node.id, {
                ...existing,
                finalScore: Math.max(existing.finalScore, guaranteedScore),
                roomScore: Math.max(existing.roomScore, guaranteedScore),
                recallGuarantee: 'explicit_entity',
            });
        } else {
            merged.set(candidate.node.id, {
                node: candidate.node,
                finalScore: guaranteedScore,
                similarity: 0,
                bm25Score: 0,
                roomScore: guaranteedScore,
                recallGuarantee: 'explicit_entity',
            });
        }
    });
    return [...merged.values()].sort((a, b) => b.finalScore - a.finalScore);
}
