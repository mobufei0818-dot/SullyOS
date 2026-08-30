import { describe, expect, it } from 'vitest';
import type { XhsActivityRecord } from '../types';
import {
    collectOwnedPostsFromActivities,
    collectPersistedOwnedNotes,
    extractPublishedNoteId,
    mergeOwnedNotes,
} from './xhsFreeRoamOwnership';

const postActivity = (
    noteId: string | undefined,
    timestamp: number,
    result: XhsActivityRecord['result'] = 'success',
): XhsActivityRecord => ({
    id: `activity-${timestamp}`,
    characterId: 'char-1',
    timestamp,
    actionType: 'post',
    content: { noteId, title: `post-${timestamp}`, body: 'body' },
    thinking: 'thinking',
    result,
});

describe('XHS free-roam owned note identity', () => {
    it('extracts the unique note id returned by Lite and wrapped MCP responses', () => {
        expect(extractPublishedNoteId({ data: { note_id: 'lite-note' } })).toBe('lite-note');
        expect(extractPublishedNoteId({ data: { data: { id: 'mcp-note' } } })).toBe('mcp-note');
        expect(extractPublishedNoteId({ data: { raw: { data: { id: 'raw-note' } } } })).toBe('raw-note');
        expect(extractPublishedNoteId({ data: { raw: { request_id: 'not-a-note' } } })).toBe('');
    });

    it('only trusts successful posts that persisted a note id', () => {
        const notes = collectPersistedOwnedNotes([
            postActivity('new-note', 3),
            postActivity(undefined, 2),
            postActivity('failed-note', 1, 'failed'),
            postActivity('new-note', 0),
        ], '角色名');

        expect(notes).toEqual([
            expect.objectContaining({ noteId: 'new-note', title: 'post-3', author: '角色名' }),
        ]);
    });

    it('migrates an activity with note_id into a durable character profile record', () => {
        expect(collectOwnedPostsFromActivities([postActivity('note-1', 123)])).toEqual([
            expect.objectContaining({
                id: 'char-1:note-1',
                characterId: 'char-1',
                noteId: 'note-1',
                publishedAt: 123,
            }),
        ]);
    });

    it('merges profile metadata by note id instead of title', () => {
        const merged = mergeOwnedNotes(
            [{ noteId: 'note-1', title: '重复标题', likes: 0 }],
            [
                { noteId: 'note-1', title: '重复标题', likes: 12, xsecToken: 'token-1' },
                { noteId: 'note-2', title: '重复标题', likes: 5 },
            ],
        );

        expect(merged).toHaveLength(2);
        expect(merged[0]).toMatchObject({ noteId: 'note-1', likes: 12, xsecToken: 'token-1' });
        expect(merged[1]).toMatchObject({ noteId: 'note-2', likes: 5 });
    });

    it('can enrich only known character posts on a shared real account', () => {
        const merged = mergeOwnedNotes(
            [{ noteId: 'char-owned', title: 'same title', likes: 0 }],
            [
                { noteId: 'char-owned', title: 'same title', likes: 3 },
                { noteId: 'other-char-owned', title: 'same title', likes: 9 },
            ],
            false,
        );

        expect(merged).toEqual([
            expect.objectContaining({ noteId: 'char-owned', likes: 3 }),
        ]);
    });
});
