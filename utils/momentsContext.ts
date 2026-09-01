import { DB } from './db';

/**
 * 只拿角色亲自发布/参与，或确实被投递、浏览过的朋友圈事实。
 * “有可见权”本身不代表已看见，绝不能直接塞进私聊上下文。
 */
export async function buildMomentsLifeLine(charId: string, maxEvents = 6): Promise<string> {
  const actorId = `moments:character:${charId}`;
  const [ledger, receipts, posts] = await Promise.all([
    DB.getMomentsEventLedger(),
    DB.getMomentsSeenReceiptsByActorId(actorId),
    DB.getMomentsPosts(),
  ]);
  const seenPostIds = new Set(receipts
    .filter(receipt => ['delivered', 'seen', 'selected_for_interaction'].includes(receipt.state))
    .map(receipt => receipt.postId));
  const postById = new Map(posts.map(post => [post.id, post]));
  const relevant = ledger
    .filter(event => event.status !== 'deleted' && !event.deletedAt && (event.actorId === actorId || (event.postId && seenPostIds.has(event.postId))))
    .slice(-maxEvents);
  if (!relevant.length) return '';
  const lines = relevant.map(event => {
    const post = event.postId ? postById.get(event.postId) : undefined;
    const time = new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (event.type === 'post') return `[朋友圈 ${time}] ${event.actorId === actorId ? '你发布了' : `你看到 ${post?.authorName || '一位朋友'} 发布了`}：${(post?.content || '一条动态').slice(0, 180)}`;
    if (event.type === 'reaction') return `[朋友圈 ${time}] ${event.actorId === actorId ? '你点了赞' : '你看到一条动态新增了点赞'}${post ? `：${post.authorName} 的动态` : ''}`;
    if (event.type === 'comment') return `[朋友圈 ${time}] ${event.actorId === actorId ? '你参与了评论' : '你看到一条动态新增了评论'}${post ? `：${post.authorName} 的动态` : ''}`;
    if (event.type === 'share') return `[朋友圈 ${time}] 用户把一条朋友圈转发给你。`;
    if (event.type === 'media') return `[朋友圈 ${time}] ${event.actorId === actorId ? '你' : post?.authorName || '一位朋友'} 发布了一张朋友圈图片。`;
    if (event.type === 'reply') return `[朋友圈 ${time}] ${event.actorId === actorId ? '你回复了评论' : '你看到一条评论回复'}${post ? `：${post.authorName} 的动态` : ''}`;
    if (event.type === 'seen') return `[朋友圈 ${time}] 你刷到了 ${post?.authorName || '一位朋友'} 的动态：${(post?.content || '一条动态').slice(0, 180)}`;
    return '';
  }).filter(Boolean);
  return lines.length ? `\n\n[你的近期朋友圈生活线：以下是已实际发生/看见的事实，只在自然相关时提起；不要声称看过未列出的动态]\n${lines.join('\n')}` : '';
}
