import { beforeEach, describe, expect, it } from 'vitest';

import type { Message } from '../../types';
import type { EventBox, MemoryNode, ScoredMemory } from './types';
import { injectMemoryPalace } from './pipeline';
import {
    analyzeExplicitEntitySignals,
    lookupExplicitEntityCandidates,
    mergeExplicitEntityCandidates,
} from './explicitEntityRecall';

let nextMessageId = 1;
const message = (content: string): Message => ({
    id: nextMessageId++,
    charId: 'char-entity',
    role: 'user',
    type: 'text',
    content,
    timestamp: nextMessageId,
});

const node = (id: string, content: string, overrides: Partial<MemoryNode> = {}): MemoryNode => ({
    id,
    charId: 'char-entity',
    content,
    room: 'user_room',
    tags: [],
    importance: 5,
    mood: 'neutral',
    embedded: true,
    createdAt: 100,
    lastAccessedAt: 100,
    accessCount: 0,
    eventBoxId: null,
    ...overrides,
});

const box = (overrides: Partial<EventBox> = {}): EventBox => ({
    id: 'box-wulan',
    charId: 'char-entity',
    name: '和雾岚的搬家事件',
    tags: ['雾岚', '搬家'],
    summaryNodeId: 'summary-wulan',
    liveMemoryIds: [],
    archivedMemoryIds: ['archived-wulan'],
    compressionCount: 1,
    createdAt: 100,
    updatedAt: 100,
    lastCompressedAt: 100,
    ...overrides,
});

