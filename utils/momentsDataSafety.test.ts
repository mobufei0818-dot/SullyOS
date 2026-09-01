import { beforeEach, describe, expect, it } from 'vitest';
import { DB, openDB } from './db';

const MOMENTS_STORES = [
  'moments_profiles', 'moments_posts', 'moments_media_refs', 'moments_visibility_snapshots',
  'moments_reactions', 'moments_comments', 'moments_seen_receipts', 'moments_shares',
  'moments_event_ledger', 'moments_settings', 'moments_pending_jobs', 'moments_sync_outbox', 'moments_memory_index',
];

async function clearStores() {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([...MOMENTS_STORES, 'gallery', 'messages', 'social_posts'], 'readwrite');
    for (const storeName of [...MOMENTS_STORES, 'gallery', 'messages', 'social_posts']) tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

beforeEach(clearStores);

describe('朋友圈数据安全', () => {
  it('旧备份里缺 snapshot id 时会补键并成功恢复', async () => {
    await DB.importFullData({
      timestamp: Date.now(), version: 3,
      momentsData: {
        schemaVersion: 1,
        profiles: [],
        posts: [{ id: 'post-old', authorType: 'user', authorId: 'moments:user', authorName: '我', content: '旧动态', mediaIds: [], createdAt: 1,
          visibility: { mode: 'public', allowedActorIds: [], blockedActorIds: [], groupIds: [], version: 1, capturedAt: 1 } }],
        mediaRefs: [],
        visibilitySnapshots: [{ mode: 'public', allowedActorIds: [], blockedActorIds: [], groupIds: [], version: 1, capturedAt: 1 }],
        reactions: [], comments: [], seenReceipts: [], shares: [], tempStrangers: [], tempTranscripts: [], eventLedger: [], settings: [], pendingJobs: [], syncOutbox: [], memoryIndex: [],
      },
    } as any);
    const snapshots = await DB.getRawStoreData('moments_visibility_snapshots');
    const posts = await DB.getRawStoreData('moments_posts');
    expect(snapshots[0].id).toBeTruthy();
    expect(posts[0].visibility.id).toBe('moments-visibility-post-old');
    expect(posts[0].visibility.postId).toBe('post-old');
  });

  it('删帖会清空本帖派生数据、保留其他帖对同一图库图的引用', async () => {
    const snapshot = { id: 'visibility-post-a', postId: 'post-a', mode: 'public' as const, allowedActorIds: [], blockedActorIds: [], groupIds: [], version: 1, capturedAt: 1 };
    await DB.saveMomentsPost({ id: 'post-a', authorType: 'user', authorId: 'moments:user', authorName: '我', content: 'a', mediaIds: ['media-a'], createdAt: 1, visibility: snapshot });
    await DB.saveMomentsPost({ id: 'post-b', authorType: 'user', authorId: 'moments:user', authorName: '我', content: 'b', mediaIds: ['media-b'], createdAt: 2, visibility: { ...snapshot, id: 'visibility-post-b', postId: 'post-b' } });
    await DB.saveMomentsVisibilitySnapshot(snapshot);
    await DB.saveMomentsMediaRefs([
      { id: 'media-a', postId: 'post-a', url: 'image://shared', galleryImageId: 'gallery-shared', createdAt: 1 },
      { id: 'media-b', postId: 'post-b', url: 'image://shared', galleryImageId: 'gallery-shared', createdAt: 2 },
    ]);
    await DB.saveMomentsReaction({ id: 'reaction-a', postId: 'post-a', actorId: 'moments:user', actorType: 'user', actorName: '我', createdAt: 1 });
    await DB.saveMomentsComment({ id: 'comment-a', postId: 'post-a', actorId: 'moments:user', actorType: 'user', actorName: '我', content: '评论', createdAt: 1 });
    await DB.saveMomentsEventLedger({ id: 'ledger-a', postId: 'post-a', actorId: 'moments:user', type: 'post', sourceId: 'post-a', visibleToActorIds: [], createdAt: 1 });
    await DB.saveMomentsMemoryIndex({ id: 'memory-a', actorId: 'moments:user', sourceId: 'post-a', postId: 'post-a', createdAt: 1 });
    await DB.saveMomentsPendingJob({ id: 'job-a', type: 'interaction', postId: 'post-a', dueAt: 2, state: 'pending', createdAt: 1 });
    await DB.saveMomentsSyncOutboxItem({ id: 'outbox-a', type: 'post', payload: { postId: 'post-a' }, createdAt: 1, retryCount: 0 });

    const usage = await DB.getGalleryImageUsage('gallery-shared', 'post-a');
    expect(usage.momentsPostIds).toEqual(['post-b']);
    await DB.deleteMomentsPostCascade('post-a');

    expect(await DB.getMomentsPosts()).toEqual([expect.objectContaining({ id: 'post-b' })]);
    expect(await DB.getMomentsMediaByPostId('post-a')).toEqual([]);
    expect(await DB.getMomentsMediaByPostId('post-b')).toEqual([expect.objectContaining({ galleryImageId: 'gallery-shared' })]);
    expect((await DB.getRawStoreData('moments_reactions')).filter((item: any) => item.postId === 'post-a')).toEqual([]);
    expect((await DB.getRawStoreData('moments_comments')).filter((item: any) => item.postId === 'post-a')).toEqual([]);
    expect((await DB.getRawStoreData('moments_pending_jobs')).filter((item: any) => item.postId === 'post-a')).toEqual([]);
    expect((await DB.getMomentsSyncOutbox()).filter(item => item.payload.postId === 'post-a')).toEqual([]);
  });
});
