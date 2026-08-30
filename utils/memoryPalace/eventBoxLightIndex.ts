/**
 * EventBox Light Index (M1.3)
 *
 * Router 已经把模糊承接改写成 event_box query 时，本模块用纯本地倒排索引补查
 * box.name / tags / summary / live nodes。它只给旧 hybrid recall 增加候选：
 * 不调用 LLM、不调用 embedding，也不删除或替换旧召回结果。
 */

import type { RecallQuery } from './recallRouter';
import type { EventBox, MemoryNode, ScoredMemory } from './types';

export type EventBoxLightMatchSource =
    | 'box_name'
    | 'box_tag'
    | 'summary_entity'
    | 'summary_tag'
    | 'summary_content'
    | 'live_entity'
    | 'live_tag'
    | 'live_content';

export interface EventBoxLightCandidate {
    boxId: string;
    node: MemoryNode;
    score: number;
    queryWeight: number;
    matchSource: EventBoxLightMatchSource;
}

export interface EventBoxLightLookupResult {
    candidates: EventBoxLightCandidate[];
    matchedBoxCount: number;
}

interface IndexedField {
    source: EventBoxLightMatchSource;
    normalized: string;
    tokens: Set<string>;
    ceiling: number;
}

interface EventBoxLightDocument {
    boxId: string;
    representative: MemoryNode;
    fields: IndexedField[];
}

export interface EventBoxLightIndex {
    documents: Map<string, EventBoxLightDocument>;
    postings: Map<string, Set<string>>;
    indexedBoxCount: number;
}

const GENERIC_TERMS = [
    '那个', '这个', '那些', '这些', '事情', '事件', '之前', '以前', '后来', '然后',
    '结果', '进度', '情况', '怎么', '怎样', '还是', '已经', '现在', '一次', '一下',
    '一个', '没有', '可以', '就是', '什么', '记忆', '记得', '我们', '你们', '他们',
] as const;

const GENERIC_TOKEN_SET = new Set<string>(GENERIC_TERMS);

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

export function normalizeEventBoxIndexText(value: string): string {
    return value
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/gu, ' ');
}

function removeGenericTerms(value: string): string {
    let cleaned = value;
    for (const term of GENERIC_TERMS) cleaned = cleaned.replaceAll(term, ' ');
    return cleaned.replace(/\s+/gu, ' ').trim();
}

function addCharacterNgrams(tokens: Set<string>, chunk: string): void {
    const chars = Array.from(chunk);
    if (chars.length >= 2 && chars.length <= 32) tokens.add(chunk);
    for (let size = 2; size <= Math.min(4, chars.length); size += 1) {
        for (let index = 0; index <= chars.length - size; index += 1) {
            const token = chars.slice(index, index + size).join('');
            if (!GENERIC_TOKEN_SET.has(token)) tokens.add(token);
        }
    }
}

function tokenizeForIndex(value: string, stripGenericTerms: boolean = false): Set<string> {
    const normalized = normalizeEventBoxIndexText(value);
    const prepared = stripGenericTerms ? removeGenericTerms(normalized) : normalized;
    const tokens = new Set<string>();
    for (const chunk of prepared.split(' ').filter(Boolean)) {
        if (/\p{Script=Han}/u.test(chunk)) {
            addCharacterNgrams(tokens, chunk);
        } else if (chunk.length >= 2 && !GENERIC_TOKEN_SET.has(chunk)) {
            tokens.add(chunk);
        }
    }
    return tokens;
}

function representativeNode(box: EventBox, nodeMap: Map<string, MemoryNode>): MemoryNode | undefined {
    if (box.summaryNodeId) {
        const summary = nodeMap.get(box.summaryNodeId);
        if (summary && !summary.archived) return summary;
    }
    return box.liveMemoryIds
        .map(id => nodeMap.get(id))
        .filter((node): node is MemoryNode => Boolean(node && !node.archived))
        .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)[0];
}

function makeField(source: EventBoxLightMatchSource, value: string, ceiling: number): IndexedField | null {
    const normalized = normalizeEventBoxIndexText(value);
    if (!normalized) return null;
    const tokens = tokenizeForIndex(value);
    if (tokens.size === 0) return null;
    return { source, normalized, tokens, ceiling };
}

function entityValues(node: MemoryNode): string[] {
    return (node.entities || []).flatMap(entity => [entity.name, ...(entity.aliases || [])]);
}

/** 构建一次请求内使用的本地倒排；不持久化，因此不存在过期索引。 */
export function buildEventBoxLightIndex(nodes: MemoryNode[], eventBoxes: EventBox[]): EventBoxLightIndex {
    const nodeMap = new Map(nodes.map(node => [node.id, node]));
    const documents = new Map<string, EventBoxLightDocument>();
    const postings = new Map<string, Set<string>>();

    for (const box of eventBoxes) {
        const representative = representativeNode(box, nodeMap);
        if (!representative) continue;

        const fields: IndexedField[] = [];
        const add = (source: EventBoxLightMatchSource, value: string, ceiling: number) => {
            const field = makeField(source, value, ceiling);
            if (field) fields.push(field);
        };

        add('box_name', box.name, 1);
        box.tags.forEach(tag => add('box_tag', tag, 0.95));

        const summary = box.summaryNodeId ? nodeMap.get(box.summaryNodeId) : undefined;
        if (summary) {
            entityValues(summary).forEach(entity => add('summary_entity', entity, 0.96));
            summary.tags.forEach(tag => add('summary_tag', tag, 0.9));
            add('summary_content', summary.content.slice(0, 1200), 0.76);
        }

        for (const id of box.liveMemoryIds) {
            const node = nodeMap.get(id);
            if (!node || node.archived) continue;
            entityValues(node).forEach(entity => add('live_entity', entity, 0.92));
            node.tags.forEach(tag => add('live_tag', tag, 0.86));
            add('live_content', node.content.slice(0, 900), 0.68);
        }

        if (fields.length === 0) continue;
        documents.set(box.id, { boxId: box.id, representative, fields });
        for (const field of fields) {
            for (const token of field.tokens) {
                const boxIds = postings.get(token) ?? new Set<string>();
                boxIds.add(box.id);
                postings.set(token, boxIds);
            }
        }
    }

    return { documents, postings, indexedBoxCount: documents.size };
}

