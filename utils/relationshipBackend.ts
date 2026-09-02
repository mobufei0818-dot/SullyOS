import type { APIConfig, CharacterProfile, Message, RelationshipJealousySignal, RelationshipPulse } from '../types';
import { ActiveMsgStore } from './activeMsgStore';
import { ActiveMsgClient } from './activeMsgClient';
import { buildCharChatCredRow, fingerprintCredentialValue, type LlmCredentialRow } from './amsgLlmCredentials';
import { getRelationshipConfig } from './relationshipProactive';
import { followUpDelayMs, inferFollowUpKind } from './relationshipProactive';
import { resolveCharTimeZone } from './timezone';
import { getDailyScheduleForChar } from './dailySchedule';
import { isScheduleFeatureOn } from './scheduleFeature';
import { deriveRelationshipSleepWindows } from './relationshipSleep';
import { DB } from './db';

type UserSignal = 'neutral' | 'affectionate' | 'distant';

const latest = (messages: Message[], role: Message['role']) => [...messages].reverse().find(message => message.role === role);

type TakeoutDirection = 'takeout_to_user' | 'takeout_to_character';

const explicitTakeoutOrder = (text: string) => /(?:给|帮|替)(?:你|他|她|ta|TA).{0,16}(?:点了|下单了|叫了)|(?:点了|下单了|叫了).{0,16}(?:外卖|餐|饭|奶茶|饮品|咖啡|汉堡|披萨|水果|药)/.test(text);
const stableDeliveryMinutes = (seed: string) => {
  let value = 0;
  for (let index = 0; index < seed.length; index += 1) value = ((value * 31) + seed.charCodeAt(index)) >>> 0;
  return 25 + (value % 11);
};
/**
 * 外卖 App 暂停时的轻量剧情事件：只承认明确的“已经给对方点了/下单了”表述，
 * 不从“想吃”“帮我点一下”等意愿句猜订单，避免误触发。
 */
const latestTakeoutPromise = (messages: Message[]): { kind: TakeoutDirection; dueAt: number } | null => {
  const candidate = [...messages].reverse().slice(0, 16).find(message =>
    (message.role === 'assistant' || message.role === 'user') && explicitTakeoutOrder(message.content || ''));
  if (!candidate) return null;
  const kind: TakeoutDirection = candidate.role === 'assistant' ? 'takeout_to_user' : 'takeout_to_character';
  const minutes = stableDeliveryMinutes(`${candidate.id}:${candidate.timestamp}:${kind}`);
  return { kind, dueAt: candidate.timestamp + minutes * 60_000 };
};

const signalFrom = (message?: Message): UserSignal => {
  const text = message?.content || '';
  if (/(爱你|想你|喜欢你|抱抱|亲亲|舍不得|宝贝|宝宝|好爱)/.test(text)) return 'affectionate';
  if (/(别烦|忙|晚点说|不想|别找我|冷静)/.test(text)) return 'distant';
  return 'neutral';
};

/**
 * 私聊只上传一条已经发生的、去重的关系事实，不上传原文。
 * 普通“喜欢/想你”属于当前角色的好感，不会误计成吃醋；只有明确偏爱他人、比较、
 * 或对当前角色的安抚才进入醋意账本。
 */
const jealousySignalsFrom = (message: Message | undefined, char: CharacterProfile, knownCharacters: CharacterProfile[]): RelationshipJealousySignal[] => {
  if (!message || message.role !== 'user') return [];
  const text = message.content || '';
  const createdAt = message.timestamp || Date.now();
  const baseId = `chat-jealousy:${message.id || `${createdAt}:${char.id}`}:${char.id}`;
  const namedOther = knownCharacters.some(other => other.id !== char.id && other.name && text.includes(other.name));
  // CharacterProfile 本身没有“全部角色”的参数。这里从当前可见聊天原文中只判断泛化对象；
  // 朋友圈跨角色的精确识别由 MomentsApp 的已阅账本完成。
  const affectionateToOther = /(?:最爱|深爱|只爱|好爱|好喜欢|本命|梦中情人).{0,18}(?:他|她|ta|TA|别人|偶像|演员|人偶|纸片人|前任|男朋友|女朋友|老公|老婆|对象)|(?:偶像|演员|人偶|纸片人|前任|男朋友|女朋友|老公|老婆|对象).{0,18}(?:最爱|深爱|只爱|好爱|好喜欢|本命)/.test(text);
  const comparison = /(?:你|你们).{0,12}(?:不如|比不上|没).{0,14}(?:他|她|别人|前任|偶像|演员)|(?:他|她|别人|前任|偶像|演员).{0,16}(?:比你|比你们).{0,12}(?:好|强|重要)/.test(text);
  const reassurance = /(?:别吃醋|别生气|别难过|哄你|我错了|我只爱你|最爱你|只有你|没有别人)/.test(text)
    || new RegExp(`(?:只喜欢|只爱|最爱|最在乎|选的永远是).*${char.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${char.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.{0,14}(?:只喜欢|只爱|最爱|最在乎|别吃醋|哄你)`).test(text);
  if (reassurance) return [{ eventId: `${baseId}:reassurance`, kind: 'reassurance', intensity: 14, reason: '用户在私聊中明确安抚或表达偏爱', createdAt }];
  if (comparison) return [{ eventId: `${baseId}:comparison`, kind: 'chat_comparison', intensity: 19, reason: '用户在私聊中出现了明显比较或冷落信号', createdAt }];
  if (namedOther && /(?:爱|喜欢|想|宝贝|亲亲|约会|暧昧|最爱|只爱)/.test(text)) return [{ eventId: `${baseId}:named-other`, kind: 'chat_other_affection', intensity: 15, reason: '用户在私聊中对另一位已添加角色表达了强烈偏爱', createdAt }];
  if (affectionateToOther) return [{ eventId: `${baseId}:other-affection`, kind: 'chat_other_affection', intensity: 13, reason: '用户在私聊中对其他对象表达了强烈偏爱', createdAt }];
  return [];
};

