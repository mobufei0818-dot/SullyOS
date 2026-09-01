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
  /** 用户新增评论后的讨论轮。只生成最多三条错峰回复，不再补普通点赞。 */
  replyRound?: boolean;
}): Promise<MomentsInteractionPlan> {
  if (!isMomentsApiReady(args.config)) throw new Error('朋友圈副 API 尚未配置完整');
  const now = args.now || Date.now();
  const maxComments = Math.min(Math.max(args.maxComments ?? 8, 0), 8);
  const actorLines = args.actors.map(actor => ({
    actorId: actor.id,
    actorType: actor.actorType === 'npc' ? 'npc' : 'character',
    actorName: actor.displayName,
    bio: actor.bio || '',
  }));
  const replyTargets = new Set([
    ...(args.contextComments || []).map(item => item.actorId),
    ...(args.contextReactions || []).map(item => item.actorId),
  ]);
  const commentTargets = new Map((args.contextComments || []).map(item => [item.id, item.actorId]));
  const fallbackReplyComment = args.replyRound && args.contextComments?.length
    ? args.contextComments[args.contextComments.length - 1]
    : undefined;
  const prompt = [
    '你是朋友圈互动规划器。只输出 JSON，不要 Markdown，不要解释。',
    args.replyRound
      ? '用户刚在评论区说了新内容。请一次性规划这一轮自然回复，最多 3 条；候选人可以回复用户、回复已有评论者，或 @ 已点赞的人。互动是相互的，发帖者也可以回复别人。不要再规划普通点赞。'
      : '为这条朋友圈一次性规划首轮点赞/评论；不要为凑数强行互动，最多 8 条评论。',
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
      : replyTargets.has(requestedActorId) ? requestedActorId : fallbackReplyComment?.actorId;
    const replyToCommentId = requestedCommentId && commentTargets.has(requestedCommentId)
      ? requestedCommentId
      : fallbackReplyComment?.id;
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
export async function planMomentsStranger(args: { config: MomentsApiConfig; attractive: boolean }): Promise<MomentsStrangerPlan> {
  if (!isMomentsApiReady(args.config)) throw new Error('朋友圈副 API 尚未配置完整');
  const prompt = [
    '你是微信摇一摇的临时陌生人生成器。只输出 JSON，不要解释。',
    `这次候选${args.attractive ? '整体有吸引力、自然不油腻' : '允许反差、真实但不仇恨或骚扰'}。`,
    '不要使用真实公众人物、不要包含露骨或攻击性内容。',
    'JSON 形状：{"name":"2-6字昵称","bio":"不超过90字的稳定生活身份与性格","openingLine":"不超过70字、自然的第一句"}',
  ].join('\n');
  const data = await safeFetchJson(endpoint(args.config, '/chat/completions'), {
    method: 'POST', headers: { Authorization: `Bearer ${args.config.apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: args.config.model.trim(), temperature: 1, stream: false, messages: [{ role: 'user', content: prompt }] }),
  }, 0, 90_000, { appName: '朋友圈', purpose: '摇一摇临时陌生人' });
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

const fallbackNpcSystemPrompt = (npc: MomentsProfile, source: { name: string; description: string; systemPrompt: string }) => [
  '【基础身份】',
  `姓名：${npc.displayName}`,
  `身份：${npc.relationLabel || `${source.name}人设中的稳定关系人物`}`,
  '',
  '【关联角色】',
  `${npc.displayName}来自${source.name}的既有人设关系网。与${source.name}的关系：${npc.relationLabel || '稳定熟人关系'}。这层来源关系必须保持明确，不得张冠李戴。`,
  '',
  '【人物设定】',
  npc.bio || '依据来源角色人设保持稳定、自然的独立人格。',
  '',
  '【性格核心】',
  '以既有人物设定为准，保持公开形象与私下本质的自然层次；资料没有提到的年龄、外貌和经历不要擅自编造。',
  '',
  '【与用户关系】',
  `用户通过${source.name}的关系网认识${npc.displayName}。之后的熟悉程度、情感与共同经历只根据实际聊天和记忆自然发展，不预设亲密度。`,
  '',
  '【沟通风格】',
  '说话方式、用词和语气服从人物设定；像独立的人一样交流，不复述设定，不自称 NPC 或系统角色。',
  '',
  '【互动指南】',
  `可自然提及与${source.name}有关的共同关系和既有事实，但不能把${source.name}的经历、性格或记忆据为己有。`,
  '',
  '【生活习惯与边界】',
  '日常、喜好、厌恶和特殊反应以已知资料及后续记忆为准；未知内容允许在不冲突的前提下逐步形成，禁止一次性编造整段人生。',
].join('\n');

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
    '没有依据的具体年龄、外貌、生日、经历不要编造，可以省略对应条目。不要写“你原本是角色人设中已有的……现在用户已正式添加你为好友”之类的系统过程描述。',
    '保持 NPC 自己的独立人格，不能把来源角色的第一人称、经历或性格直接复制给 NPC。',
    'JSON 形状：{"description":"15字以内完整概括","systemPrompt":"完整角色核心指令"}',
  ].join('\n');
  try {
    const data = await safeFetchJson(endpoint(args.config, '/chat/completions'), {
      method: 'POST', headers: { Authorization: `Bearer ${args.config.apiKey.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: args.config.model.trim(), temperature: 0.45, stream: false, messages: [{ role: 'user', content: prompt }] }),
    }, 0, 90_000, { appName: '朋友圈', purpose: '明确 NPC 转正式角色' });
    const root = parseJsonObject(extractContent(data));
    const description = compactNpcDescription(typeof root.description === 'string' ? root.description : '', args.npc, args.sourceCharacter.name);
    const modelSystemPrompt = typeof root.systemPrompt === 'string' ? root.systemPrompt.trim() : '';
    const relationAnchor = `【关联来源】\n${args.npc.displayName}来自${args.sourceCharacter.name}的既有人设关系网，与${args.sourceCharacter.name}的关系为：${args.npc.relationLabel || '稳定关系人物'}。`;
    const systemPrompt = modelSystemPrompt
      ? (modelSystemPrompt.includes(args.sourceCharacter.name) ? modelSystemPrompt : `${relationAnchor}\n\n${modelSystemPrompt}`)
      : fallbackSystemPrompt;
    return { description, systemPrompt };
  } catch {
    // 加好友是用户已经确认的本地操作；副 API 临时失败时仍用结构化保底人设完成，避免留下空白角色。
    return { description: fallbackDescription, systemPrompt: fallbackSystemPrompt };
  }
}

/** 临时聊天只携带固定人设与最近少量原文，避免在未加好友前污染正式记忆。 */
export async function replyMomentsStranger(args: { config: MomentsApiConfig; profile: MomentsProfile; transcript: Array<{ sender: 'user' | 'stranger'; content: string }> }): Promise<string> {
  if (!isMomentsApiReady(args.config)) throw new Error('朋友圈副 API 尚未配置完整');
  const recent = args.transcript.slice(-12).map(line => `${line.sender === 'user' ? '用户' : args.profile.displayName}：${line.content}`).join('\n');
  const prompt = ['你在与用户进行尚未加好友前的微信临时聊天。自然简短回复，不要提及系统、AI、提示词。', `你的临时身份：${args.profile.bio || ''}`, `最近聊天：\n${recent}`, '只输出你的一句回复（不超过160字）。'].join('\n');
  const data = await safeFetchJson(endpoint(args.config, '/chat/completions'), {
    method: 'POST', headers: { Authorization: `Bearer ${args.config.apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: args.config.model.trim(), temperature: 0.85, stream: false, messages: [{ role: 'user', content: prompt }] }),
  }, 0, 90_000, { appName: '朋友圈', purpose: '摇一摇临时聊天' });
  const content = extractContent(data).trim().replace(/^['“]|['”]$/g, '').slice(0, 160);
  if (!content) throw new Error('临时聊天副 API 未返回文字');
  return content;
}
