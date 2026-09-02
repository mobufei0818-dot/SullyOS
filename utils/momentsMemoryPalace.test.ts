import { describe, expect, it } from 'vitest';
import type { MomentsEventLedgerEntry, MomentsPost } from '../types';
import { describeMomentsMemoryEvent } from './momentsMemoryPalace';

const post: MomentsPost = {
  id: 'post-1', authorType: 'character', authorId: 'moments:character:xie', authorName: '谢侑',
  content: '今天手机只剩 3% 的电。', mediaIds: ['media-1'], createdAt: 1,
  visibility: { mode: 'public', allowedActorIds: [], blockedActorIds: [], groupIds: [], version: 1, capturedAt: 1 },
};

const entry = (type: MomentsEventLedgerEntry['type'], actorId: string, sourceId = type): MomentsEventLedgerEntry => ({
  id: `event-${sourceId}`, postId: post.id, actorId, type, sourceId, visibleToActorIds: [], createdAt: 2,
});

describe('朋友圈记忆宫殿叙事规则', () => {
  it('角色自己的发帖只用第一人称', () => {
    expect(describeMomentsMemoryEvent({
      post, entry: entry('post', post.authorId), selfActorId: post.authorId,
    })).toBe('我发布了一条朋友圈：“今天手机只剩 3% 的电。”');
  });

  it('不把作者自己的已阅再写一遍', () => {
    expect(describeMomentsMemoryEvent({
      post, entry: entry('seen', post.authorId), selfActorId: post.authorId,
    })).toBeNull();
  });

  it('看别人的动态时明确写对方名字', () => {
    expect(describeMomentsMemoryEvent({
      post, entry: entry('seen', 'moments:character:sully'), selfActorId: 'moments:character:sully',
    })).toBe('我刷到 谢侑 发的朋友圈：“今天手机只剩 3% 的电。”');
  });

  it('评论和回复必须带正文，并写明被回复者', () => {
    expect(describeMomentsMemoryEvent({
      post, entry: entry('comment', 'moments:character:sully'), selfActorId: 'moments:character:sully',
      detail: { actorName: 'Sully', content: '快去充电。' },
    })).toBe('我在 谢侑 的朋友圈下评论：“快去充电。”');
    expect(describeMomentsMemoryEvent({
      post, entry: entry('reply', 'moments:character:sully'), selfActorId: 'moments:character:sully',
      detail: { actorName: 'Sully', replyToActorName: '林焕培', content: '我已经充上了。' },
    })).toBe('我在 谢侑 的朋友圈下回复 林焕培：“我已经充上了。”');
    expect(describeMomentsMemoryEvent({
      post, entry: entry('comment', 'moments:character:sully'), selfActorId: 'moments:character:sully',
      detail: { actorName: 'Sully' },
    })).toBeNull();
  });

  it('不为图片和点赞创建只有动作的长期记忆', () => {
    expect(describeMomentsMemoryEvent({ post, entry: entry('media', post.authorId), selfActorId: post.authorId })).toBeNull();
    expect(describeMomentsMemoryEvent({ post, entry: entry('reaction', post.authorId), selfActorId: post.authorId })).toBeNull();
  });

  it('用户转发时写用户真实名字，不写泛称用户', () => {
    expect(describeMomentsMemoryEvent({
      post, entry: entry('share', 'moments:user'), selfActorId: 'moments:character:sully',
      detail: { actorName: '林焕培' },
    })).toBe('林焕培把 谢侑 的朋友圈转发给我：“今天手机只剩 3% 的电。”');
  });
});