const endpoint = (workerUrl: string) => `${workerUrl.replace(/\/+$/, '')}/relationship/state`;
const headers = (userId: string, token?: string) => ({
  'Content-Type': 'application/json', 'X-User-Id': userId,
  ...(token?.trim() ? { 'X-Client-Token': token.trim() } : {}),
});

const repairedMissingCredentialErrors = new Set<string>();
const verifiedRelationshipCredentials = new Set<string>();
const missingCredentialError = (message?: string) => Boolean(message && (
  message.includes('CREDENTIAL_NOT_FOUND')
  || message.includes('credRefs 引用的凭据不存在')
  || message.includes('引用的凭据不存在')
));

/**
 * 关系 Worker 创建的仍是原版 prompted 任务，任务只携带 `char:<id>/chat` 引用。
 * 新角色尚未排过普通 AMSG 任务时，这一行不会被其它链路顺带建立，因此必须在同步关系状态前先登记。
 * `putLlmCredentials` 自带指纹去重，正常重复同步不会重复写 D1；force 只用于云端明确报告该行丢失后的自愈。
 */
const ensureRelationshipChatCredentials = async (
  chars: CharacterProfile[],
  apiConfig: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'>,
  scope: { workerUrl: string; userId: string },
  options: { force?: boolean } = {},
): Promise<LlmCredentialRow[]> => {
  const uniqueChars = [...new Map(chars.map(char => [char.id, char])).values()];
  const rows = uniqueChars.map(char => buildCharChatCredRow(char, char.activeMsg2Config, apiConfig));
  const missing = uniqueChars.filter((_, index) => !rows[index]);
  if (missing.length) throw new Error(`主动消息 2.0 缺少可用的 API URL / Key / Model：${missing.map(char => char.name).join('、')}`);
  const completeRows = rows.filter((row): row is LlmCredentialRow => Boolean(row));
  const verificationKeys = completeRows.map(row =>
    `${scope.workerUrl.replace(/\/+$/, '')}|${scope.userId}|${row.credId}|${fingerprintCredentialValue(row.value)}`);
  const uncheckedRows = completeRows.filter((_, index) => options.force || !verifiedRelationshipCredentials.has(verificationKeys[index]));
  if (!uncheckedRows.length) return completeRows;

  await ActiveMsgClient.putLlmCredentials(uncheckedRows, options);
  let remoteIds = new Set((await ActiveMsgClient.listLlmCredentials()).map(row => row.credId));
  let absentRows = uncheckedRows.filter(row => !remoteIds.has(row.credId));
  if (absentRows.length) {
    // 本地指纹可能还记着旧 D1 的成功记录；云端清单才是当前事实源。
    await ActiveMsgClient.putLlmCredentials(absentRows, { force: true });
    remoteIds = new Set((await ActiveMsgClient.listLlmCredentials()).map(row => row.credId));
    absentRows = absentRows.filter(row => !remoteIds.has(row.credId));
  }
  if (absentRows.length) {
    throw new Error(`Worker 未保存角色聊天凭据：${absentRows.map(row => row.credId).join('、')}`);
  }
  uncheckedRows.forEach(row => {
    const index = completeRows.findIndex(candidate => candidate.credId === row.credId);
    if (index >= 0) verifiedRelationshipCredentials.add(verificationKeys[index]);
  });
  return completeRows;
};