function scoreField(queryNormalized: string, queryTokens: Set<string>, field: IndexedField): number {
    const queryCompact = queryNormalized.replace(/\s+/gu, '');
    const fieldCompact = field.normalized.replace(/\s+/gu, '');
    if (!queryCompact || !fieldCompact || queryTokens.size === 0) return 0;
    if (queryCompact === fieldCompact) return field.ceiling;

    const shorterLength = Math.min(Array.from(queryCompact).length, Array.from(fieldCompact).length);
    if (shorterLength >= 3 && (queryCompact.includes(fieldCompact) || fieldCompact.includes(queryCompact))) {
        return field.ceiling * 0.94;
    }

    let overlap = 0;
    for (const token of queryTokens) {
        if (field.tokens.has(token)) overlap += 1;
    }
    const coverage = overlap / queryTokens.size;
    if (coverage < 0.45) return 0;
    return field.ceiling * (0.42 + 0.52 * coverage);
}

/**
 * 只消费 Router 明确标成 event_box 的 query。查询先通过 postings 缩小盒集合，
 * 再在候选盒内按 name/tag/entity/content 的可靠性分层打分。
 */
export function lookupEventBoxLightCandidates(
    index: EventBoxLightIndex,
    queries: ReadonlyArray<Pick<RecallQuery, 'text' | 'weight' | 'scope'>>,
    maxCandidates: number = 4,
): EventBoxLightLookupResult {
    const bestByBox = new Map<string, EventBoxLightCandidate>();

    for (const query of queries) {
        if (query.scope !== 'event_box') continue;
        const normalized = normalizeEventBoxIndexText(query.text);
        const queryTokens = tokenizeForIndex(query.text, true);
        if (!normalized || queryTokens.size === 0) continue;

        const candidateBoxIds = new Set<string>();
        for (const token of queryTokens) {
            for (const boxId of index.postings.get(token) || []) candidateBoxIds.add(boxId);
        }

        for (const boxId of candidateBoxIds) {
            const document = index.documents.get(boxId);
            if (!document) continue;
            let bestScore = 0;
            let bestSource: EventBoxLightMatchSource = 'box_name';
            for (const field of document.fields) {
                const score = scoreField(normalized, queryTokens, field);
                if (score > bestScore) {
                    bestScore = score;
                    bestSource = field.source;
                }
            }
            if (bestScore < 0.58) continue;
            const candidate: EventBoxLightCandidate = {
                boxId,
                node: document.representative,
                score: clamp01(bestScore),
                queryWeight: clamp01(query.weight),
                matchSource: bestSource,
            };
            const existing = bestByBox.get(boxId);
            const weighted = candidate.score * (0.65 + 0.35 * candidate.queryWeight);
            const existingWeighted = existing
                ? existing.score * (0.65 + 0.35 * existing.queryWeight)
                : -1;
            if (!existing || weighted > existingWeighted) bestByBox.set(boxId, candidate);
        }
    }

    const candidates = [...bestByBox.values()]
        .sort((a, b) => {
            const aScore = a.score * (0.65 + 0.35 * a.queryWeight);
            const bScore = b.score * (0.65 + 0.35 * b.queryWeight);
            return bScore - aScore
                || b.node.importance - a.node.importance
                || b.node.createdAt - a.node.createdAt;
        })
        .slice(0, Math.max(0, maxCandidates));

    return { candidates, matchedBoxCount: bestByBox.size };
}

/**
 * M1.3 的核心不变量：先完整保留 semanticResults，再添加/抬高盒候选。
 * 不设置 recallGuarantee；EventBox 推断仍需与旧召回结果共同竞争 formatter quota。
 */
export function mergeEventBoxLightCandidates(
    semanticResults: ScoredMemory[],
    eventBoxCandidates: EventBoxLightCandidate[],
    routerConfidence: number,
): ScoredMemory[] {
    const merged = new Map(semanticResults.map(result => [result.node.id, result]));
    const confidenceFactor = 0.75 + 0.25 * clamp01(routerConfidence);

    for (const candidate of eventBoxCandidates) {
        const weightFactor = 0.65 + 0.35 * candidate.queryWeight;
        const metadataScore = 0.7 + 0.4 * candidate.score * weightFactor * confidenceFactor;
        const existing = merged.get(candidate.node.id);
        if (existing) {
            merged.set(candidate.node.id, {
                ...existing,
                finalScore: Math.max(existing.finalScore, metadataScore),
                roomScore: Math.max(existing.roomScore, metadataScore),
            });
        } else {
            merged.set(candidate.node.id, {
                node: candidate.node,
                finalScore: metadataScore,
                similarity: 0,
                bm25Score: 0,
                roomScore: metadataScore,
            });
        }
    }

    return [...merged.values()].sort((a, b) => b.finalScore - a.finalScore);
}
