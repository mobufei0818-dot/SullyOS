import type {
  APIConfig,
  CharacterProfile,
  GroupProfile,
  Message,
  MomentsApiConfig,
  MomentsInteractionMode,
  MomentsPostingMode,
  MomentsProfile,
  MomentsRuntimeActorDiagnostic,
  MomentsSettings,
  MomentsWorkerConfig,
} from '../types';
import { DB } from './db';
import { ActiveMsgStore } from './activeMsgStore';
import { ActiveMsgClient } from './activeMsgClient';
import { buildMomentsLlmCredentialRow, MOMENTS_LLM_CREDENTIAL_ID } from './amsgLlmCredentials';
import { isMomentsApiReady, momentsApiFromMain } from './momentsApi';
import {
  getMomentsRuntimeActors,
  isMomentsWorkerReady,
  syncMomentsRuntime,
  type MomentsCloudActorRuntime,
  type MomentsRuntimeSyncPayload,
} from './momentsSync';
import { resolveCharTimeZone } from './timezone';

export const MOMENTS_RUNTIME_RESYNC_EVENT = 'sullyos:moments-runtime-resync';
const PENDING_KEY = 'sullyos_moments_runtime_resync_pending_v1';
const FINGERPRINT_KEY_PREFIX = 'sullyos_moments_runtime_fingerprint_v1:';
const USER_PROFILE_ID = 'moments:user';

const DEFAULT_SETTINGS: MomentsSettings = {
  id: 'main', enabled: true, strangersCanViewTen: false,
  autoInteractionEnabled: true, offlineSyncEnabled: false, jealousyForceEnabled: true,
  characterPostingModes: {}, npcPostingModes: {}, characterInteractionModes: {},
  visibilityGroups: [], momentsApi: undefined, worker: undefined,
  syncStatus: 'idle', updatedAt: 0,
};

type ResyncMarker = { requestedAt: number; reason: string; attempts: number };

const readMarker = (): ResyncMarker | null => {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    return parsed && typeof parsed.requestedAt === 'number' ? parsed : null;
  } catch {
    return null;
  }
};

export const hasPendingMomentsRuntimeResync = (): boolean => Boolean(readMarker());

export const markMomentsRuntimeResyncRequired = (reason: string): void => {
  const current = readMarker();
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({
      requestedAt: Date.now(),
      reason: reason || 'unknown',
      attempts: current?.attempts || 0,
    } satisfies ResyncMarker));
  } catch { /* localStorage unavailable: the in-page event still triggers */ }
  window.dispatchEvent(new CustomEvent(MOMENTS_RUNTIME_RESYNC_EVENT, { detail: { reason } }));
};

const noteRetry = (): number => {
  const current = readMarker() || { requestedAt: Date.now(), reason: 'retry', attempts: 0 };
  const attempts = Math.min(20, current.attempts + 1);
  try { localStorage.setItem(PENDING_KEY, JSON.stringify({ ...current, attempts } satisfies ResyncMarker)); } catch { /* ignore */ }
  return attempts;
};

