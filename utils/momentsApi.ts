import type { APIConfig, ApiPreset, MomentsApiConfig, MomentsPost, MomentsProfile } from '../types';
import { extractContent, safeFetchJson } from './safeApi';
import { extractModelIds } from './modelList';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from './apiConfigNormalize';

export interface MomentsPlannedInteraction {
  actorId: string;
  actorType: 'character' | 'npc';
  actorName: string;
  kind: 'reaction' | 'comment';
  content?: string;
  replyToCommentId?: string;
  replyToActorId?: string;
  dueAt: number;
  idempotencyKey: string;
}

export interface MomentsInteractionPlan {
  postId: string;
  threadVersion: number;
  interactions: MomentsPlannedInteraction[];
}

/**
 * 朋友圈互动仍是一条动态一次调用；这些上下文由前端从本地消息库汇总，
 * 不会为了每个角色再单独请求一次 API。
 */
export interface MomentsInteractionActorContext {
  actorId: string;
  persona?: string;
  userRelationship?: string;
  privateChat?: string;
  sharedGroupChat?: string;
}

export interface MomentsCharacterPostPlan {
  shouldPost: boolean;
  content: string;
  photoPrompt?: string;
  photoIncludesAuthor?: boolean;
  /** 角色可改用自己小手机相册中的既有照片；只保存稳定 Gallery id，不把图片发给文本 API。 */
  galleryImageId?: string;
  dueAt?: number;
  /** 角色可选择对部分朋友圈好友低调；最终名单仍由前端按稳定 actorId 校验。 */
  visibilityMode?: 'public' | 'exclude';
  excludedActorIds?: string[];
}

export interface MomentsStrangerPlan {
  name: string;
  bio: string;
  openingLine: string;
}

export interface MomentsNpcPlan {
  sourceCharacterId: string;
  name: string;
  relationLabel: string;
  bio: string;
  initialPost?: string;
  initialPhotoPrompt?: string;
  initialPhotoIncludesAuthor?: boolean;
}

export interface MomentsNpcCharacterPlan {
  description: string;
  systemPrompt: string;
}

const PERSONA_SECTIONS = ['【基础身份】', '【外貌特征】', '【性格核心】', '【与用户关系】', '【沟通风格】', '【互动指南】', '【生活习惯】', '【特殊设定】'];

const stableHash = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
};

export const momentsApiFromMain = (config: APIConfig): MomentsApiConfig => ({
  source: 'main', enabled: true,
  baseUrl: normalizeApiBaseUrl(config.baseUrl),
  apiKey: normalizeApiCredential(config.apiKey),
  model: normalizeApiModel(config.model),
});

export const momentsApiFromPreset = (preset: ApiPreset): MomentsApiConfig => ({
  source: 'preset', presetId: preset.id, enabled: true,
  baseUrl: normalizeApiBaseUrl(preset.config.baseUrl),
  apiKey: normalizeApiCredential(preset.config.apiKey),
  model: normalizeApiModel(preset.config.model),
});

export const isMomentsApiReady = (config?: MomentsApiConfig | null): config is MomentsApiConfig => Boolean(
  config?.enabled && config.baseUrl.trim() && config.apiKey.trim() && config.model.trim(),
);

const endpoint = (config: MomentsApiConfig, path: string) => `${normalizeApiBaseUrl(config.baseUrl)}${path}`;

export async function fetchMomentsModels(config: MomentsApiConfig): Promise<string[]> {
  if (!config.baseUrl.trim()) throw new Error('请先填写朋友圈副 API URL');
  const data = await safeFetchJson(endpoint(config, '/models'), {
    method: 'GET',
    headers: { Authorization: `Bearer ${config.apiKey.trim()}`, 'Content-Type': 'application/json' },
  }, 0, 20_000, { appName: '朋友圈', purpose: '拉取副 API 模型' });
  const models = extractModelIds(data);
  if (!models.length) throw new Error('接口未返回可用模型列表');
  return models;
}

export async function testMomentsApi(config: MomentsApiConfig): Promise<void> {
  if (!isMomentsApiReady(config)) throw new Error('请填写完整的 URL、Key 和 Model');
  // /models 只验证网络与鉴权，不消耗模型生成额度，也不会制造一条朋友圈内容。
  await fetchMomentsModels(config);
}

const parseJsonObject = (text: string): Record<string, unknown> => {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(trimmed) as Record<string, unknown>; } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    throw new Error('朋友圈副 API 返回的互动规划不是有效 JSON');
  }
};

const clampDueAt = (value: unknown, now: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return now + 5 * 60_000;
  // 模型只能决定错峰窗口，不能把任务排到过去，也不能拖到无限远。
  return Math.min(Math.max(n, now + 30_000), now + 24 * 60 * 60_000);
};

