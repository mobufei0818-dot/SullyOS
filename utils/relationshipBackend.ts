import type { CharacterProfile, Message, RelationshipPulse } from '../types';
import { ActiveMsgStore } from './activeMsgStore';
import { getRelationshipConfig } from './relationshipProactive';
import { resolveCharTimeZone } from './timezone';

type UserSignal = 'neutral' | 'affectionate' | 'distant';

const latest = (messages: Message[], role: Message['role']) => [...messages].reverse().find(message => message.role === role);

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
  };
};

/** 仅同步状态，不调用模型；Worker/D1 负责后续离线增长。 */
export const syncRelationshipBackend = async (char: CharacterProfile, messages: Message[], fallback: RelationshipPulse) => {
  const global = await ActiveMsgStore.getGlobalConfig();
  if (!global?.workerUrl || !global?.userId || !char.activeMsg2Config?.enabled) return null;
  const user = latest(messages, 'user');
  const assistant = latest(messages, 'assistant');
  const config = getRelationshipConfig(char);
  const response = await fetch(endpoint(global.workerUrl), {
    method: 'POST', headers: headers(global.userId, global.serverToken),
    body: JSON.stringify({
      charId: char.id, charName: char.name, tzId: resolveCharTimeZone(char) || Intl.DateTimeFormat().resolvedOptions().timeZone,
      // 后端排程只读已同步到原版 Worker 的凭据引用；绝不把 API Key 再存一份。
      credRef: `char:${char.id}/chat`, config,
      initialLonging: fallback.baselineLonging, affection: fallback.affection, jealousy: fallback.jealousy,
      innerVoice: fallback.innerVoice, lastUserAt: user?.timestamp, lastAssistantAt: assistant?.timestamp,
      userSignal: signalFrom(user),
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

