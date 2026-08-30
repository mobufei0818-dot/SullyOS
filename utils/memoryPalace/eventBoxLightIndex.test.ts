import { describe, expect, it } from 'vitest';

import type { EventBox, MemoryNode, ScoredMemory } from './types';
import {
    buildEventBoxLightIndex,
    lookupEventBoxLightCandidates,
    mergeEventBoxLightCandidates,
} from './eventBoxLightIndex';

const node = (id: string, content: string, overrides: Partial<MemoryNode> = {}): MemoryNode => ({
    id,
    charId: 'char-event-box',
    content,
    room: 'study',
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
    id: 'box-exam',
    charId: 'char-event-box',
    name: '雾港观测员资格考试',
    tags: ['考试', '虚构资格'],
    summaryNodeId: 'summary-exam',
    liveMemoryIds: [],
    archivedMemoryIds: [],
    compressionCount: 1,
    createdAt: 100,
    updatedAt: 100,
    lastCompressedAt: 100,
    ...overrides,
});

const eventQuery = (text: string, weight: number = 0.9) => ({
    text,
    scope: 'event_box' as const,
    weight,
});

describe('EventBox Light Index M1.3', () => {
    it('finds a box name and returns its summary representative', () => {
        const summary = node('summary-exam', '这段记忆总结了考试准备和最终成绩。', {
            eventBoxId: 'box-exam',
            isBoxSummary: true,
            importance: 8,
        });
        const index = buildEventBoxLightIndex([summary], [box()]);
        const lookup = lookupEventBoxLightCandidates(index, [eventQuery('雾港观测员资格考试')]);

        expect(index.indexedBoxCount).toBe(1);
        expect(lookup.matchedBoxCount).toBe(1);
        expect(lookup.candidates[0]).toMatchObject({
            boxId: 'box-exam',
            matchSource: 'box_name',
            node: { id: 'summary-exam' },
        });
    });

    it('matches a Router event update against an overlapping box name', () => {
        const summary = node('summary-exam', '考试一路的进展。', {
            eventBoxId: 'box-exam',
            isBoxSummary: true,
        });
        const index = buildEventBoxLightIndex([summary], [box()]);
        const lookup = lookupEventBoxLightCandidates(index, [eventQuery('雾港观测员成绩')]);

        expect(lookup.candidates[0]?.boxId).toBe('box-exam');
        expect(lookup.candidates[0]?.matchSource).toBe('box_name');
        expect(lookup.candidates[0]?.score).toBeGreaterThanOrEqual(0.58);
    });

    it('indexes entities stored on the summary node', () => {
        const summary = node('summary-exam', '项目进展已经压缩进摘要。', {
            eventBoxId: 'box-exam',
            isBoxSummary: true,
            entities: [{ name: '雾港工坊', type: 'organization' }],
        });
        const index = buildEventBoxLightIndex([summary], [box({ name: '第一次合作' })]);
        const lookup = lookupEventBoxLightCandidates(index, [eventQuery('雾港工坊')]);

        expect(lookup.candidates[0]?.matchSource).toBe('summary_entity');
    });

    it('uses the strongest live node when an uncompressed box has no summary', () => {
        const older = node('live-old', '雾岚提过搬家的安排。', {
            eventBoxId: 'box-move',
            entities: [{ name: '雾岚', type: 'person' }],
            importance: 4,
            createdAt: 100,
        });
        const stronger = node('live-strong', '后来重新确认了搬家日期。', {
            eventBoxId: 'box-move',
            tags: ['搬家计划'],
            importance: 9,
            createdAt: 200,
        });
        const moveBox = box({
            id: 'box-move',
            name: '搬家后续',
            tags: [],
            summaryNodeId: null,
            liveMemoryIds: ['live-old', 'live-strong'],
        });
        const index = buildEventBoxLightIndex([older, stronger], [moveBox]);
        const lookup = lookupEventBoxLightCandidates(index, [eventQuery('雾岚')]);

        expect(lookup.candidates[0]).toMatchObject({
            boxId: 'box-move',
            matchSource: 'live_entity',
            node: { id: 'live-strong' },
        });
    });

    it('ignores a query that contains only generic continuation words', () => {
        const summary = node('summary-exam', '考试后来有了结果。', {
            eventBoxId: 'box-exam',
            isBoxSummary: true,
        });
        const index = buildEventBoxLightIndex([summary], [box()]);

        expect(lookupEventBoxLightCandidates(index, [eventQuery('那个事情后来呢')]).candidates)
            .toEqual([]);
    });

    it('adds metadata candidates without deleting ordinary recall results or making them hard guarantees', () => {
        const ordinary: ScoredMemory[] = [
            {
                node: node('semantic-a', '旧 hybrid recall A'),
                finalScore: 0.82,
                similarity: 0.8,
                bm25Score: 0.2,
                roomScore: 0.82,
            },
            {
                node: node('semantic-b', '旧 hybrid recall B'),
                finalScore: 0.74,
                similarity: 0.7,
                bm25Score: 0.1,
                roomScore: 0.74,
            },
        ];
        const summary = node('summary-exam', '考试事件盒代表节点', {
            eventBoxId: 'box-exam',
            isBoxSummary: true,
        });

        const merged = mergeEventBoxLightCandidates(ordinary, [{
            boxId: 'box-exam',
            node: summary,
            score: 0.9,
            queryWeight: 0.9,
            matchSource: 'box_name',
        }], 0.8);

        expect(merged.map(result => result.node.id)).toEqual(expect.arrayContaining([
            'semantic-a',
            'semantic-b',
            'summary-exam',
        ]));
        expect(merged).toHaveLength(ordinary.length + 1);
        expect(merged.find(result => result.node.id === 'summary-exam')?.recallGuarantee).toBeUndefined();
    });
});