/**
 * 一条帖子只调用一次副 API，生成完整、不可变的首轮互动计划。
 * 之后由本地/Worker 消费计划，不按角色数量重复调用模型。
 */
export async function planMomentsInteractions(args: {
  config: MomentsApiConfig;
  post: MomentsPost;
  actors: MomentsProfile[];
  now?: number;
  maxComments?: number;
  threadVersion?: number;
  contextComments?: Array<{ id: string; actorId: string; actorName: string; content: string }>;
  contextReactions?: Array<{ actorId: string; actorName: string }>;
  actorContexts?: MomentsInteractionActorContext[];
  /** 用户新增评论后的讨论轮。只生成最多三条错峰回复，不再补普通点赞。 */
  replyRound?: boolean;
}): Promise<MomentsInteractionPlan> {
  if (!isMomentsApiReady(args.config)) throw new Error('朋友圈副 API 尚未配置完整');
  const now = args.now || Date.now();
  const maxComments = Math.min(Math.max(args.maxComments ?? 8, 0), 8);
  const actorContextById = new Map((args.actorContexts || []).map(item => [item.actorId, item]));
  const actorLines = args.actors.map(actor => ({
    actorId: actor.id,
    actorType: actor.actorType === 'npc' ? 'npc' : 'character',
    actorName: actor.displayName,
    bio: actor.bio || '',
    ...(actorContextById.get(actor.id) || {}),
  }));
  const replyTargets = new Set([
    ...(args.contextComments || []).map(item => item.actorId),
    ...(args.contextReactions || []).map(item => item.actorId),
  ]);
  const commentTargets = new Map((args.contextComments || []).map(item => [item.id, item.actorId]));
  const prompt = [
    '你是朋友圈互动规划器。只输出 JSON，不要 Markdown，不要解释。',
    args.replyRound
      ? '用户刚在评论区说了新内容。请一次性规划这一轮自然回复，最多 3 条；候选人可以回复用户、回复已有评论者，或 @ 已点赞的人。互动是相互的，发帖者也可以回复别人。只有确实在回应某条评论时才填写 replyToCommentId/replyToActorId；只是围绕动态继续说话时必须省略目标，作为普通评论。不要让所有人都机械回复最新用户评论。不要再规划普通点赞。'
      : '为这条朋友圈一次性规划首轮点赞/评论；不要为凑数强行互动，最多 8 条评论。',
    '每个人的措辞、亲疏、情绪和边界必须来自该人的 persona、与用户的当前关系、近期私聊；回复另一个角色时还必须参考双方共同经历过的群聊上下文。没有共同上下文就只按当下评论自然回应，不得编造共同经历。',
    '这是一通统一规划调用，不要把不同角色写成同一种语气，也不要让角色知道自己看不到的私聊。',
    '每个 actorId 最多出现一次；可见角色已由系统筛选，不要新增名单外的人。',
    'dueAt 使用毫秒时间戳，必须在 now 之后 30 秒到 24 小时内，按自然错峰安排。',
    args.replyRound
      ? `JSON 形状：{"interactions":[{"actorId":"...","kind":"comment","content":"回复正文","replyToCommentId":"已有评论 id，可省略","replyToActorId":"用户/评论者/点赞者 actorId","dueAt":${now + 5 * 60_000}}]}`
      : `JSON 形状：{"interactions":[{"actorId":"...","kind":"reaction|comment","content":"评论正文（点赞时省略）","dueAt":${now + 5 * 60_000}}]}`,
    `now=${now}`,
    `帖子：${JSON.stringify({ authorName: args.post.authorName, content: args.post.content, createdAt: args.post.createdAt })}`,
    `候选角色：${JSON.stringify(actorLines)}`,
    args.contextComments?.length ? `现有评论区：${JSON.stringify(args.contextComments)}` : '',
    args.contextReactions?.length ? `已点赞的人（可以被 @）：${JSON.stringify(args.contextReactions)}` : '',
  ].join('\n');
  const data = await safeFetchJson(endpoint(args.config, '/chat/completions'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.config.apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: args.config.model.trim(),
      temperature: 0.7,
      stream: false,
      messages: [{ role: 'user', content: prompt }],
    }),
  }, 0, 90_000, { appName: '朋友圈', purpose: '首轮互动规划' });
  const root = parseJsonObject(extractContent(data));
  const raw = Array.isArray(root.interactions) ? root.interactions : [];
  const byId = new Map(args.actors.map(actor => [actor.id, actor]));
  const used = new Set<string>();
  const interactions: MomentsPlannedInteraction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const actorId = typeof row.actorId === 'string' ? row.actorId : '';
    const actor = byId.get(actorId);
    const kind = row.kind === 'comment' ? 'comment' : row.kind === 'reaction' && !args.replyRound ? 'reaction' : null;
    if (!actor || !kind || used.has(actorId)) continue;
    const content = typeof row.content === 'string' ? row.content.trim().slice(0, 500) : '';
    if (kind === 'comment' && !content) continue;
    if (kind === 'comment' && interactions.filter(item => item.kind === 'comment').length >= maxComments) continue;
    used.add(actorId);
    const requestedCommentId = typeof row.replyToCommentId === 'string' ? row.replyToCommentId : '';
    const requestedActorId = typeof row.replyToActorId === 'string' ? row.replyToActorId : '';
    const replyToActorId = requestedCommentId && commentTargets.has(requestedCommentId)
      ? commentTargets.get(requestedCommentId)
      : replyTargets.has(requestedActorId) ? requestedActorId : undefined;
    const replyToCommentId = requestedCommentId && commentTargets.has(requestedCommentId)
      ? requestedCommentId
      : undefined;
    interactions.push({
      actorId, actorType: actor.actorType === 'npc' ? 'npc' : 'character', actorName: actor.displayName,
      kind, ...(content ? { content } : {}),
      ...(args.replyRound && replyToActorId ? { replyToActorId, ...(replyToCommentId ? { replyToCommentId } : {}) } : {}),
      dueAt: args.replyRound
        ? Math.min(Math.max(clampDueAt(row.dueAt, now), now + 60_000), now + 60 * 60_000)
        : clampDueAt(row.dueAt, now),
      idempotencyKey: `moments:${args.post.id}:v${args.threadVersion || 1}:${actorId}:${kind}`,
    });
  }
  return { postId: args.post.id, threadVersion: args.threadVersion || 1, interactions: interactions.sort((a, b) => a.dueAt - b.dueAt) };
}

