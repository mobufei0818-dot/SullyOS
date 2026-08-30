import { describe, expect, it } from 'vitest';
import type { XhsOwnedPost } from '../types';
import { selectOwnedPostsForReference } from './xhsOwnedPostReference';

const post = (noteId: string, title: string, publishedAt: number, tags?: string[]): XhsOwnedPost => ({
    id: `char:${noteId}`,
    characterId: 'char',
    noteId,
    title,
    body: `${title}的正文`,
    tags,
    publishedAt,
    updatedAt: publishedAt,
});

describe('selectOwnedPostsForReference', () => {
    const posts = [
        post('newest', '晚安碎碎念', 300),
        post('middle', '今天喝到的手冲咖啡', 200, ['咖啡']),
        post('oldest', '海边散步', 100),
    ];

    it('resolves “刚才那个帖子” to the newest owned post', () => {
        expect(selectOwnedPostsForReference(posts, '欸你看看刚才那个帖子评论区', 1)[0].noteId).toBe('newest');
    });

    it('promotes an older post when the user mentions its topic', () => {
        expect(selectOwnedPostsForReference(posts, '看看之前那个咖啡帖子', 1)[0].noteId).toBe('middle');
    });

    it('limits prompt candidates without losing local storage', () => {
        expect(selectOwnedPostsForReference(posts, '看看主页', 2).map(item => item.noteId)).toEqual(['newest', 'middle']);
        expect(posts).toHaveLength(3);
    });
});
