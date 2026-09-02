/**
 * 朋友圈 → 记忆宫殿的事实桥。
 *
 * 原始事件账本保留所有帖子、图片、点赞和已阅事实；记忆宫殿只保留有内容、有关系意义的角色视角记忆。
 * 每个节点严格站在所属角色的第一人称：只有该角色可以称“我”，用户和其他人一律写实际名字。
 */
import type { MomentsEventLedgerEntry, MomentsPost } from '../types';
import { EventBoxDB, MemoryNodeDB } from './memoryPalace/db';
import type { EventBox, MemoryNode } from './memoryPalace/types';

const boxIdFor = (charId: string, postId: string) => `moments-eb:${charId}:${postId}`;
const nodeIdFor = (charId: string, sourceId: string) => `moments-memory-node:${charId}:${sourceId}`;
const CORE_TYPES = new Set<MomentsEventLedgerEntry['type']>(['post', 'seen', 'share']);
const corePriority = (type?: string) => type === 'share' ? 3 : type === 'post' ? 2 : type === 'seen' ? 1 : 0;
const clean = (value?: string) => (value || '').replace(/\s+/g, ' ').trim();
const quote = (value: string) => `“${value.slice(0, 500)}”`;

export interface MomentsMemoryEventDetail {
  actorName?: string;
  content?: string;
  replyToActorName?: string;
  mediaDescription?: string;
}

/** 纯文本规则单独导出，便于用测试锁住人称和去重语义。 */
export function describeMomentsMemoryEvent(args: {
  post?: MomentsPost;
  entry: MomentsEventLedgerEntry;
  selfActorId: string;
  detail?: MomentsMemoryEventDetail;
}): string | null {
  const { post, entry, selfActorId, detail } = args;
  const owner = clean(post?.authorName);
  const actor = clean(detail?.actorName);
  const text = clean(post?.content);
  const mediaDescription = clean(detail?.mediaDescription);
  const body = text || mediaDescription;
  const selfIsAuthor = Boolean(post && post.authorId === selfActorId);
  const actorIsSelf = entry.actorId === selfActorId;

  // 图片、点赞仍在原始账本里，但不单独占用一条长期记忆。
  if (entry.type === 'media' || entry.type === 'reaction' || entry.type === 'delete') return null;

  if (entry.type === 'post') {
    if (!body) return null;
    if (actorIsSelf) {
      return text
        ? `我发布了一条朋友圈：${quote(text)}`
        : `我发布了一条带照片的朋友圈，照片内容是：${quote(mediaDescription)}`;
    }
    if (!actor) return null;
    return text
      ? `${actor}发布了一条朋友圈：${quote(text)}`
      : `${actor}发布了一条带照片的朋友圈，照片内容是：${quote(mediaDescription)}`;
  }

  if (entry.type === 'seen') {
    // 作者不会再“刷到自己的动态”；这是重复记忆的直接来源。
    if (selfIsAuthor || !owner || !body) return null;
    return text
      ? `我刷到 ${owner} 发的朋友圈：${quote(text)}`
      : `我刷到 ${owner} 发的朋友圈，照片内容是：${quote(mediaDescription)}`;
  }

  if (entry.type === 'comment' || entry.type === 'reply') {
    const content = clean(detail?.content);
    if (!owner || !content) return null;
    const subject = actorIsSelf ? '我' : actor;
    if (!subject) return null;
    const replyTarget = clean(detail?.replyToActorName);
    if (entry.type === 'reply' || replyTarget) {
      return replyTarget
        ? `${subject}在 ${owner} 的朋友圈下回复 ${replyTarget}：${quote(content)}`
        : `${subject}在 ${owner} 的朋友圈评论区回复：${quote(content)}`;
    }
    return `${subject}在 ${owner} 的朋友圈下评论：${quote(content)}`;
  }

  if (entry.type === 'share') {
    if (!actor || !owner || !body) return null;
    return text
      ? `${actor}把 ${owner} 的朋友圈转发给我：${quote(text)}`
      : `${actor}把 ${owner} 的照片动态转发给我，照片内容是：${quote(mediaDescription)}`;
  }

  return null;
}

