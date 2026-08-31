import type {
  CharacterProfile,
  Message,
  RelationshipInitiativeStyle,
  RelationshipProactiveConfig,
  RelationshipPulse,
} from '../types';

const HOUR = 60 * 60_000;

export const DEFAULT_RELATIONSHIP_PROACTIVE_CONFIG: RelationshipProactiveConfig = {
  enabled: false,
  initiativeStyle: 'natural',
  quietHoursEnabled: true,
  quietHoursStart: '23:30',
  quietHoursEnd: '08:00',
  dailyLimit: 2,
  followUpPromises: true,
  showHeartCard: true,
};

export const getRelationshipConfig = (char: CharacterProfile): RelationshipProactiveConfig => ({
  ...DEFAULT_RELATIONSHIP_PROACTIVE_CONFIG,
  ...(char.relationshipProactiveConfig || {}),
});

const clamp = (value: number, min = 0, max = 100) => Math.round(Math.max(min, Math.min(max, value)));

const visibleText = (message: Message) => message.content
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * 不是“关键词触发器”：这里只粗分哪些话具有未完成的现实后续，具体说什么仍由到点时
 * 的原版 fire pack 和角色上下文决定。区间宁可略宽，避免角色一句自然表达被死规则漏掉。
 */
export type RelationshipFollowUpKind = 'meeting' | 'travel' | 'errand' | 'rest' | 'generic' | null;

export const inferFollowUpKind = (message?: Message): RelationshipFollowUpKind => {
  if (!message || message.role !== 'assistant') return null;
  const text = visibleText(message);
  if (!text) return null;
  const hasFuture = /(?:等会|待会|晚点|之后|过会|一会|回头|回来|忙完|结束后|到家|到了|下班|收工|再找你|再联系|告诉你|给你发)/.test(text);
  if (!hasFuture) return null;
  if (/(?:开会|会议|上课|课上|面试|汇报|答辩|培训|工作|加班)/.test(text)) return 'meeting';
  if (/(?:到家|回家|路上|开车|坐车|地铁|高铁|飞机|赶路|出发)/.test(text)) return 'travel';
  if (/(?:买东西|取快递|办事|看医生|做饭|洗澡|收拾)/.test(text)) return 'errand';
  if (/(?:睡|休息|补觉|午睡)/.test(text)) return 'rest';
  return 'generic';
};

/** 合理的现实时间窗的中位数。角色日程/当前上下文仍会在 fire 时由模型二次判断。 */
export const followUpDelayMs = (kind: RelationshipFollowUpKind, style: RelationshipInitiativeStyle): number => {
  const base = kind === 'meeting' ? 70 * 60_000
    : kind === 'travel' ? 45 * 60_000
      : kind === 'errand' ? 40 * 60_000
        : kind === 'rest' ? 100 * 60_000
          : kind === 'generic' ? 90 * 60_000
            : 0;
  if (!base) return 0;
  return style === 'clingy' ? Math.round(base * 0.78)
    : style === 'reserved' ? Math.round(base * 1.22)
      : base;
};

/** 没有明确承诺时，关系层也只留一个克制的未来联系机会，避免沉默被永久遗漏。 */
export const connectionDelayMs = (style: RelationshipInitiativeStyle, longing: number): number => {
  const base = style === 'clingy' ? 3.5 * HOUR : style === 'reserved' ? 8 * HOUR : 5.5 * HOUR;
  // 思念越高，间隔最多收短约 45%；不使用分钟级高频打扰。
  return Math.round(base * (1 - Math.max(0, longing - 35) / 150));
};