export async function planMomentsCharacterPost(args: {
  config: MomentsApiConfig;
  actor: MomentsProfile;
  mode: 'low' | 'medium' | 'high';
  recentPosts: MomentsPost[];
  privacyCandidates?: Array<{ actorId: string; name: string; groupName?: string }>;
  /** 由前端按稳定 80% 概率决定；为 true 时应生成可点击合成的照片占位。 */
  preferPhoto?: boolean;
  galleryOptions?: Array<{ id: string; savedDate?: string; review?: string; context?: string }>;
  now?: number;
}): Promise<MomentsCharacterPostPlan> {
  if (!isMomentsApiReady(args.config)) throw new Error('朋友圈副 API 尚未配置完整');
  const now = args.now || Date.now();
  const prompt = [
    '你是角色朋友圈生活线规划器。只输出 JSON，不要解释。',
    '结合角色人设与最近动态判断今天是否有值得发的朋友圈。没有真正值得记录的内容就 shouldPost=false，绝不要凑数。',
    `频率档位=${args.mode}（只影响机会，不代表必须发）；当前时间=${now}。不要在睡眠/明显不合适时段发。`,
    `本次带图倾向=${args.preferPhoto ? '需要' : '不强制'}。若 shouldPost=true 且需要带图，可以从自己的小手机相册候选中选择 galleryImageId；只有没有合适旧照时才填写 photoPrompt 生成新照片占位。二者只能选一个。photoIncludesAuthor 仅用于新生成照片。`,
    'JSON 形状：{"shouldPost":true,"content":"不超过500字的生活化正文","galleryImageId":"自己的相册候选 id，可省略","photoPrompt":"没有合适旧照时的新照片画面描述","photoIncludesAuthor":false,"dueAt":0,"visibilityMode":"public|exclude","excludedActorIds":["候选 actorId"]}',
    '只有角色人设明确低调、避嫌或不愿被特定人看到时，才可选择 exclude；不得编造候选名单以外的 actorId。',
    `角色：${JSON.stringify({ name: args.actor.displayName, bio: args.actor.bio || '' })}`,
    `最近动态：${JSON.stringify(args.recentPosts.slice(0, 6).map(post => ({ content: post.content, createdAt: post.createdAt })))}`,
    `自己的小手机相册候选（只根据文字摘要选择，不要编造 id）：${JSON.stringify(args.galleryOptions || [])}`,
    `可作低调排除的朋友圈好友：${JSON.stringify(args.privacyCandidates || [])}`,
  ].join('\n');
  const data = await safeFetchJson(endpoint(args.config, '/chat/completions'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.config.apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: args.config.model.trim(), temperature: 0.85, stream: false, messages: [{ role: 'user', content: prompt }] }),
  }, 0, 90_000, { appName: '朋友圈', purpose: '角色生活线发帖判断' });
  const root = parseJsonObject(extractContent(data));
  const content = typeof root.content === 'string' ? root.content.trim().slice(0, 1000) : '';
  const galleryIds = new Set((args.galleryOptions || []).map(item => item.id));
  const galleryImageId = typeof root.galleryImageId === 'string' && galleryIds.has(root.galleryImageId) ? root.galleryImageId : '';
  const modelPhotoPrompt = typeof root.photoPrompt === 'string' ? root.photoPrompt.trim().slice(0, 1000) : '';
  const photoPrompt = args.preferPhoto && !galleryImageId ? (modelPhotoPrompt || (content ? `与这条朋友圈正文一致的自然生活照片：${content}` : '')) : '';
  const photoIncludesAuthor = root.photoIncludesAuthor === true;
  const dueAt = clampDueAt(root.dueAt, now);
  const candidates = new Set((args.privacyCandidates || []).map(item => item.actorId));
  const excludedActorIds = Array.isArray(root.excludedActorIds)
    ? [...new Set(root.excludedActorIds.filter((item): item is string => typeof item === 'string' && candidates.has(item)))].slice(0, 24)
    : [];
  return {
    shouldPost: root.shouldPost === true && Boolean(content), content,
    ...(galleryImageId ? { galleryImageId } : photoPrompt ? { photoPrompt, photoIncludesAuthor } : {}), dueAt,
    ...(root.visibilityMode === 'exclude' && excludedActorIds.length ? { visibilityMode: 'exclude' as const, excludedActorIds } : {}),
  };
}