/** 让一条已发生/已投递的朋友圈事实进入指定正式角色的记忆宫殿。幂等。 */
export async function mirrorMomentsEventToMemoryPalace(args: {
  charId: string;
  entry: MomentsEventLedgerEntry;
  post?: MomentsPost;
  selfActorId: string;
  detail?: MomentsMemoryEventDetail;
}): Promise<string> {
  const { charId, entry, post, selfActorId, detail } = args;
  if (!entry.postId || entry.type === 'delete') return '';
  const content = describeMomentsMemoryEvent({ post, entry, selfActorId, detail });
  if (!content) return '';

  const eventBoxId = boxIdFor(charId, entry.postId);
  let box = await EventBoxDB.getById(eventBoxId);
  const boxNodes = box ? await MemoryNodeDB.getByEventBoxId(eventBoxId) : [];
  const existingCore = CORE_TYPES.has(entry.type)
    ? [...boxNodes]
      .filter(node => CORE_TYPES.has(node.tags[1] as MomentsEventLedgerEntry['type']))
      .sort((a, b) => corePriority(b.tags[1]) - corePriority(a.tags[1]) || a.createdAt - b.createdAt)[0]
    : undefined;
  const memoryId = existingCore?.id || nodeIdFor(charId, CORE_TYPES.has(entry.type) ? `core:${entry.postId}` : entry.sourceId);
  const existing = existingCore || await MemoryNodeDB.getById(memoryId);
  const incomingWinsCore = !existingCore || corePriority(entry.type) > corePriority(existingCore.tags[1]);
  const createdAt = existing?.createdAt || entry.createdAt || Date.now();

  if (!existing || !CORE_TYPES.has(entry.type) || incomingWinsCore) {
    const node: MemoryNode = {
      ...(existing || {} as MemoryNode),
      id: memoryId,
      charId,
      content,
      room: entry.type === 'share' ? 'user_room' : 'living_room',
      tags: ['moments', entry.type, post?.authorName || '朋友圈'],
      importance: entry.type === 'share' || entry.type === 'comment' || entry.type === 'reply' ? 6 : 4,
      mood: existing?.mood || 'neutral',
      embedded: false,
      createdAt,
      lastAccessedAt: existing?.lastAccessedAt || createdAt,
      accessCount: existing?.accessCount || 0,
      sourceId: `moments:${entry.postId}:${entry.sourceId}`,
      origin: existing?.origin || 'system',
      eventBoxId,
      archived: existing?.archived || false,
    };
    await MemoryNodeDB.save(node);
  }

  const ownerLabel = post?.authorId === selfActorId ? '我的朋友圈互动' : `${post?.authorName || '朋友圈'}的朋友圈互动`;
  if (!box) {
    box = {
      id: eventBoxId,
      charId,
      name: ownerLabel,
      tags: ['moments', post?.authorId === selfActorId ? '我' : post?.authorName || '朋友圈'],
      summaryNodeId: null,
      liveMemoryIds: [memoryId],
      archivedMemoryIds: [],
      compressionCount: 0,
      createdAt,
      updatedAt: createdAt,
      lastCompressedAt: null,
    } satisfies EventBox;
  } else {
    box.name = ownerLabel;
    box.tags = ['moments', post?.authorId === selfActorId ? '我' : post?.authorName || '朋友圈'];
    if (!box.liveMemoryIds.includes(memoryId) && !box.archivedMemoryIds.includes(memoryId) && box.summaryNodeId !== memoryId) {
      box.liveMemoryIds = [...box.liveMemoryIds, memoryId];
    }
    box.updatedAt = Date.now();
  }
  await EventBoxDB.save(box);
  return memoryId;
}

