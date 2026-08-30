import { describe, expect, it } from 'vitest';
import {
    enterQixiInterlayerState,
    qixiWordPickTarget,
    resolveQixiWordArtifacts,
    resolveQixiWordSelectionIds,
    selectQixiWordTurn,
} from './qixiSessionState';

describe('enterQixiInterlayerState', () => {
    it('keeps background-generated Part 2 and Part 3 results when room 01 starts', () => {
        const bridge = { id: 'part-2-result' };
        const reunion = { id: 'part-3-result' };
        const current = {
            stage: 'entry',
            sceneIndex: 0,
            bridge,
            reunion,
            bridgePlaced: [],
        };

        const next = enterQixiInterlayerState(current, 'explore');

        expect(next.stage).toBe('scene');
        expect(next.attitude).toBe('explore');
        expect(next.bridge).toBe(bridge);
        expect(next.reunion).toBe(reunion);
    });
});

describe('selectQixiWordTurn', () => {
    it('accepts exactly one User word before waiting for the Char response', () => {
        expect(selectQixiWordTurn([], 0, 'warm')).toEqual(['warm']);
        expect(selectQixiWordTurn(['warm'], 0, 'brave')).toEqual(['warm']);
        expect(selectQixiWordTurn(['warm'], 1, 'brave')).toEqual(['warm', 'brave']);
    });

    it('stops after three alternating picks and cannot pick the same word twice', () => {
        expect(selectQixiWordTurn(['warm'], 1, 'warm')).toEqual(['warm']);
        expect(selectQixiWordTurn(['warm', 'brave', 'quiet'], 3, 'patient')).toEqual(['warm', 'brave', 'quiet']);
    });

    it('repairs an old save whose Char reveal counter is ahead of the User choices', () => {
        expect(selectQixiWordTurn([], 3, 'warm')).toEqual(['warm']);
        expect(selectQixiWordTurn(['warm'], 3, 'brave')).toEqual(['warm', 'brave']);
    });
});

describe('resolveQixiWordArtifacts', () => {
    const artifacts = [
        { id: 'a1', label: '温柔', kind: 'trait', evidenceIds: [] },
        { id: 'a2', label: '嘴硬', kind: 'trait', evidenceIds: [] },
        { id: 'a3', label: '旧怀表', kind: 'object', evidenceIds: [] },
    ];

    it('accepts ids, labels and inline model-generated words instead of rendering an empty list', () => {
        const words = resolveQixiWordArtifacts(['a1', '嘴硬', '很有耐心'], ['温柔'], artifacts);
        expect(words.map(item => item.label)).toEqual(['温柔', '嘴硬', '很有耐心', '旧怀表']);
        expect(resolveQixiWordSelectionIds(['温柔'], words)).toEqual(['a1']);
    });

    it('fills from generated trait artifacts and lowers the target when fewer than three exist', () => {
        const words = resolveQixiWordArtifacts(['missing-a99'], [], artifacts.slice(0, 2));
        expect(words.map(item => item.label)).toEqual(['温柔', '嘴硬']);
        expect(qixiWordPickTarget(words.length)).toBe(2);
        expect(qixiWordPickTarget(0)).toBe(0);
    });
});