describe('Explicit Entity Recall M1.1.5', () => {
    beforeEach(() => {
        nextMessageId = 1;
        localStorage.clear();
    });

    it.each([
        ['你还记得雾岚吗', '雾岚', 'remember'],
        ['之前那个叫小明的人呢', '小明', 'named'],
        ['sully.com那个域名还记得吗', 'sully.com', 'domain'],
        ['小红是不是以前也干过这个', '小红', 'leading_name'],
    ])('extracts an explicit lookup key from %s', (content, expected, source) => {
        const analysis = analyzeExplicitEntitySignals([message(content)]);

        expect(analysis.hasSignals).toBe(true);
        expect(analysis.signals).toEqual(expect.arrayContaining([
            expect.objectContaining({ value: expected, source }),
        ]));
    });

    it.each([
        '好烦他又来了',
        '之前我们是不是聊过类似的事情',
        '我以前是不是有过类似经历',
        '你还记得我吗',
    ])('does not mistake a pronoun or semantic recollection for an entity: %s', (content) => {
        expect(analyzeExplicitEntitySignals([message(content)]).hasSignals).toBe(false);
    });

    it('does not use the current user or character name as a rare-entity key', () => {
        expect(analyzeExplicitEntitySignals([message('你还记得测试用户吗')], '测试角色', '测试用户').hasSignals).toBe(false);
        expect(analyzeExplicitEntitySignals([message('你还记得测试角色吗')], '测试角色', '测试用户').hasSignals).toBe(false);
    });

    it('finds all rare-name memories through entities, tags, and legacy content', () => {
        const analysis = analyzeExplicitEntitySignals([message('你还记得雾岚吗')]);
        const nodes = [
            node('entity', '以前一起吃过饭', { entities: [{ name: '雾岚', type: 'person' }] }),
            node('tag', '她当时帮忙搬过家', { tags: ['雾岚', '搬家'] }),
            node('legacy', '之前和雾岚聊到过换工作的事'),
            node('other', '和另一个朋友聊过工作', { importance: 10 }),
        ];

        const lookup = lookupExplicitEntityCandidates(analysis, nodes, []);

        expect(lookup.matchedMemoryCount).toBe(3);
        expect(lookup.candidates.map(candidate => candidate.node.id)).toEqual(['entity', 'tag', 'legacy']);
    });

    it('uses a stored alias but does not infer aliases on its own', () => {
        const analysis = analyzeExplicitEntitySignals([message('你还记得小岚吗')]);
        const nodes = [
            node('alias', '雾岚说过那件事', { entities: [{ name: '雾岚', type: 'person', aliases: ['小岚'] }] }),
            node('canonical-only', '另一次谈到雾岚', { entities: [{ name: '雾岚', type: 'person' }] }),
        ];

        const lookup = lookupExplicitEntityCandidates(analysis, nodes, []);

        expect(lookup.candidates.map(candidate => candidate.node.id)).toEqual(['alias']);
        expect(lookup.candidates[0].matchSource).toBe('entity_alias');
    });

    it('routes archived entity hits to their EventBox representative', () => {
        const analysis = analyzeExplicitEntitySignals([message('你还记得雾岚吗')]);
        const nodes = [
            node('archived-wulan', '雾岚搬家时我们去帮忙了', { archived: true, eventBoxId: 'box-wulan' }),
            node('summary-wulan', '这是和雾岚搬家有关的一整段回忆', {
                isBoxSummary: true,
                eventBoxId: 'box-wulan',
                importance: 8,
            }),
        ];

        const lookup = lookupExplicitEntityCandidates(analysis, nodes, [box()]);

        expect(lookup.matchedMemoryCount).toBe(2);
        expect(lookup.matchedEventBoxCount).toBe(1);
        expect(lookup.candidates).toHaveLength(1);
        expect(lookup.candidates[0].node.id).toBe('summary-wulan');
    });

    it('keeps exact Latin identifiers on token boundaries', () => {
        const analysis = analyzeExplicitEntitySignals([message('你还记得csy吗')]);
        const nodes = [
            node('exact', 'csy之前提到过这个'),
            node('substring', 'abcsyx之前提到过这个'),
        ];

        expect(lookupExplicitEntityCandidates(analysis, nodes, []).candidates.map(hit => hit.node.id))
            .toEqual(['exact']);
    });

    it('guarantees explicit hits above a full semantic candidate list', () => {
        const semantic: ScoredMemory[] = Array.from({ length: 15 }, (_, index) => ({
            node: node(`semantic-${index}`, `普通候选 ${index}`),
            finalScore: 1 - index * 0.01,
            similarity: 1,
            bm25Score: 0,
            roomScore: 1 - index * 0.01,
        }));
        const explicitNodes = [node('wulan-1', '雾岚记忆一'), node('wulan-2', '雾岚记忆二')];

        const merged = mergeExplicitEntityCandidates(semantic, explicitNodes.map(item => ({
            node: item,
            matchSource: 'memory_content' as const,
            matchStrength: 0.86,
        })));

        expect(merged.slice(0, 2).map(result => result.node.id)).toEqual(['wulan-1', 'wulan-2']);
        // 精确实体是加法支路：两条保底命中之外，旧 hybrid recall 的候选必须完整保留。
        expect(merged).toHaveLength(semantic.length + explicitNodes.length);
        expect(semantic.every(item => merged.some(result => result.node.id === item.node.id))).toBe(true);
    });

    it('records explicit_entity while the local analyzer remains observable', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { recallRouter: true },
        }));

        const trace = await injectMemoryPalace(
            { id: 'char-entity', memoryPalaceEnabled: false },
            [message('你还记得雾岚吗')],
            undefined,
            undefined,
            { entryPoint: 'chat_app' },
        );

        expect(trace.recallIntent).toBe('explicit_entity');
        expect(trace.recallResolver).toEqual({ status: 'deferred' });
        expect(trace.contextAnalyzer?.signals.explicitEntity).toBe(1);
        expect(trace.explicitEntityRecall).toMatchObject({
            status: 'signaled',
            signalCount: 1,
            signalSources: ['remember'],
        });
        expect(trace.stages.some(stage => stage.name === 'explicit_signal')).toBe(true);
        expect(trace.stages.some(stage => stage.name === 'context_analyzer')).toBe(true);
    });
});