const asPulse = (data: any): RelationshipPulse | null => {
  if (!data || typeof data !== 'object') return null;
  return {
    version: 1,
    affection: Number(data.affection) || 0,
    jealousy: Number(data.jealousy) || 0,
    baselineLonging: Number(data.longing) || 0,
    nextThreshold: Number(data.nextThreshold) || 30,
    dailySent: Number(data.dailySent) || 0,
    updatedAt: Number(data.updatedAt) || Date.now(),
    innerVoice: typeof data.innerVoice === 'string' ? data.innerVoice : '',
    diagnostics: data.diagnostics && typeof data.diagnostics === 'object' ? {
      pendingTaskUuid: typeof data.diagnostics.pendingTaskUuid === 'string' ? data.diagnostics.pendingTaskUuid : undefined,
      lastDispatchAt: Number(data.diagnostics.lastDispatchAt) || undefined,
      lastTickAt: Number(data.diagnostics.lastTickAt) || undefined,
      nextTickAt: Number(data.diagnostics.nextTickAt) || undefined,
      lastScheduleError: typeof data.diagnostics.lastScheduleError === 'string' ? data.diagnostics.lastScheduleError : undefined,
      lastScheduleErrorAt: Number(data.diagnostics.lastScheduleErrorAt) || undefined,
      status: typeof data.diagnostics.status === 'string' ? data.diagnostics.status : undefined,
    } : undefined,
  };
};

