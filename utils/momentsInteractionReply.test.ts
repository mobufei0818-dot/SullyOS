import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MomentsApiConfig, MomentsPost, MomentsProfile } from '../types';
import { planMomentsCharacterPost, planMomentsInteractions } from './momentsApi';

const config: MomentsApiConfig = {
  source: 'custom', enabled: true, baseUrl: 'https://example.com/v1', apiKey: 'test-key', model: 'test-model',
};

const post: MomentsPost = {
  id: 'post-1', authorType: 'character', authorId: 'moments:character:author', authorName: '作者', content: '今天的晚霞', mediaIds: [], createdAt: 1,
  visibility: { id: 'visibility-1', postId: 'post-1', mode: 'public', allowedActorIds: [], blockedActorIds: [], groupIds: [], version: 1, capturedAt: 1 },
};

const actor = (id: string, displayName: string): MomentsProfile => ({
  id, actorType: id.includes('passerby') ? 'npc' : 'character', displayName, updatedAt: 1,
});

afterEach(() => vi.unstubAllGlobals());

const mockCompletion = (content: object) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })));
};

describe('朋友圈评论区相互回复', () => {
  it('回复轮只保留评论，并保存回复评论者或点赞者的目标', async () => {
    const now = 1_000_000;
    mockCompletion({ interactions: [
      { actorId: 'moments:character:author', kind: 'comment', content: '你也看到了？', replyToCommentId: 'user-comment', dueAt: now + 10_000 },
      { actorId: 'moments:passerby:1', kind: 'comment', content: '@点赞的人 是真的很好看', replyToActorId: 'moments:character:liker', dueAt: now + 120_000 },
      { actorId: 'moments:character:liker', kind: 'reaction', dueAt: now + 180_000 },
    ] });

    const plan = await planMomentsInteractions({
      config, post, now, maxComments: 3, threadVersion: 2, replyRound: true,
      actors: [actor('moments:character:author', '作者'), actor('moments:passerby:1', '路人'), actor('moments:character:liker', '点赞者')],
      contextComments: [{ id: 'user-comment', actorId: 'moments:user', actorName: '我', content: '好漂亮' }],
      contextReactions: [{ actorId: 'moments:character:liker', actorName: '点赞者' }],
    });

    expect(plan.interactions).toHaveLength(2);
    expect(plan.interactions[0]).toMatchObject({ replyToCommentId: 'user-comment', replyToActorId: 'moments:user' });
    expect(plan.interactions[0].dueAt).toBe(now + 60_000);
    expect(plan.interactions[1]).toMatchObject({ replyToActorId: 'moments:character:liker' });
  });
});

describe('角色从自己的相册发朋友圈', () => {
  it('只接受候选中的稳定相册 id，并且不再同时创建生图占位', async () => {
    mockCompletion({ shouldPost: true, content: '翻到前几天拍的云。', galleryImageId: 'gallery-own-1', photoPrompt: '不应使用', dueAt: Date.now() + 120_000 });
    const plan = await planMomentsCharacterPost({
      config, actor: actor('moments:character:author', '作者'), mode: 'high', recentPosts: [], preferPhoto: true,
      galleryOptions: [{ id: 'gallery-own-1', savedDate: '2026-09-01', context: '傍晚拍到的云' }],
    });
    expect(plan.galleryImageId).toBe('gallery-own-1');
    expect(plan.photoPrompt).toBeUndefined();
  });
});
