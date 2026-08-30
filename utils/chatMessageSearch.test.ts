import { describe, expect, it } from 'vitest';
import {
    chatMessageFuzzyMatchesKeyword,
    chatMessageIncludesKeyword,
    searchableChatMessageText,
    stripEmojiDirectivesFromSearchText,
} from './chatMessageSearch';

describe('chat message keyword search', () => {
    it('matches ordinary copy case-insensitively and keeps fuzzy history matching', () => {
        const message = { type: 'text' as const, content: 'Plan the Summer Festival' };
        expect(chatMessageIncludesKeyword(message, 'SUMMER')).toBe(true);
        expect(chatMessageFuzzyMatchesKeyword(message, 'smr fst')).toBe(true);
    });

    it('does not treat emoji assets or emoji commands as keyword results', () => {
        expect(chatMessageIncludesKeyword({ type: 'emoji', content: 'https://cdn.test/summer-cat.gif' }, 'summer')).toBe(false);
        expect(chatMessageIncludesKeyword({ type: 'text', content: '[表情：summer-cat]' }, 'summer')).toBe(false);
        expect(chatMessageFuzzyMatchesKeyword({ type: 'text', content: '[[EMOJI:summer-cat]]' }, 'summer')).toBe(false);
        expect(stripEmojiDirectivesFromSearchText('先聊 summer [表情:summer-cat] 再说')).toContain('先聊 summer');
        expect(searchableChatMessageText({ type: 'text', content: '先聊 summer [表情:summer-cat] 再说' })).toContain('summer');
    });

    it('normalizes full-width English without changing Chinese keyword behavior', () => {
        expect(chatMessageIncludesKeyword({ type: 'text', content: 'Ｓｕｍｍｅｒ 计划' }, 'summer')).toBe(true);
        expect(chatMessageIncludesKeyword({ type: 'text', content: '周末去海边' }, '海边')).toBe(true);
    });
});
