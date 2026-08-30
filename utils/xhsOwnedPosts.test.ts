import { describe, expect, it } from 'vitest';
import { DB } from './db';
import type { XhsActivityRecord, XhsOwnedPost } from '../types';

describe('XHS character profile persistence', () => {
    it('keeps owned posts after the character activity history is cleared', async () => {
        const suffix = `${Date.now()}-${Math.random()}`;
        const characterId = `owned-post-char-${suffix}`;
        const noteId = `note-${suffix}`;
        const post: XhsOwnedPost = {
            id: `${characterId}:${noteId}`,
            characterId,
            noteId,
            title: '角色自己的帖子',
            body: '正文',
            publishedAt: 100,
            updatedAt: 100,
        };
        const activity: XhsActivityRecord = {
            id: `activity-${suffix}`,
            characterId,
            timestamp: 100,
            actionType: 'post',
            content: { noteId, title: post.title, body: post.body },
            thinking: '发帖',
            result: 'success',
        };

        await DB.saveXhsOwnedPost(post);
        await DB.saveXhsActivity(activity);
        await DB.clearXhsActivities(characterId);

        expect(await DB.getXhsActivities(characterId)).toEqual([]);
        expect(await DB.getXhsOwnedPosts(characterId)).toEqual([post]);
    });

    it('isolates pseudo profiles by character even when they share an account', async () => {
        const suffix = `${Date.now()}-${Math.random()}`;
        const first: XhsOwnedPost = {
            id: `char-a-${suffix}:note-a`, characterId: `char-a-${suffix}`, noteId: 'note-a',
            title: '同标题', body: 'A', publishedAt: 1, updatedAt: 1,
        };
        const second: XhsOwnedPost = {
            id: `char-b-${suffix}:note-b`, characterId: `char-b-${suffix}`, noteId: 'note-b',
            title: '同标题', body: 'B', publishedAt: 1, updatedAt: 1,
        };

        await DB.saveXhsOwnedPost(first);
        await DB.saveXhsOwnedPost(second);

        expect(await DB.getXhsOwnedPosts(first.characterId)).toEqual([first]);
        expect(await DB.getXhsOwnedPosts(second.characterId)).toEqual([second]);
        expect((await DB.exportFullData()).xhsOwnedPosts).toEqual(
            expect.arrayContaining([first, second]),
        );
    });
});