/** 摇一摇只生成临时档案；除非用户主动加好友，绝不写入正式 CharacterProfile。 */
export async function planMomentsStranger(args: { config: MomentsApiConfig; attractive: boolean; now?: number; diversitySeed?: string }): Promise<MomentsStrangerPlan> {
  if (!isMomentsApiReady(args.config)) throw new Error('朋友圈副 API 尚未配置完整');
  const now = new Date(args.now || Date.now());
  const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const clock = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${dayNames[now.getDay()]} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const prompt = [
    '你是微信摇一摇的临时陌生人生成器。只输出 JSON，不要解释。',
    `这次候选${args.attractive ? '整体有吸引力、自然不油腻' : '允许反差、真实但不仇恨或骚扰'}。`,
    '不要使用真实公众人物、不要包含露骨或攻击性内容。',
    `现在的现实时间是 ${clock}，对方是此刻在附近摇到的人。身份、正在做的事和第一句话必须符合这个时间，不要在深夜说刚下早班之类的矛盾话。`,
    `随机种子=${args.diversitySeed || `${Date.now()}-${Math.random()}`}。每次都重新创造姓名、年龄段、职业/处境、性格反差、兴趣和说话习惯，不得从固定候选名单挑人，也不要套用常见的摄影师/咖啡店模板。`,
    'JSON 形状：{"name":"2-6字昵称","bio":"不超过90字的稳定生活身份与性格","openingLine":"不超过70字、自然的第一句"}',
  ].join('\n');
  const data = await safeFetchJson(endpoint(args.config, '/chat/completions'), {
    method: 'POST', headers: { Authorization: `Bearer ${args.config.apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: args.config.model.trim(), temperature: 1, stream: false, messages: [{ role: 'user', content: prompt }] }),
  }, 0, 0, { appName: '朋友圈', purpose: '摇一摇临时陌生人' });
  const root = parseJsonObject(extractContent(data));
  const name = typeof root.name === 'string' ? root.name.trim().slice(0, 24) : '';
  const bio = typeof root.bio === 'string' ? root.bio.trim().slice(0, 180) : '';
  const openingLine = typeof root.openingLine === 'string' ? root.openingLine.trim().slice(0, 140) : '';
  if (!name || !bio) throw new Error('摇一摇副 API 返回的临时档案不完整');
  return { name, bio, openingLine: openingLine || '你好，刚好摇到你。' };
}

/** 仅提取人设里有姓名或稳定身份关系的 NPC；不把一次性路人扩展成角色库。 */
export async function planMomentsNpcProfiles(args: { config: MomentsApiConfig; characters: Array<{ id: string; name: string; description: string; systemPrompt: string }> }): Promise<MomentsNpcPlan[]> {
  if (!isMomentsApiReady(args.config)) throw new Error('朋友圈副 API 尚未配置完整');
  const prompt = [
    '你是角色人设中的朋友圈 NPC 提取器。只输出 JSON，不要解释。',
    '只保留已有明确姓名或稳定身份关系的 NPC（例如有名字的同事、室友、家人、固定好友）。不要编造，不要把路人或用户算进来；每个源角色最多 3 位。',
    '可选 initialPost 是这位 NPC 合理的首条简短朋友圈；不合适就省略。若写 initialPost，也尽量同时写具体的 initialPhotoPrompt，并用 initialPhotoIncludesAuthor 表示 NPC 本人是否出镜。',
    'JSON：{"npcs":[{"sourceCharacterId":"必须原样使用下方角色 id","name":"...","relationLabel":"...","bio":"不超过120字","initialPost":"可选，不超过300字","initialPhotoPrompt":"可选的照片画面","initialPhotoIncludesAuthor":false}]}',
    `角色人设：${JSON.stringify(args.characters.map(character => ({ id: character.id, name: character.name, description: character.description, systemPrompt: character.systemPrompt })))}`,
  ].join('\n');
  const data = await safeFetchJson(endpoint(args.config, '/chat/completions'), {
    method: 'POST', headers: { Authorization: `Bearer ${args.config.apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: args.config.model.trim(), temperature: 0.35, stream: false, messages: [{ role: 'user', content: prompt }] }),
  }, 0, 90_000, { appName: '朋友圈', purpose: '提取明确 NPC' });
  const root = parseJsonObject(extractContent(data));
  const validSources = new Set(args.characters.map(character => character.id));
  const sourceIdByName = new Map(args.characters.map(character => [character.name.trim(), character.id]));
  const used = new Set<string>();
  const raw = Array.isArray(root.npcs) ? root.npcs : [];
  return raw.flatMap((item): MomentsNpcPlan[] => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    // 一些模型会把人物名字写到 sourceCharacterName/source，而不是严格回填长 id；
    // 在可验证地匹配现有角色名时接受它，避免“已识别的明确 NPC 被整批过滤掉”。
    const rawSource = typeof row.sourceCharacterId === 'string'
      ? row.sourceCharacterId.trim()
      : typeof row.sourceCharacterName === 'string'
        ? row.sourceCharacterName.trim()
        : typeof row.source === 'string' ? row.source.trim() : '';
    const sourceCharacterId = validSources.has(rawSource) ? rawSource : (sourceIdByName.get(rawSource) || '');
    const name = typeof row.name === 'string' ? row.name.trim().slice(0, 24) : '';
    const relationLabel = typeof row.relationLabel === 'string' ? row.relationLabel.trim().slice(0, 40) : '';
    const bio = typeof row.bio === 'string' ? row.bio.trim().slice(0, 180) : '';
    if (!validSources.has(sourceCharacterId) || !name || !relationLabel || !bio) return [];
    const key = `${sourceCharacterId}:${name}`;
    if (used.has(key)) return [];
    used.add(key);
    const initialPost = typeof row.initialPost === 'string' ? row.initialPost.trim().slice(0, 500) : '';
    const wantsInitialPhoto = Boolean(initialPost) && stableHash(`${sourceCharacterId}:${name}:initial-photo`) % 100 < 80;
    const modelPhotoPrompt = typeof row.initialPhotoPrompt === 'string' ? row.initialPhotoPrompt.trim().slice(0, 1000) : '';
    const initialPhotoPrompt = wantsInitialPhoto ? (modelPhotoPrompt || `与这条朋友圈正文一致的自然生活照片：${initialPost}`) : '';
    return [{
      sourceCharacterId, name, relationLabel, bio,
      ...(initialPost ? { initialPost } : {}),
      ...(initialPhotoPrompt ? { initialPhotoPrompt, initialPhotoIncludesAuthor: row.initialPhotoIncludesAuthor === true } : {}),
    }];
  }).slice(0, 18);
}

