import { describe, expect, it } from 'vitest';
import { createChatHistoryWindow, expandChatHistoryWindow } from './chatHistoryWindow';

describe('chat history browsing window', () => {
    it('centers the initial window on a search result', () => {
        expect(createChatHistoryWindow(200, 100, 25)).toEqual({ start: 75, end: 126 });
    });

    it('clamps the initial window at both ends of history', () => {
        expect(createChatHistoryWindow(40, 3, 25)).toEqual({ start: 0, end: 29 });
        expect(createChatHistoryWindow(40, 38, 25)).toEqual({ start: 13, end: 40 });
    });

    it('expands in either direction without crossing history bounds', () => {
        const initial = { start: 25, end: 76 };
        expect(expandChatHistoryWindow(initial, 100, 'older', 30)).toEqual({ start: 0, end: 76 });
        expect(expandChatHistoryWindow(initial, 100, 'newer', 30)).toEqual({ start: 25, end: 100 });
        expect(initial).toEqual({ start: 25, end: 76 });
    });
});