/** 仅同步状态，不调用模型；Worker/D1 负责后续离线增长。 */
export const syncRelationshipBackend = async (
  char: CharacterProfile,
  messages: Message[],
  fallback: RelationshipPulse,
  knownCharacters: CharacterProfile[] = [],
  apiConfig: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'>,
) => {
  const global = await ActiveMsgStore.getGlobalConfig();
  if (!global?.workerUrl || !global?.userId) return null;
  const credentialScope = { workerUrl: global.workerUrl, userId: global.userId };
  const [chatCredential] = await ensureRelationshipChatCredentials([char], apiConfig, credentialScope);
  const [momentsSettings, schedule] = await Promise.all([
    DB.getMomentsSettings().catch(() => undefined),
    isScheduleFeatureOn(char) ? getDailyScheduleForChar(char).catch(() => null) : Promise.resolve(null),
  ]);
  const user = latest(messages, 'user');
  const assistant = latest(messages, 'assistant');
  const config = getRelationshipConfig(char);
  const takeoutPromise = latestTakeoutPromise(messages);
  const followUpKind = config.followUpPromises ? inferFollowUpKind(assistant) : null;
  const followUpDelay = followUpKind ? followUpDelayMs(followUpKind, config.initiativeStyle) : 0;
  const promise = takeoutPromise || (followUpKind && assistant
    ? { kind: followUpKind, dueAt: assistant.timestamp + followUpDelay }
    : null);
  const response = await fetch(endpoint(global.workerUrl), {
    method: 'POST', headers: headers(global.userId, global.serverToken),
    body: JSON.stringify({
      charId: char.id, charName: char.name, tzId: resolveCharTimeZone(char) || Intl.DateTimeFormat().resolvedOptions().timeZone,
      sleepWindows: deriveRelationshipSleepWindows(schedule),
      // 后端排程只读已同步到原版 Worker 的凭据引用；绝不把 API Key 再存一份。
      credRef: `char:${char.id}/chat`, config,
      initialLonging: fallback.baselineLonging, affection: fallback.affection, jealousy: fallback.jealousy,
      innerVoice: fallback.innerVoice, lastUserAt: user?.timestamp, lastAssistantAt: assistant?.timestamp,
      userSignal: signalFrom(user),
      jealousyEvents: jealousySignalsFrom(user, char, knownCharacters),
      jealousyForceEnabled: momentsSettings?.jealousyForceEnabled !== false,
      ...(promise ? { promise } : {}),
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) throw new Error(body?.error?.message || '关系状态同步失败。');
  const pulse = asPulse(body.data);
  const scheduleError = pulse?.diagnostics?.lastScheduleError;
  if (chatCredential && missingCredentialError(scheduleError)) {
    const repairKey = `${chatCredential.credId}:${pulse?.diagnostics?.lastScheduleErrorAt || scheduleError}`;
    if (!repairedMissingCredentialErrors.has(repairKey)) {
      await ensureRelationshipChatCredentials([char], apiConfig, credentialScope, { force: true });
      repairedMissingCredentialErrors.add(repairKey);
    }
  }
  return pulse;
};

export interface RelationshipJealousyTarget {
  char: CharacterProfile;
  signals: RelationshipJealousySignal[];
}

/**
 * 朋友圈一次事件可能被多位角色实际看见。批量提交到同一个 Worker，避免每个角色各走一套
 * 读-改-写，也确保 Worker 以 eventId 去重并统一决定是否建立 critical AMSG 任务。
 */
export const reportRelationshipJealousyEvents = async (
  targets: RelationshipJealousyTarget[],
  forceEnabled: boolean,
  apiConfig: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'>,
) => {
  const nonEmpty = targets.filter(target => target.signals.length > 0);
  if (!nonEmpty.length) return [];
  const global = await ActiveMsgStore.getGlobalConfig();
  if (!global?.workerUrl || !global?.userId) return [];
  await ensureRelationshipChatCredentials(nonEmpty.map(target => target.char), apiConfig, global);
  const response = await fetch(`${global.workerUrl.replace(/\/+$/, '')}/relationship/jealousy`, {
    method: 'POST', headers: headers(global.userId, global.serverToken),
    body: JSON.stringify({
      forceEnabled,
      targets: nonEmpty.map(({ char, signals }) => ({
        charId: char.id, charName: char.name,
        tzId: resolveCharTimeZone(char) || Intl.DateTimeFormat().resolvedOptions().timeZone,
        credRef: `char:${char.id}/chat`, config: getRelationshipConfig(char),
        initialLonging: char.relationshipPulse?.baselineLonging,
        initialJealousy: char.relationshipPulse?.jealousy,
        affection: char.relationshipPulse?.affection,
        innerVoice: char.relationshipPulse?.innerVoice,
        signals,
      })),
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) throw new Error(body?.error?.message || '朋友圈醋意事实同步失败。');
  return Array.isArray(body.data) ? body.data.map(asPulse).filter(Boolean) as RelationshipPulse[] : [];
};

/** 设置关闭时依然同步并展示醋意，但 Worker 不再强制建立 critical 联系机会。 */
export const setRelationshipJealousyForceEnabled = async (
  chars: CharacterProfile[],
  forceEnabled: boolean,
  apiConfig: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'>,
) => {
  const global = await ActiveMsgStore.getGlobalConfig();
  if (!chars.length || !global?.workerUrl || !global?.userId) return;
  await ensureRelationshipChatCredentials(chars, apiConfig, global);
  const response = await fetch(`${global.workerUrl.replace(/\/+$/, '')}/relationship/jealousy`, {
    method: 'POST', headers: headers(global.userId, global.serverToken),
    body: JSON.stringify({
      forceEnabled,
      targets: chars.map(char => ({
        charId: char.id, charName: char.name,
        tzId: resolveCharTimeZone(char) || Intl.DateTimeFormat().resolvedOptions().timeZone,
        credRef: `char:${char.id}/chat`, config: getRelationshipConfig(char),
        initialLonging: char.relationshipPulse?.baselineLonging,
        initialJealousy: char.relationshipPulse?.jealousy,
        affection: char.relationshipPulse?.affection,
        innerVoice: char.relationshipPulse?.innerVoice,
        signals: [],
      })),
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) throw new Error(body?.error?.message || '醋意强制联系设置同步失败。');
};

export const fetchRelationshipBackend = async (char: CharacterProfile) => {
  const global = await ActiveMsgStore.getGlobalConfig();
  if (!global?.workerUrl || !global?.userId) return null;
  const response = await fetch(`${endpoint(global.workerUrl)}?charId=${encodeURIComponent(char.id)}`, { headers: headers(global.userId, global.serverToken) });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) return null;
  return asPulse(body.data);
};

/** 用户从关系卡校正数值：请求直接写入 Worker/D1，刷新页面后仍以此状态为准。 */
export const updateRelationshipManualValues = async (
  char: CharacterProfile,
  values: { longing: number; nextThreshold: number },
) => {
  const global = await ActiveMsgStore.getGlobalConfig();
  if (!global?.workerUrl || !global?.userId || !char.activeMsg2Config?.enabled) {
    throw new Error('请先为该角色连接并启用主动消息 2.0。');
  }
  const response = await fetch(endpoint(global.workerUrl), {
    method: 'POST', headers: headers(global.userId, global.serverToken),
    body: JSON.stringify({
      charId: char.id, charName: char.name,
      tzId: resolveCharTimeZone(char) || Intl.DateTimeFormat().resolvedOptions().timeZone,
      credRef: `char:${char.id}/chat`, config: getRelationshipConfig(char),
      manual: {
        longing: Math.max(0, Math.min(100, Math.round(values.longing))),
        nextThreshold: Math.max(0, Math.min(100, Math.round(values.nextThreshold))),
      },
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) throw new Error(body?.error?.message || '思念值校正同步失败。');
  return asPulse(body.data);
};