const compactNpcDescription = (candidate: string, npc: MomentsProfile, sourceName: string) => {
  const clean = candidate.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[。；;，,]+$/g, '');
  if (clean && Array.from(clean).length <= 15) return clean;
  const fallbacks = [`${sourceName}的${npc.relationLabel || '熟人'}`, npc.relationLabel || '', `${sourceName}关联人物`, '角色关系网中的熟人'];
  return fallbacks.find(item => item && Array.from(item).length <= 15) || '角色关系网中的熟人';
};

const inferredPersonaFacts = (name: string, seedText: string) => {
  const seed = stableHash(`${name}:${seedText}`);
  const age = 21 + seed % 12;
  const month = 1 + Math.floor(seed / 13) % 12;
  const day = 1 + Math.floor(seed / 31) % 28;
  const gender = ['男', '女'][Math.floor(seed / 7) % 2];
  const heights = gender === '男' ? [172, 175, 178, 181, 183] : [158, 162, 165, 168, 170];
  const looks = [
    '深色短发，眼神清亮，穿衣偏简洁利落', '微卷深发，眉眼柔和，常穿低饱和色衣服',
    '发型打理得干净，笑起来有浅浅卧蚕，偏爱轻便日常装', '黑发自然垂落，轮廓清秀，常戴一件有辨识度的小配饰',
  ];
  const publicTraits = ['随和有分寸、观察细致、做事可靠', '爽朗直接、反应很快、擅长活跃气氛', '温和礼貌、慢热克制、对熟人很照顾', '冷静清醒、表达坦率、偶尔有一点毒舌'];
  const privateTraits = ['熟悉以后会显出孩子气和护短的一面', '独处时更安静，会反复琢磨在意的人说过的话', '私下情绪细腻，嘴上轻描淡写但行动很诚实', '对亲近的人分享欲很强，也会有不动声色的占有欲'];
  const habits = ['记录生活里的小事、散步、寻找好吃的小店', '听歌、夜间散步、随手拍下有趣画面', '规律收拾房间、喝咖啡、周末出门放风', '收藏冷知识、逛街区、偶尔熬夜看电影'];
  return {
    age, gender, height: heights[Math.floor(seed / 17) % heights.length], birthday: `${month}月${day}日`,
    look: looks[Math.floor(seed / 19) % looks.length], publicTrait: publicTraits[Math.floor(seed / 23) % publicTraits.length],
    privateTrait: privateTraits[Math.floor(seed / 29) % privateTraits.length], habit: habits[Math.floor(seed / 37) % habits.length],
  };
};

