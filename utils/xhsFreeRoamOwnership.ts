import type { XhsActivityRecord, XhsOwnedPost } from '../types';

export interface PersistedOwnedXhsNote {
    noteId: string;
    title: string;
    desc: string;
    author: string;
    authorId: string;
    likes: number;
    collects: number;
    commentCount: number;
    shareCount: number;
    xsecToken?: string;
}

const firstNonEmptyString = (...values: unknown[]): string => {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
};

/**
 * 发帖工具在 Lite、MCP 和不同上游版本中会有一到两层包装。
 * 只检查明确的发布结果路径，避免把 raw 响应里的其他 id 误认成 note_id。
 */
export const extractPublishedNoteId = (result: any): string => {
    const data = result?.data;
    return firstNonEmptyString(
        data?.note_id,
        data?.noteId,
        data?.data?.note_id,
        data?.data?.noteId,
        data?.data?.id,
        data?.note?.note_id,
        data?.note?.noteId,
        data?.note?.id,
        data?.raw?.data?.note_id,
        data?.raw?.data?.noteId,
        data?.raw?.data?.id,
    );
};

/** 从本地活动历史恢复已经确认属于当前角色的笔记。 */
export const collectPersistedOwnedNotes = (
    activities: XhsActivityRecord[],
    author: string,
): PersistedOwnedXhsNote[] => {
    const seen = new Set<string>();
    const notes: PersistedOwnedXhsNote[] = [];

    for (const activity of activities) {
        if (activity.actionType !== 'post' || activity.result !== 'success') continue;
        const noteId = firstNonEmptyString(activity.content.noteId);
        if (!noteId || seen.has(noteId)) continue;
        seen.add(noteId);
        notes.push({
            noteId,
            title: activity.content.title || '无标题',
            desc: activity.content.body || '',
            author,
            authorId: '',
            likes: 0,
            collects: 0,
            commentCount: 0,
            shareCount: 0,
        });
    }

    return notes;
};

/** 将旧版活动记录中已经保存过 note_id 的帖子迁移到独立角色主页。 */
export const collectOwnedPostsFromActivities = (
    activities: XhsActivityRecord[],
): XhsOwnedPost[] => {
    const seen = new Set<string>();
    const posts: XhsOwnedPost[] = [];
    for (const activity of activities) {
        if (activity.actionType !== 'post' || activity.result !== 'success') continue;
        const noteId = firstNonEmptyString(activity.content.noteId);
        if (!noteId || seen.has(noteId)) continue;
        seen.add(noteId);
        posts.push({
            id: `${activity.characterId}:${noteId}`,
            characterId: activity.characterId,
            noteId,
            title: activity.content.title || '无标题',
            body: activity.content.body || '',
            tags: activity.content.tags,
            publishedAt: activity.timestamp,
            updatedAt: activity.timestamp,
        });
    }
    return posts;
};

export const ownedPostToNote = (post: XhsOwnedPost, author: string): PersistedOwnedXhsNote => ({
    noteId: post.noteId,
    title: post.title,
    desc: post.body,
    author,
    authorId: '',
    likes: post.likes || 0,
    collects: post.collects || 0,
    commentCount: post.commentCount || 0,
    shareCount: post.shareCount || 0,
    xsecToken: post.xsecToken,
});

/**
 * 主页接口的数据优先（它包含最新互动数和 xsec_token），本地记录负责兜底唯一 ID。
 */
export const mergeOwnedNotes = (
    localNotes: any[],
    profileNotes: any[],
    includeUnknownProfileNotes = true,
): any[] => {
    const merged = new Map<string, any>();
    for (const note of localNotes) {
        const noteId = firstNonEmptyString(note?.noteId, note?.note_id, note?.id);
        if (noteId) merged.set(noteId, { ...note, noteId });
    }
    for (const note of profileNotes) {
        const noteId = firstNonEmptyString(note?.noteId, note?.note_id, note?.id);
        if (!noteId) continue;
        if (!includeUnknownProfileNotes && !merged.has(noteId)) continue;
        merged.set(noteId, { ...(merged.get(noteId) || {}), ...note, noteId });
    }
    return [...merged.values()];
};
