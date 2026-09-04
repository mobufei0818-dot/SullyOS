// SAME_SPACE_CHAT: removable feature contract tests.
import { describe, expect, it } from 'vitest';
import {
    advanceSameSpaceTime,
    buildSameSpaceChatPrompt,
    createSameSpaceChatState,
    getSameSpaceSceneTime,
    pauseSameSpaceTime,
    splitSameSpaceAssistantOutput,
} from '../features/sameSpaceChat/model';

describe('same-space chat', () => {
    it('follows, pauses, and advances scene time without jumping on its own', () => {
        const start = 1_000_000;
        const running = createSameSpaceChatState(start);
        expect(getSameSpaceSceneTime(running, start + 60_000)).toBe(start + 60_000);
        const paused = pauseSameSpaceTime(running, start + 60_000);
        expect(getSameSpaceSceneTime(paused, start + 600_000)).toBe(start + 60_000);
        expect(getSameSpaceSceneTime(advanceSameSpaceTime(paused, 5, start + 600_000), start + 900_000)).toBe(start + 360_000);
    });

    it('separates dedicated action markers but leaves ordinary parentheses alone', () => {
        expect(splitSameSpaceAssistantOutput('[[SAME_SPACE_ACTION]]抬眼看她[[/SAME_SPACE_ACTION]]\n怎么了？')).toEqual([
            { kind: 'action', content: '抬眼看她' },
            { kind: 'text', content: '怎么了？' },
        ]);
        expect(splitSameSpaceAssistantOutput('（这只是普通括号）')).toEqual([{ kind: 'text', content: '（这只是普通括号）' }]);
    });

    it('names both participants and locks model actions to the character', () => {
        const prompt = buildSameSpaceChatPrompt(createSameSpaceChatState(0), '谢侑', '林焕培', 0);
        expect(prompt).toContain('谢侑与林焕培');
        expect(prompt).toContain('绝不能替林焕培决定动作');
        expect(prompt).toContain('[[SAME_SPACE_ACTION]]');
    });
});