const completePersonaSystemPrompt = (args: {
  name: string;
  bio: string;
  identity: string;
  relationContext: string;
  sourceAnchor?: string;
}) => {
  const facts = inferredPersonaFacts(args.name, `${args.bio}:${args.identity}:${args.relationContext}`);
  return [
  '【基础身份】',
  `姓名：${args.name}`,
  `年龄：${facts.age}岁`,
  `性别：${facts.gender}`,
  `身高：${facts.height}cm`,
  `生日：${facts.birthday}`,
  `身份：${args.identity}`,
  `昵称：熟人通常称呼“${args.name}”；与用户熟悉后可根据真实互动自然形成专属昵称。`,
  '',
  ...(args.sourceAnchor ? ['【关联角色】', args.sourceAnchor, ''] : []),
  '【外貌特征】',
  `${facts.look}。整体气质与其生活身份相符；后续如用户手动补充外貌，以用户设定为准。`,
  '',
  '【性格核心】',
  `人物底色：${args.bio || args.identity}。`,
  `公开形象：${facts.publicTrait}。`,
  `私下本质：${facts.privateTrait}。`,
  '性格反差：在人多时会维持适合自身身份的分寸感，在信任的人面前更松弛、更诚实，也更愿意暴露真实情绪。',
  '',
  '【与用户关系】',
  args.relationContext,
  '关系会随实际聊天、朋友圈互动和共同记忆自然推进；不会凭空宣称没有发生过的共同经历。',
  '',
  '【沟通风格】',
  '说话口语化、句子长短随情绪变化，不复述人设，不自称 NPC、模型或系统角色。文字聊天会自然使用停顿和少量表情；语音时语速自然，情绪明显时会更直接。',
  '',
  '【互动指南】',
  '常见话题围绕自己的日常、工作学习、兴趣和最近发生的小事；会主动追问用户真正关心的部分。亲近时会用符合性格的玩笑或照顾表达在意；产生分歧时先表达自己的立场，再根据关系决定缓和或追问。',
  '',
  '【生活习惯】',
  `日常关键词：${facts.habit}。喜欢真诚、有回应的交流和有生活感的小事；厌恶敷衍、越界试探与无端羞辱。作息、行程与已发生剧情保持连续。`,
  '',
  '【特殊设定】',
  '禁止把别人的经历、关系或记忆说成自己的；禁止为了迎合用户而瞬间改变核心性格。遇到被误解、被冷落或关系升温时，应按性格与当前关系给出有层次的真实反应。用户后续手动修改的角色卡拥有最高优先级。',
  ].join('\n');
};

const fallbackNpcSystemPrompt = (npc: MomentsProfile, source: { name: string; description: string; systemPrompt: string }) => completePersonaSystemPrompt({
  name: npc.displayName,
  bio: npc.bio || `${source.name}关系网中的${npc.relationLabel || '熟人'}`,
  identity: npc.relationLabel || `${source.name}关系网中的稳定人物`,
  relationContext: `用户通过${source.name}的关系网认识${npc.displayName}，目前是刚添加好友、可以逐步熟悉的关系。`,
  sourceAnchor: `${npc.displayName}与来源角色${source.name}的既定关系是“${npc.relationLabel || '稳定熟人关系'}”。允许合理补齐${npc.displayName}自己的生活与性格，但必须保留这条来源关系，不能挪用${source.name}的经历、性格或记忆。`,
});