const clearMarker = (): void => {
  try { localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
};

const hashString = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const formatMessageLine = (
  message: Pick<Message, 'role' | 'charId' | 'content' | 'timestamp'>,
  characterName: Map<string, string>,
  userName: string,
  selfId?: string,
): string => {
  const who = message.role === 'user' ? userName : message.charId === selfId ? '你' : (characterName.get(message.charId) || '群友');
  const date = new Date(message.timestamp);
  return `[${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}] ${who}：${(message.content || '').replace(/\s+/g, ' ').slice(0, 240)}`;
};

const buildActorContexts = async (
  actors: MomentsProfile[],
  characters: CharacterProfile[],
  groups: GroupProfile[],
  userName: string,
): Promise<Map<string, { persona: string; userRelationship: string; privateChat: string; sharedGroupChat: string }>> => {
  const characterIds = Array.from(new Set(actors.map(actor => actor.characterId).filter((id): id is string => Boolean(id))));
  const relevantGroups = groups.filter(group => group.members.some(memberId => characterIds.includes(memberId)));
  const [privateRows, groupRows] = await Promise.all([
    Promise.all(characterIds.map(async id => [id, await DB.getMessagesByCharId(id, true)] as const)),
    Promise.all(relevantGroups.map(async group => [group, await DB.getGroupMessages(group.id)] as const)),
  ]);
  const privateByCharacter = new Map(privateRows);
  const characterName = new Map(characters.map(character => [character.id, character.name]));
  return new Map(actors.map(actor => {
    const character = actor.characterId ? characters.find(item => item.id === actor.characterId) : undefined;
    if (!character) return [actor.id, {
      persona: [actor.relationLabel, actor.bio].filter(Boolean).join('；').slice(0, 1200),
      userRelationship: actor.friendshipState === 'friend' ? '这是用户的朋友圈好友；亲疏以当前评论区事实为准。' : '这是一次偶然刷到动态的路人，不得假装与用户熟识。',
      privateChat: '近期没有私聊原文。',
      sharedGroupChat: '近期没有可用的共同群聊原文。',
    }];
    const privateChat = (privateByCharacter.get(character.id) || []).slice(-18)
      .map(message => formatMessageLine(message, characterName, userName, character.id)).join('\n');
    const sharedGroupChat = groupRows
      .filter(([group]) => group.members.includes(character.id))
      .flatMap(([group, messages]) => messages.slice(-(group.privateContextCap ?? 24))
        .map(message => `[群：${group.name}] ${formatMessageLine(message, characterName, userName, character.id)}`))
      .slice(-48).join('\n');
    const pulse = character.relationshipPulse;
    const relationship = [
      pulse ? `当前关系数值：好感 ${pulse.affection}，醋意 ${pulse.jealousy}，思念基线 ${pulse.baselineLonging}` : '',
      character.impression ? `角色眼中的用户：${JSON.stringify(character.impression).slice(0, 1400)}` : '',
    ].filter(Boolean).join('\n');
    return [actor.id, {
      persona: [`备注：${character.description || '无'}`, character.systemPrompt || actor.bio || ''].join('\n').slice(0, 4500),
      userRelationship: relationship || '没有额外关系快照，按近期私聊与当前朋友圈互动判断。',
      privateChat: privateChat || '近期没有私聊原文。',
      sharedGroupChat: sharedGroupChat || '近期没有可用的共同群聊原文。',
    }];
  }));
};

const resolveWorker = async (): Promise<MomentsWorkerConfig | null> => {
  const global = await ActiveMsgStore.getGlobalConfig();
  if (!global.workerUrl?.trim()) return null;
  return {
    url: global.workerUrl.trim(),
    clientToken: global.serverToken?.trim() || '',
    userId: global.userId?.trim() || undefined,
  };
};

const buildPayload = async (apiConfig: APIConfig, settings: MomentsSettings, worker: MomentsWorkerConfig): Promise<{
  payload: MomentsRuntimeSyncPayload;
  api: MomentsApiConfig;
  credentialFingerprint: string;
}> => {
  const [characters, groups, posts, gallery, storedCharacters, npcProfiles, userProfile] = await Promise.all([
    DB.getAllCharacters(), DB.getGroups(), DB.getMomentsPosts(), DB.getGalleryImages(),
    DB.getMomentsProfilesByActorType('character'), DB.getMomentsProfilesByActorType('npc'), DB.getUserProfile(),
  ]);
  const storedByCharacterId = new Map(storedCharacters.map(profile => [profile.characterId, profile]));
  const characterActors: MomentsProfile[] = characters.map(character => {
    const existing = storedByCharacterId.get(character.id);
    return {
      id: `moments:character:${character.id}`, actorType: 'character', characterId: character.id,
      displayName: character.name, avatar: character.avatar, friendshipState: 'friend',
      bio: existing?.bio || '', relationLabel: existing?.relationLabel,
      parentCharacterId: existing?.parentCharacterId, updatedAt: existing?.updatedAt || Date.now(),
    };
  });
  const actors = [...characterActors, ...npcProfiles];
  const contexts = await buildActorContexts(actors, characters, groups, userProfile?.name || '用户');
  const privacyCandidates = actors.map(actor => ({
    actorId: actor.id,
    name: actor.displayName,
    groupName: actor.characterId ? characters.find(character => character.id === actor.characterId)?.groupId : undefined,
  }));
  const runtimeActors: MomentsCloudActorRuntime[] = actors.map(actor => {
    const ownCharacter = actor.characterId ? characters.find(item => item.id === actor.characterId) : undefined;
    const parentCharacter = actor.parentCharacterId ? characters.find(item => item.id === actor.parentCharacterId) : undefined;
    const context = contexts.get(actor.id);
    const postingMode: MomentsPostingMode = actor.actorType === 'npc'
      ? settings.npcPostingModes?.[actor.id] || 'low'
      : settings.characterPostingModes?.[actor.characterId || ''] || 'off';
    const interactionMode: MomentsInteractionMode = actor.actorType === 'npc'
      ? 'normal'
      : settings.characterInteractionModes?.[actor.characterId || ''] || 'normal';
    const timezoneId = resolveCharTimeZone(ownCharacter)
      || resolveCharTimeZone(parentCharacter)
      || Intl.DateTimeFormat().resolvedOptions().timeZone
      || 'UTC';
    const ownGallery = actor.characterId ? gallery.filter(image => image.charId === actor.characterId).slice(0, 18) : [];
    return {
      actorId: actor.id,
      actorType: actor.actorType as 'character' | 'npc',
      ...(actor.characterId ? { characterId: actor.characterId } : {}),
      ...(actor.parentCharacterId ? { parentCharacterId: actor.parentCharacterId } : {}),
      displayName: actor.displayName,
      ...(actor.avatar ? { avatar: actor.avatar } : {}),
      ...(actor.bio ? { bio: actor.bio } : {}),
      postingMode,
      interactionMode,
      timezoneId,
      timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
      pack: {
        persona: context?.persona || [actor.relationLabel, actor.bio].filter(Boolean).join('；'),
        userRelationship: context?.userRelationship || '以近期对话和当前朋友圈事实判断关系。',
        privateChat: context?.privateChat || '近期没有私聊原文。',
        sharedGroupChat: context?.sharedGroupChat || '近期没有可用的共同群聊原文。',
        recentPosts: posts.filter(post => post.authorId === actor.id).slice(0, 8)
          .map(post => ({ content: post.content, createdAt: post.createdAt })),
        galleryOptions: ownGallery.map(image => ({
          id: image.id, url: image.url, savedDate: image.savedDate,
          review: image.review?.slice(0, 180), context: image.chatContext?.slice(-3).join(' · ').slice(0, 260),
        })),
        privacyCandidates: privacyCandidates.filter(candidate => candidate.actorId !== actor.id),
      },
    };
  });
  const api = settings.momentsApi || momentsApiFromMain(apiConfig);
  return {
    payload: {
      userId: worker.userId?.trim() || `moments-user-${USER_PROFILE_ID}`,
      enabled: settings.enabled && settings.offlineSyncEnabled,
      autoInteractionEnabled: settings.autoInteractionEnabled,
      credentialId: MOMENTS_LLM_CREDENTIAL_ID,
      replaceAll: true,
      actors: runtimeActors,
      updatedAt: Date.now(),
    },
    api,
    credentialFingerprint: hashString(`${api.baseUrl}\u0000${api.apiKey}\u0000${api.model}`),
  };
};

export const momentsRuntimeMatchesExpected = (payload: MomentsRuntimeSyncPayload, rows: MomentsRuntimeActorDiagnostic[]): boolean => {
  const actual = new Map(rows.map(row => [row.actorId, row]));
  const expectedIds = new Set(payload.actors.map(actor => actor.actorId));
  if (rows.some(row => row.enabled && !expectedIds.has(row.actorId))) return false;
  return payload.actors.every(actor => {
    const row = actual.get(actor.actorId);
    if (!row) return false;
    const expectedEnabled = payload.enabled && ['low', 'medium', 'high'].includes(actor.postingMode);
    return row.enabled === expectedEnabled
      && row.postingMode === actor.postingMode
      && row.displayName === actor.displayName
      && (!expectedEnabled || row.nextDecisionAt > 0);
  });
};

let syncInFlight: Promise<MomentsRuntimeRecoveryResult> | null = null;

export interface MomentsRuntimeRecoveryResult {
  state: 'synced' | 'healthy' | 'disabled' | 'not-configured';
  actorCount: number;
  upserted?: number;
}

export const ensureMomentsRuntime = (
  apiConfig: APIConfig,
  options: { force?: boolean; verify?: boolean } = {},
): Promise<MomentsRuntimeRecoveryResult> => {
  if (syncInFlight) return syncInFlight;
  const pending = (async (): Promise<MomentsRuntimeRecoveryResult> => {
    const [storedSettings, worker] = await Promise.all([DB.getMomentsSettings(), resolveWorker()]);
    if (!storedSettings || !worker || !isMomentsWorkerReady(worker)) {
      return { state: 'not-configured', actorCount: 0 };
    }
    const settings: MomentsSettings = {
      ...DEFAULT_SETTINGS, ...storedSettings,
      characterPostingModes: storedSettings.characterPostingModes || {},
      npcPostingModes: storedSettings.npcPostingModes || {},
      characterInteractionModes: storedSettings.characterInteractionModes || {},
      visibilityGroups: storedSettings.visibilityGroups || [],
    };
    const userId = worker.userId?.trim() || `moments-user-${USER_PROFILE_ID}`;
    const disabledPayload: MomentsRuntimeSyncPayload = {
      userId, enabled: false, autoInteractionEnabled: settings.autoInteractionEnabled,
      credentialId: MOMENTS_LLM_CREDENTIAL_ID, replaceAll: true, actors: [], updatedAt: Date.now(),
    };
    // 离线生活线关闭时只发一次“清空启用状态”，不读取聊天/群聊/相册来构建无用快照。
    const built = settings.offlineSyncEnabled
      ? await buildPayload(apiConfig, settings, worker)
      : { payload: disabledPayload, api: settings.momentsApi || momentsApiFromMain(apiConfig), credentialFingerprint: 'disabled' };
    const { payload, api, credentialFingerprint } = built;
    const fingerprint = hashString(stableJson({ ...payload, updatedAt: 0, credentialFingerprint }));
    const fingerprintKey = `${FINGERPRINT_KEY_PREFIX}${payload.userId}`;
    let lastFingerprint = '';
    try { lastFingerprint = localStorage.getItem(fingerprintKey) || ''; } catch { /* ignore */ }

    if (!options.force && lastFingerprint === fingerprint) {
      if (!options.verify) {
        clearMarker();
        return { state: payload.enabled ? 'healthy' : 'disabled', actorCount: payload.actors.length };
      }
      const runtimeActors = await getMomentsRuntimeActors(worker, payload.userId);
      if (momentsRuntimeMatchesExpected(payload, runtimeActors)) {
        clearMarker();
        return { state: payload.enabled ? 'healthy' : 'disabled', actorCount: payload.actors.length };
      }
    }

    if (payload.enabled) {
      if (!isMomentsApiReady(api)) throw new Error('朋友圈低价模型的 URL、Key 或 Model 不完整');
      const credential = buildMomentsLlmCredentialRow(api);
      if (!credential) throw new Error('朋友圈低价模型的 URL、Key 或 Model 不完整');
      await ActiveMsgClient.putLlmCredentials([credential]);
    }
    await DB.saveMomentsSettings({ ...settings, syncStatus: 'syncing', syncError: undefined, updatedAt: Date.now() });
    const result = await syncMomentsRuntime(worker, payload);
    try { localStorage.setItem(fingerprintKey, fingerprint); } catch { /* ignore */ }
    clearMarker();
    await DB.saveMomentsSettings({
      ...settings, syncStatus: 'synced', syncError: undefined,
      lastSyncAt: Date.now(), updatedAt: Date.now(),
    });
    return { state: payload.enabled ? 'synced' : 'disabled', actorCount: payload.actors.length, upserted: result.upserted };
  })().catch(async (error: any) => {
    noteRetry();
    const settings = await DB.getMomentsSettings().catch(() => null);
    if (settings) await DB.saveMomentsSettings({
      ...settings, syncStatus: 'failed', syncError: error?.message || '朋友圈云端运行表同步失败', updatedAt: Date.now(),
    }).catch(() => undefined);
    throw error;
  }).finally(() => { if (syncInFlight === pending) syncInFlight = null; });
  syncInFlight = pending;
  return pending;
};

export const momentsRuntimeRetryDelay = (): number => {
  const attempts = readMarker()?.attempts || 0;
  return Math.min(30 * 60_000, [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000][Math.min(attempts, 4)] || 30 * 60_000);
};