/** 按现行账本重写旧版人称与正文，并移除空动作和重复核心节点。 */
export async function repairMomentsMemoryPalaceForCharacter(args: {
  charId: string;
  selfActorId: string;
  entries: MomentsEventLedgerEntry[];
  posts: MomentsPost[];
  detailsBySourceId?: Record<string, MomentsMemoryEventDetail>;
}): Promise<{ updated: number; removed: number }> {
  const { charId, selfActorId, entries, posts, detailsBySourceId = {} } = args;
  let updated = 0;
  let removed = 0;
  const postMap = new Map(posts.map(post => [post.id, post]));
  const relevantByPost = new Map<string, MomentsEventLedgerEntry[]>();
  for (const entry of entries) {
    if (!entry.postId || entry.type === 'delete' || entry.status === 'deleted' || !postMap.has(entry.postId)) continue;
    const belongsToCharacter = entry.actorId === selfActorId
      || (entry.type === 'share' && entry.visibleToActorIds.includes(selfActorId));
    if (!belongsToCharacter) continue;
    relevantByPost.set(entry.postId, [...(relevantByPost.get(entry.postId) || []), entry]);
  }

  for (const [postId, postEntries] of relevantByPost) {
    const post = postMap.get(postId);
    if (!post) continue;
    const keepIds = new Set<string>();
    for (const entry of [...postEntries].sort((a, b) => (a.sequence || a.createdAt) - (b.sequence || b.createdAt))) {
      const memoryId = await mirrorMomentsEventToMemoryPalace({
        charId, selfActorId, entry, post, detail: detailsBySourceId[entry.sourceId],
      });
      if (memoryId) keepIds.add(memoryId);
    }

    const eventBoxId = boxIdFor(charId, postId);
    const box = await EventBoxDB.getById(eventBoxId);
    if (!box) continue;
    const nodes = await MemoryNodeDB.getByEventBoxId(eventBoxId);
    const removedIds: string[] = [];
    for (const node of nodes) {
      if (node.id === box.summaryNodeId || !node.sourceId?.startsWith(`moments:${postId}:`)) continue;
      if (!keepIds.has(node.id)) {
        removedIds.push(node.id);
        await MemoryNodeDB.delete(node.id);
        removed += 1;
      } else {
        updated += 1;
      }
    }
    if (removedIds.length) {
      box.liveMemoryIds = box.liveMemoryIds.filter(id => !removedIds.includes(id));
      box.archivedMemoryIds = box.archivedMemoryIds.filter(id => !removedIds.includes(id));
      if (!box.liveMemoryIds.length && !box.archivedMemoryIds.length && !box.summaryNodeId) await EventBoxDB.delete(eventBoxId);
      else await EventBoxDB.save({ ...box, updatedAt: Date.now() });
    }
  }
  return { updated, removed };
}

/** 删帖时只删由朋友圈桥创建的节点及其空 EventBox，不触碰正常聊天记忆。 */
export async function removeMomentsPostFromMemoryPalace(postId: string, memoryNodeIds: string[]): Promise<void> {
  const byBox = new Map<string, string[]>();
  for (const memoryId of memoryNodeIds) {
    const node = await MemoryNodeDB.getById(memoryId);
    if (!node || !node.sourceId?.startsWith(`moments:${postId}:`)) continue;
    if (node.eventBoxId) byBox.set(node.eventBoxId, [...(byBox.get(node.eventBoxId) || []), memoryId]);
    await MemoryNodeDB.delete(memoryId);
  }
  for (const [eventBoxId, removedIds] of byBox) {
    const box = await EventBoxDB.getById(eventBoxId);
    if (!box) continue;
    box.liveMemoryIds = box.liveMemoryIds.filter(id => !removedIds.includes(id));
    box.archivedMemoryIds = box.archivedMemoryIds.filter(id => !removedIds.includes(id));
    if (box.summaryNodeId && removedIds.includes(box.summaryNodeId)) box.summaryNodeId = null;
    if (!box.liveMemoryIds.length && !box.archivedMemoryIds.length && !box.summaryNodeId) await EventBoxDB.delete(eventBoxId);
    else await EventBoxDB.save({ ...box, updatedAt: Date.now() });
  }
}

/** 删除评论/回复时，仅撤销对应事实节点；同帖其它互动记忆继续保留。 */
export async function removeMomentsSourcesFromMemoryPalace(postId: string, sourceIds: string[], memoryNodeIds: string[]): Promise<void> {
  const sourcePrefixes = sourceIds.map(sourceId => `moments:${postId}:${sourceId}`);
  const byBox = new Map<string, string[]>();
  for (const memoryId of memoryNodeIds) {
    const node = await MemoryNodeDB.getById(memoryId);
    if (!node || !sourcePrefixes.includes(node.sourceId || '')) continue;
    if (node.eventBoxId) byBox.set(node.eventBoxId, [...(byBox.get(node.eventBoxId) || []), memoryId]);
    await MemoryNodeDB.delete(memoryId);
  }
  for (const [eventBoxId, removedIds] of byBox) {
    const box = await EventBoxDB.getById(eventBoxId);
    if (!box) continue;
    box.liveMemoryIds = box.liveMemoryIds.filter(id => !removedIds.includes(id));
    box.archivedMemoryIds = box.archivedMemoryIds.filter(id => !removedIds.includes(id));
    if (box.summaryNodeId && removedIds.includes(box.summaryNodeId)) box.summaryNodeId = null;
    if (!box.liveMemoryIds.length && !box.archivedMemoryIds.length && !box.summaryNodeId) await EventBoxDB.delete(eventBoxId);
    else await EventBoxDB.save({ ...box, updatedAt: Date.now() });
  }
}
