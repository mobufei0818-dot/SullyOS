/**
 * 朋友圈 → 记忆宫殿的事实桥。
 *
 * 只在角色实际发帖、参与互动、或被明确投递/刷到后调用；不把“仅有可见权”的动态写成记忆。
 * 同一条动态在同一角色处使用一个 EventBox，帖子和后续评论/点赞是这个盒的子节点。
 */
import type { MomentsEventLedgerEntry, MomentsPost } from '../types';
import { EventBoxDB, MemoryNodeDB } from './memoryPalace/db';
import type { EventBox, MemoryNode } from './memoryPalace/types';

const boxIdFor = (charId: string, postId: string) => `moments-eb:${charId}:${postId}`;
const nodeIdFor = (charId: string, sourceId: string) => `moments-memory-node:${charId}:${sourceId}`;

function describeEvent(post: MomentsPost | undefined, entry: MomentsEventLedgerEntry, selfActorId: string) {
  const owner = post?.authorName || '一位朋友';
  const body = (post?.content || (post?.mediaIds.length ? '一条带照片的朋友圈' : '一条朋友圈')).slice(0, 500);
  if (entry.type === 'post') return entry.actorId === selfActorId
    ? `我发布了一条朋友圈：${body}`
    : `我刷到 ${owner} 发布了一条朋友圈：${body}`;
  if (entry.type === 'reaction') return entry.actorId === selfActorId
    ? `我给 ${owner} 的朋友圈点了赞。`
    : `我看到 ${owner} 的朋友圈新增了点赞。`;
  if (entry.type === 'comment') return entry.actorId === selfActorId
    ? `我在 ${owner} 的朋友圈下参与了评论。`
    : `我看到 ${owner} 的朋友圈下出现了新的评论。`;
  if (entry.type === 'reply') return entry.actorId === selfActorId
    ? `我回复了 ${owner} 朋友圈下的一条评论。`
    : `我看到 ${owner} 的朋友圈下出现了评论回复。`;
  if (entry.type === 'media') return entry.actorId === selfActorId
    ? `我在朋友圈发布了一张图片。`
    : `我刷到 ${owner} 在朋友圈发布了一张图片。`;
  if (entry.type === 'seen') return `我刷到了 ${owner} 的朋友圈：${body}`;
  return `用户把 ${owner} 的一条朋友圈转发给我：${body}`;
}

/** 让一条已发生/已投递的朋友圈事实进入指定正式角色的记忆宫殿。幂等。 */
export async function mirrorMomentsEventToMemoryPalace(args: {
  charId: string;
  entry: MomentsEventLedgerEntry;
  post?: MomentsPost;
  selfActorId: string;
}): Promise<string> {
  const { charId, entry, post, selfActorId } = args;
  if (!entry.postId || entry.type === 'delete') return '';
  const eventBoxId = boxIdFor(charId, entry.postId);
  const memoryId = nodeIdFor(charId, entry.sourceId);
  const existing = await MemoryNodeDB.getById(memoryId);
  if (!existing) {
    const createdAt = entry.createdAt || Date.now();
    const node: MemoryNode = {
      id: memoryId,
      charId,
      content: describeEvent(post, entry, selfActorId),
      room: entry.type === 'share' ? 'user_room' : 'living_room',
      tags: ['moments', entry.type, post?.authorName || '朋友圈'],
      importance: entry.type === 'share' || entry.type === 'comment' ? 6 : 4,
      mood: 'neutral',
      embedded: false,
      createdAt,
      lastAccessedAt: createdAt,
      accessCount: 0,
      sourceId: `moments:${entry.postId}:${entry.sourceId}`,
      origin: 'system',
      eventBoxId,
      archived: false,
    };
    await MemoryNodeDB.save(node);
  }
  let box = await EventBoxDB.getById(eventBoxId);
  if (!box) {
    const createdAt = entry.createdAt || Date.now();
    box = {
      id: eventBoxId,
      charId,
      name: `${post?.authorName || '朋友圈'}的动态互动`,
      tags: ['moments', post?.authorName || '朋友圈'],
      summaryNodeId: null,
      liveMemoryIds: [memoryId],
      archivedMemoryIds: [],
      compressionCount: 0,
      createdAt,
      updatedAt: createdAt,
      lastCompressedAt: null,
    } satisfies EventBox;
  } else if (!box.liveMemoryIds.includes(memoryId) && !box.archivedMemoryIds.includes(memoryId) && box.summaryNodeId !== memoryId) {
    box.liveMemoryIds = [...box.liveMemoryIds, memoryId];
    box.updatedAt = Date.now();
  }
  await EventBoxDB.save(box);
  return memoryId;
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
