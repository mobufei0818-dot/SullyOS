import type { CharacterProfile, Message, RelationshipPulse } from '../types';
import { ActiveMsgStore } from './activeMsgStore';
import { getRelationshipConfig } from './relationshipProactive';
import { followUpDelayMs, inferFollowUpKind } from './relationshipProactive';
import { resolveCharTimeZone } from './timezone';

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

const endpoint = (workerUrl: string) => `${workerUrl.replace(/\/+$/, '')}/relationship/state`;
const headers = (userId: string, token?: string) => ({
  'Content-Type': 'application/json', 'X-User-Id': userId,
  ...(token?.trim() ? { 'X-Client-Token': token.trim() } : {}),
});

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
export const syncRelationshipBackend = async (char: CharacterProfile, messages: Message[], fallback: RelationshipPulse) => {
  const global = await ActiveMsgStore.getGlobalConfig();
  if (!global?.workerUrl || !global?.userId || !char.activeMsg2Config?.enabled) return null;
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
      // 后端排程只读已同步到原版 Worker 的凭据引用；绝不把 API Key 再存一份。
      credRef: `char:${char.id}/chat`, config,
      initialLonging: fallback.baselineLonging, affection: fallback.affection, jealousy: fallback.jealousy,
      innerVoice: fallback.innerVoice, lastUserAt: user?.timestamp, lastAssistantAt: assistant?.timestamp,
      userSignal: signalFrom(user),
      ...(promise ? { promise } : {}),
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) throw new Error(body?.error?.message || '关系状态同步失败。');
  return asPulse(body.data);
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
