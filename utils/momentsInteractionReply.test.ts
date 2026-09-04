import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MomentsApiConfig, MomentsPost, MomentsProfile } from '../types';
import { planMomentsCharacterPost, planMomentsInteractions, replyMomentsStranger } from './momentsApi';

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
  it('用户帖子中模型漏掉正式角色/NPC时，已入选者会各补一次点赞', async () => {
    mockCompletion({ interactions: [] });
    const userPost: MomentsPost = { ...post, authorType: 'user', authorId: 'moments:user', authorName: '林焕培' };
    const plan = await planMomentsInteractions({
      config, post: userPost, now: 1_000_000,
      actors: [
        actor('moments:character:a', '甲'),
        { ...actor('moments:npc:b', '乙'), actorType: 'npc' },
        actor('moments:passerby:1', '路人'),
      ],
    });

    expect(plan.interactions.map(item => [item.actorId, item.kind])).toEqual([
      ['moments:character:a', 'reaction'],
      ['moments:npc:b', 'reaction'],
    ]);
  });

  it('角色自己发帖时仍允许模型自然决定无人互动', async () => {
    mockCompletion({ interactions: [] });
    const plan = await planMomentsInteractions({
      config, post, now: 1_000_000,
      actors: [actor('moments:character:a', '甲')],
    });
    expect(plan.interactions).toEqual([]);
  });

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

  it('模型未明确回复目标时保留为普通评论，不会把所有人强挂到最新用户评论', async () => {
    const now = 1_000_000;
    mockCompletion({ interactions: [
      { actorId: 'moments:character:a', kind: 'comment', content: '先把充电宝借你。', dueAt: now + 90_000 },
      { actorId: 'moments:character:b', kind: 'comment', content: '电量确实有点危险。', dueAt: now + 120_000 },
    ] });
    const plan = await planMomentsInteractions({
      config, post, now, maxComments: 3, threadVersion: 3, replyRound: true,
      actors: [actor('moments:character:a', '甲'), actor('moments:character:b', '乙')],
      contextComments: [{ id: 'user-comment', actorId: 'moments:user', actorName: '林焕培', content: '亲亲' }],
    });
    expect(plan.interactions).toHaveLength(2);
    expect(plan.interactions.every(item => item.replyToActorId === undefined && item.replyToCommentId === undefined)).toBe(true);
  });

  it('统一规划请求会携带角色私聊、关系状态和共同群聊，而不是逐角色调用', async () => {
    let requestBody = '';
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = String(init?.body || '');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"interactions":[]}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    await planMomentsInteractions({
      config, post, actors: [actor('moments:character:a', '甲'), actor('moments:character:b', '乙')],
      actorContexts: [{ actorId: 'moments:character:a', persona: '冷静但护短', userRelationship: '好感 76', privateChat: '用户：今晚等你', sharedGroupChat: '[群：朋友们] 乙：别迟到' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody).toContain('今晚等你');
    expect(requestBody).toContain('朋友们');
    expect(requestBody).toContain('好感 76');
  });
});

describe('摇一摇临时聊天', () => {
  it('会把真实时间、消息时间线和连续用户消息一起交给一次前端请求', async () => {
    let requestBody = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = String(init?.body || '');
      return new Response(JSON.stringify({ choices: [{ message: { content: '我看到了，第二句更像你真正想说的。' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const reply = await replyMomentsStranger({
      config, profile: { ...actor('moments:stranger:1', '路言'), bio: '做展陈设计，慢热。' }, now: new Date('2026-09-01T21:30:00+08:00').getTime(),
      transcript: [
        { sender: 'user', content: '第一句', createdAt: new Date('2026-09-01T21:20:00+08:00').getTime() },
        { sender: 'user', content: '还有第二句', createdAt: new Date('2026-09-01T21:25:00+08:00').getTime() },
      ],
    });
    expect(reply).toContain('第二句');
    expect(requestBody).toContain('第一句');
    expect(requestBody).toContain('还有第二句');
    expect(requestBody).toContain('2026年9月1日');
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