export const relationshipDailyKey = (charId: string, timestamp = Date.now()) => {
  const d = new Date(timestamp);
  return `sully_relationship_active_${charId}_${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

export const relationshipTaskCountToday = (charId: string, timestamp = Date.now()): number => {
  try { return Number(localStorage.getItem(relationshipDailyKey(charId, timestamp)) || 0) || 0; }
  catch { return 0; }
};

export const markRelationshipTaskToday = (charId: string, timestamp = Date.now()) => {
  try {
    const key = relationshipDailyKey(charId, timestamp);
    localStorage.setItem(key, String(relationshipTaskCountToday(charId, timestamp) + 1));
  } catch { /* private mode: scheduling still works, only daily count cannot persist */ }
};

export const calculateRelationshipPulse = (
  char: CharacterProfile,
  messages: Message[],
  now = Date.now(),
): RelationshipPulse => {
  const previous = char.relationshipPulse;
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  const sinceUserHours = lastUser ? Math.max(0, (now - lastUser.timestamp) / HOUR) : 0;
  const alternations = messages.slice(-80).filter(m => m.role === 'assistant').length;
  const recentText = messages.slice(-16).map(visibleText).join(' ');
  const jealousySignals = (recentText.match(/(?:吃醋|别人|前任|约会|喜欢谁|不理我|冷落)/g) || []).length;
  const affectionBase = previous?.affection ?? 58;
  const affection = clamp(affectionBase + Math.min(10, alternations / 10));
  const jealousy = clamp((previous?.jealousy ?? 8) * 0.72 + jealousySignals * 9, 0, 85);
  const baseline = previous?.baselineLonging ?? 26;
  const replyRelief = lastUser && lastUser.timestamp > (previous?.lastUserReplyAt || 0) ? 12 : 0;
  const longing = clamp(baseline - replyRelief + Math.min(58, sinceUserHours * (getRelationshipConfig(char).initiativeStyle === 'clingy' ? 4.8 : 3.2)));
  const fallbackVoice = longing >= 72 ? '很想等你空下来，再听你说几句。'
    : longing >= 45 ? '刚才的话还在心里轻轻打转。'
      : '把想说的话先悄悄留在心里。';
  return {
    version: 1,
    affection,
    jealousy,
    baselineLonging: longing,
    updatedAt: now,
    lastUserReplyAt: lastUser?.timestamp,
    innerVoice: (previous?.innerVoice || fallbackVoice).slice(0, 30),
  };
};

export const isTimeInQuietHours = (date: Date, config: RelationshipProactiveConfig): boolean => {
  if (!config.quietHoursEnabled) return false;
  const asMinutes = (value: string) => {
    const [hour = '0', minute = '0'] = value.split(':');
    return Number(hour) * 60 + Number(minute);
  };
  const current = date.getHours() * 60 + date.getMinutes();
  const start = asMinutes(config.quietHoursStart);
  const end = asMinutes(config.quietHoursEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
};

/** 将触发点推过免打扰；最多顺延到角色当地当天/次日的结束点。 */
export const moveOutOfQuietHours = (targetMs: number, config: RelationshipProactiveConfig): number => {
  const date = new Date(targetMs);
  if (!isTimeInQuietHours(date, config)) return targetMs;
  const [hour = '8', minute = '0'] = config.quietHoursEnd.split(':');
  const moved = new Date(date);
  moved.setHours(Number(hour), Number(minute), 0, 0);
  if (moved.getTime() <= targetMs) moved.setDate(moved.getDate() + 1);
  return moved.getTime();
};

export const buildRelationshipPromptHint = (kind: RelationshipFollowUpKind, charName: string): string => {
  const purpose = kind === 'meeting' ? '先前提到的工作/会议是否自然结束'
    : kind === 'travel' ? '先前提到的行程或回家路是否已自然告一段落'
      : kind === 'errand' ? '先前提到的事情是否已经忙完'
        : kind === 'rest' ? '先前提到的休息是否已结束'
          : '间隔一段时间后的自然关心';
  return `关系层联系机会：结合你自己的设定、日程、最新聊天和真实经过时间，判断${purpose}。只有确实自然且值得联系时才发一句符合你性格的话；不要提及排程、系统、思念值或“被要求来联系”。若用户刚回复、事件显然未结束或不适合打扰，请直接跳过，不要硬发。`;
};