/** 用户把明确 NPC 正式加为角色时才调用；把短 bio 扩写为角色卡核心指令，不污染描述行。 */
export async function planMomentsNpcCharacterProfile(args: {
  config: MomentsApiConfig;
  npc: MomentsProfile;
  sourceCharacter: { name: string; description: string; systemPrompt: string };
}): Promise<MomentsNpcCharacterPlan> {
  const fallbackSystemPrompt = fallbackNpcSystemPrompt(args.npc, args.sourceCharacter);
  const fallbackDescription = compactNpcDescription('', args.npc, args.sourceCharacter.name);
  if (!isMomentsApiReady(args.config)) return { description: fallbackDescription, systemPrompt: fallbackSystemPrompt };
  const prompt = [
    '你正在把一个“既有角色人设中明确提到的 NPC”整理成独立角色卡。只输出 JSON，不要解释。',
    `NPC 名称：${args.npc.displayName}`,
    `NPC 与来源角色的关系：${args.npc.relationLabel || '稳定关系人物'}`,
    `NPC 已提取资料：${args.npc.bio || '无额外资料'}`,
    `来源角色名称：${args.sourceCharacter.name}`,
    `来源角色描述：${args.sourceCharacter.description || '无'}`,
    `来源角色核心指令：${args.sourceCharacter.systemPrompt || '无'}`,
    'description 是显示在角色名称下方的行为描述，只写一句完整的简短概括，最多 15 个汉字；不能截断句子，不能粘贴整段人设。',
    `systemPrompt 才是完整人设。必须明确写出此 NPC 与来源角色“${args.sourceCharacter.name}”的关系，并按有依据的内容组织以下部分：`,
    '【基础身份】姓名、年龄/性别（仅资料明确时）、身份；【关联角色】与来源角色的具体关系；【外貌特征】仅有依据时；',
    '【性格核心】公开形象、私下本质、反差；【与用户关系】初始关系与自然发展原则；【沟通风格】语言、文字、语音习惯；',
    '【互动指南】常见话题、敏感话题、亲密互动、冲突处理；【生活习惯】日常、喜好、厌恶；【特殊设定】禁止事项和特殊反应。',
    '允许依据已有资料进行合理、连贯、有生活感的创作补全；年龄、性别、外貌、生日、习惯等缺失项也要给出具体设定。不要写“未知”“待补充”“以资料为准”，用户不满意会自行修改。不要写“你原本是角色人设中已有的……现在用户已正式添加你为好友”之类的系统过程描述。',
    '保持 NPC 自己的独立人格，不能把来源角色的第一人称、经历或性格直接复制给 NPC。',
    'JSON 形状：{"description":"15字以内完整概括","systemPrompt":"完整角色核心指令"}',
  ].join('\n');
  try {
    const data = await safeFetchJson(endpoint(args.config, '/chat/completions'), {
      method: 'POST', headers: { Authorization: `Bearer ${args.config.apiKey.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: args.config.model.trim(), temperature: 0.45, stream: false, messages: [{ role: 'user', content: prompt }] }),
    }, 0, 20_000, { appName: '朋友圈', purpose: '明确 NPC 转正式角色' });
    const root = parseJsonObject(extractContent(data));
    const description = compactNpcDescription(typeof root.description === 'string' ? root.description : '', args.npc, args.sourceCharacter.name);
    const modelSystemPrompt = typeof root.systemPrompt === 'string' ? root.systemPrompt.trim() : '';
    const relationAnchor = `【关联来源】\n${args.npc.displayName}来自${args.sourceCharacter.name}的既有人设关系网，与${args.sourceCharacter.name}的关系为：${args.npc.relationLabel || '稳定关系人物'}。`;
    const completeModelCard = modelSystemPrompt && PERSONA_SECTIONS.every(section => modelSystemPrompt.includes(section));
    const systemPrompt = completeModelCard
      ? (modelSystemPrompt.includes(args.sourceCharacter.name) ? modelSystemPrompt : `${relationAnchor}\n\n${modelSystemPrompt}`)
      : fallbackSystemPrompt;
    return { description, systemPrompt };
  } catch {
    // 加好友是用户已经确认的本地操作；副 API 临时失败时仍用结构化保底人设完成，避免留下空白角色。
    return { description: fallbackDescription, systemPrompt: fallbackSystemPrompt };
  }
}

/** 摇一摇陌生人正式加好友时生成完整角色卡；仍是浏览器直连副 API，不经过 Worker。 */
export async function planMomentsStrangerCharacterProfile(args: {
  config: MomentsApiConfig;
  profile: MomentsProfile;
  transcript: Array<{ sender: 'user' | 'stranger'; content: string }>;
}): Promise<MomentsNpcCharacterPlan> {
  const description = compactNpcDescription(args.profile.bio || '', args.profile, '摇一摇');
  const fallback = completePersonaSystemPrompt({
    name: args.profile.displayName,
    bio: args.profile.bio || '通过摇一摇认识的普通人，拥有稳定、独立的生活和性格。',
    identity: args.profile.bio || '通过朋友圈摇一摇认识的新朋友',
    relationContext: `与用户通过朋友圈摇一摇偶然认识，目前处于刚添加好友、互相了解的阶段。临时聊天中已经发生的内容视为双方真实记忆。`,
  });
  if (!isMomentsApiReady(args.config)) return { description, systemPrompt: fallback };
  const prompt = [
    '把这位摇一摇认识的陌生人整理为完整、可直接使用的角色卡。只输出 JSON。',
    `姓名：${args.profile.displayName}`,
    `已有简介：${args.profile.bio || '无'}`,
    `临时聊天：${args.transcript.slice(-12).map(line => `${line.sender === 'user' ? '用户' : args.profile.displayName}：${line.content}`).join('\n') || '尚未聊天'}`,
    `systemPrompt 必须完整包含：${PERSONA_SECTIONS.join('、')}。`,
    '需要合理补齐姓名、年龄、性别、身高、生日、身份昵称、2-3个外貌特征、公开与私下性格反差、关系、沟通方式、互动指南、生活习惯、喜恶、禁止事项和特殊反应。允许创作补全，不得写未知、待补充、以资料为准或留空。',
    'description 是15个汉字以内的完整行为概括。JSON：{"description":"...","systemPrompt":"..."}',
  ].join('\n');
  try {
    const data = await safeFetchJson(endpoint(args.config, '/chat/completions'), {
      method: 'POST', headers: { Authorization: `Bearer ${args.config.apiKey.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: args.config.model.trim(), temperature: 0.75, stream: false, messages: [{ role: 'user', content: prompt }] }),
    }, 0, 20_000, { appName: '朋友圈', purpose: '摇一摇好友完整人设' });
    const root = parseJsonObject(extractContent(data));
    const modelPrompt = typeof root.systemPrompt === 'string' ? root.systemPrompt.trim() : '';
    return {
      description: compactNpcDescription(typeof root.description === 'string' ? root.description : '', args.profile, '摇一摇'),
      systemPrompt: modelPrompt && PERSONA_SECTIONS.every(section => modelPrompt.includes(section)) ? modelPrompt : fallback,
    };
  } catch {
    return { description, systemPrompt: fallback };
  }
}

