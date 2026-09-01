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
  contextComments?: Array<{ actorName: string; content: string }>;
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
  const prompt = [
    '你是朋友圈互动规划器。只输出 JSON，不要 Markdown，不要解释。',
    '为这条朋友圈一次性规划首轮点赞/评论；不要为凑数强行互动，最多 8 条评论。',
    '每个 actorId 最多出现一次；可见角色已由系统筛选，不要新增名单外的人。',
    'dueAt 使用毫秒时间戳，必须在 now 之后 30 秒到 24 小时内，按自然错峰安排。',
    `JSON 形状：{"interactions":[{"actorId":"...","kind":"reaction|comment","content":"评论正文（点赞时省略）","dueAt":${now + 5 * 60_000}}]}`,
    `now=${now}`,
    `帖子：${JSON.stringify({ authorName: args.post.authorName, content: args.post.content, createdAt: args.post.createdAt })}`,
    `候选角色：${JSON.stringify(actorLines)}`,
    args.contextComments?.length ? `最新评论区（只规划未发送的新回应）：${JSON.stringify(args.contextComments)}` : '',
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
    const kind = row.kind === 'comment' ? 'comment' : row.kind === 'reaction' ? 'reaction' : null;
    if (!actor || !kind || used.has(actorId)) continue;
    const content = typeof row.content === 'string' ? row.content.trim().slice(0, 500) : '';
    if (kind === 'comment' && !content) continue;
    if (kind === 'comment' && interactions.filter(item => item.kind === 'comment').length >= maxComments) continue;
    used.add(actorId);
    interactions.push({
      actorId, actorType: actor.actorType === 'npc' ? 'npc' : 'character', actorName: actor.displayName,
      kind, ...(content ? { content } : {}), dueAt: clampDueAt(row.dueAt, now),
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
  now?: number;
}): Promise<MomentsCharacterPostPlan> {
  if (!isMomentsApiReady(args.config)) throw new Error('朋友圈副 API 尚未配置完整');
  const now = args.now || Date.now();
  const prompt = [
    '你是角色朋友圈生活线规划器。只输出 JSON，不要解释。',
    '结合角色人设与最近动态判断今天是否有值得发的朋友圈。没有真正值得记录的内容就 shouldPost=false，绝不要凑数。',
    `频率档位=${args.mode}（只影响机会，不代表必须发）；当前时间=${now}。不要在睡眠/明显不合适时段发。`,
    `本次照片占位=${args.preferPhoto ? '需要' : '不强制'}。若为“需要”且 shouldPost=true，必须填写 photoPrompt；同时用 photoIncludesAuthor 表示作者本人是否出镜。纯场景、食物、物品、风景应为 false。`,
    'JSON 形状：{"shouldPost":true,"content":"不超过500字的生活化正文","photoPrompt":"照片的具体画面描述","photoIncludesAuthor":false,"dueAt":0,"visibilityMode":"public|exclude","excludedActorIds":["候选 actorId"]}',
    '只有角色人设明确低调、避嫌或不愿被特定人看到时，才可选择 exclude；不得编造候选名单以外的 actorId。',
    `角色：${JSON.stringify({ name: args.actor.displayName, bio: args.actor.bio || '' })}`,
    `最近动态：${JSON.stringify(args.recentPosts.slice(0, 6).map(post => ({ content: post.content, createdAt: post.createdAt })))}`,
    `可作低调排除的朋友圈好友：${JSON.stringify(args.privacyCandidates || [])}`,
  ].join('\n');
  const data = await safeFetchJson(endpoint(args.config, '/chat/completions'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.config.apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: args.config.model.trim(), temperature: 0.85, stream: false, messages: [{ role: 'user', content: prompt }] }),
  }, 0, 90_000, { appName: '朋友圈', purpose: '角色生活线发帖判断' });
  const root = parseJsonObject(extractContent(data));
  const content = typeof root.content === 'string' ? root.content.trim().slice(0, 1000) : '';
  const modelPhotoPrompt = typeof root.photoPrompt === 'string' ? root.photoPrompt.trim().slice(0, 1000) : '';
  const photoPrompt = args.preferPhoto ? (modelPhotoPrompt || (content ? `与这条朋友圈正文一致的自然生活照片：${content}` : '')) : '';
  const photoIncludesAuthor = root.photoIncludesAuthor === true;
  const dueAt = clampDueAt(root.dueAt, now);
  const candidates = new Set((args.privacyCandidates || []).map(item => item.actorId));
  const excludedActorIds = Array.isArray(root.excludedActorIds)
    ? [...new Set(root.excludedActorIds.filter((item): item is string => typeof item === 'string' && candidates.has(item)))].slice(0, 24)
    : [];
  return {
    shouldPost: root.shouldPost === true && Boolean(content), content, ...(photoPrompt ? { photoPrompt, photoIncludesAuthor } : {}), dueAt,
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