/** 临时聊天只携带固定人设与最近少量原文，避免在未加好友前污染正式记忆。 */
export async function replyMomentsStranger(args: { config: MomentsApiConfig; profile: MomentsProfile; transcript: Array<{ sender: 'user' | 'stranger'; content: string; createdAt: number }>; now?: number }): Promise<string> {
  if (!isMomentsApiReady(args.config)) throw new Error('朋友圈副 API 尚未配置完整');
  const now = args.now || Date.now();
  const nowDate = new Date(now);
  const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const clock = `${nowDate.getFullYear()}年${nowDate.getMonth() + 1}月${nowDate.getDate()}日 ${dayNames[nowDate.getDay()]} ${String(nowDate.getHours()).padStart(2, '0')}:${String(nowDate.getMinutes()).padStart(2, '0')}`;
  const recentLines = args.transcript.slice(-24);
  const recent = recentLines.map(line => {
    const date = new Date(line.createdAt);
    return `[${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}] ${line.sender === 'user' ? '用户' : args.profile.displayName}：${line.content}`;
  }).join('\n');
  const lastAt = recentLines.at(-1)?.createdAt;
  const gapMinutes = lastAt ? Math.max(0, Math.floor((now - lastAt) / 60_000)) : 0;
  const prompt = [
    '你正在微信摇一摇的临时聊天里，以一个真实陌生人的身份回复。只输出本次要发出的正文，不要解释。',
    `你的稳定身份：${args.profile.bio || ''}`,
    `现在是 ${clock}。距离聊天里最后一条消息约 ${gapMinutes} 分钟。时间是生活背景，会影响作息、正在做的事和语气，但不要每次机械报时。`,
    '完整读完最近聊天，尤其要一起回应从你上次回复后用户连续发来的所有消息。承接具体措辞和话题，不要突然换成无关的天气、朋友圈或万能寒暄。',
    '像活人打字：由你的人设决定简短、停顿、反问、口头禅和情绪；可以不完美，可以只抓最想接的一两点。不要客服腔、总结腔、采访式连续提问，也不要声称自己是 AI。',
    `最近聊天：\n${recent || '尚未聊天'}`,
    '回复长度以自然为准，最多 300 字。',
  ].join('\n');
  const data = await safeFetchJson(endpoint(args.config, '/chat/completions'), {
    method: 'POST', headers: { Authorization: `Bearer ${args.config.apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: args.config.model.trim(), temperature: 0.85, stream: false, messages: [{ role: 'user', content: prompt }] }),
  }, 0, 0, { appName: '朋友圈', purpose: '摇一摇临时聊天' });
  const content = extractContent(data).trim().replace(/^['“]|['”]$/g, '').slice(0, 300);
  if (!content) throw new Error('临时聊天副 API 未返回文字');
  return content;
}
