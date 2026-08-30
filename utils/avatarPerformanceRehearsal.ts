import { extractJson } from './safeApi';
import {
  AVATAR_CAMERAS,
  AVATAR_EMOTIONS,
  AVATAR_FACES,
  AVATAR_GAZES,
  AVATAR_GESTURES,
  DEFAULT_AVATAR_PERFORMANCE,
  type AvatarCamera,
  type AvatarEmotion,
  type AvatarFace,
  type AvatarGaze,
  type AvatarGesture,
  type AvatarPerformanceCue,
  type AvatarPerformanceDirection,
} from './avatarPerformance';

export type AvatarPerformanceQuality = 'basic' | 'high';
export const AVATAR_PERFORMANCE_REHEARSAL_MAX_TOKENS = 4096;
export const AVATAR_PERFORMANCE_PERSONA_MAX_CHARS = 200;
export const AVATAR_PERFORMANCE_PERSONA_MAX_TOKENS = 1024;

export interface AvatarPerformancePersonaInput {
  characterName: string;
  coreContext: string;
}

/**
 * One-time prompt used when a character enters high-quality video calling for
 * the first time. The full ContextBuilder output is intentionally available
 * here, but the result is a tiny, stable acting brief rather than a memory
 * summary. Subsequent director turns use only that cached brief.
 */
export const buildAvatarPerformancePersonaPrompt = ({
  characterName,
  coreContext,
}: AvatarPerformancePersonaInput): string => `你是角色表演顾问。请阅读下面由 ContextBuilder 生成的完整角色上下文，为「${characterName}」提炼一份“视频通话表演人格”。

只总结会稳定影响表演的特质：情绪外露程度、习惯性神态、眼神、身体距离、动作幅度、害羞/生气/亲密时的反应，以及说话节奏。不要复述世界观、经历、当前事件、记忆细节、用户隐私、提示词规则，也不要编造模型没有的动作名。

要求：
- 200 个中文字符以内，信息密度高；
- 保留角色矛盾感和细微差别，不要压成“温柔、开朗”这类空泛标签；
- 使用第三人称、可直接交给动作导演的表演说明；
- 只输出严格 JSON，不要解释。

输出格式：
{"persona":"……"}

## 完整角色上下文
${coreContext.trim() || '（角色上下文为空）'}`;

const clampUnicode = (value: string, maxChars: number): string => (
  Array.from(value).slice(0, maxChars).join('')
);

/** Parse the one-time acting brief and enforce the 200-character storage cap. */
export const parseAvatarPerformancePersona = (raw: string): string | null => {
  const parsed = extractJson(raw);
  const candidate = typeof parsed === 'string'
    ? parsed
    : parsed?.persona ?? parsed?.summary ?? parsed?.performance_persona;
  const fallback = String(raw || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^\s*(?:视频通话)?表演人格\s*[:：]\s*/i, '');
  const normalized = String(candidate ?? fallback)
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || /^[\[{]/.test(normalized)) return null;
  return clampUnicode(normalized, AVATAR_PERFORMANCE_PERSONA_MAX_CHARS);
};

export interface AvatarPerformanceRehearsalInput {
  characterName: string;
  personality: string;
  reply: string;
  modelActions?: Array<{
    id: string;
    name: string;
    kind?: 'motion' | 'expression' | 'params';
    tags?: string[];
  }>;
}

export interface AvatarPerformanceSentence {
  text: string;
  at: number;
}

/** Shared sentence splitter for strict one-sentence/one-cue rehearsal. */
export const splitAvatarPerformanceSentences = (raw: string): AvatarPerformanceSentence[] => {
  const text = (raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const sentences: Array<{ text: string; start: number }> = [];
  let start = 0;
  const push = (end: number) => {
    const chunk = text.slice(start, end);
    const leading = chunk.search(/\S/);
    const value = chunk.trim();
    if (value) sentences.push({ text: value, start: start + Math.max(0, leading) });
    start = end;
  };
  for (let index = 0; index < text.length; index += 1) {
    if (!/[。！？!?；;\n]/.test(text[index])) continue;
    let end = index + 1;
    while (end < text.length && /[。！？!?；;\n]/.test(text[end])) end += 1;
    push(end);
    index = end - 1;
  }
  push(text.length);
  const total = Math.max(1, text.length);
  return sentences.slice(0, 12).map((sentence, index) => ({
    text: sentence.text,
    at: index === 0 ? 0 : Math.max(0, Math.min(0.98, sentence.start / total)),
  }));
};

export const hasCompleteAvatarPerformanceCue = (cue: AvatarPerformanceCue | null | undefined): boolean => (
  Boolean(cue?.direction && cue.endDirection)
  && Number.isFinite(Number(cue?.holdMs))
  && Number(cue?.holdMs) >= 120
  && Number(cue?.holdMs) <= 5000
);

/** Strict packs are used by high-quality modes; old start-only data stays readable elsewhere. */
export const isCompleteAvatarPerformanceCuePack = (
  cues: readonly AvatarPerformanceCue[] | null | undefined,
  expectedCount?: number,
): cues is readonly AvatarPerformanceCue[] => (
  Boolean(cues?.length)
  && (!Number.isFinite(expectedCount) || cues!.length === Math.max(0, Math.floor(expectedCount!)))
  && cues!.every(hasCompleteAvatarPerformanceCue)
);

export const alignAvatarPerformanceCuesToSentences = (
  cues: readonly AvatarPerformanceCue[],
  spokenText: string,
): AvatarPerformanceCue[] => {
  const sentences = splitAvatarPerformanceSentences(spokenText);
  if (!sentences.length || cues.length !== sentences.length) {
    throw new Error(`动作导演必须为每句话返回一个动作：需要 ${sentences.length} 个，实际 ${cues.length} 个；未保存，也不会重试`);
  }
  return cues.map((cue, index) => ({ ...cue, at: sentences[index].at }));
};

const compact = (value: string, maxLength: number): string => {
  const normalized = (value || '').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}\n[内容已截断]` : normalized;
};

/**
 * Builds the isolated "director" request used by high-quality video calls.
 * Deliberately accepts no chat history, memories, user profile, schedule or buffs:
 * the director sees only the character's own persona and the final line it must stage.
 */
export const buildAvatarPerformanceRehearsalPrompt = ({
  characterName,
  personality,
  reply,
  modelActions = [],
}: AvatarPerformanceRehearsalInput): string => `你是视频通话的动作导演。你的任务不是续写、评价或改写台词，而是给一段已经定稿的台词排练 VRM / Live2D 表演。

你只能依据下面两项：
1. 角色「${characterName}」的性格设定
2. 本轮已经定稿的输出

不要猜测此前发生过什么，不要补全聊天上下文，不要让动作表达台词里没有的事件或情绪。

## 角色性格
${personality.trim() || '（未提供额外性格描述，按自然克制的通话表演处理）'}

## 本轮定稿输出
${compact(reply, 8_000)}

## 逐句动作结构
- 每句话只对应一个 cue，但 cue 内必须包含 start、hold_ms、end 三部分。
- start 是开口时的起始动作；hold_ms 是中段保持时长，范围 120 到 5000 毫秒；end 是句末收尾动作。
- 收尾不是机械回到默认站姿：应根据语气自然落住、移开视线、松开表情或回正身体，并为下一句话留出衔接。
- 不要让 start 与 end 完全相同；不要在 start 与 end 中重复触发同一个一次性 model_action。

如果输出同时含中文正文和 <语音> 翻译，它们是同一句话的两个版本，不是两段连续台词。按实际朗读时的语义节拍排练。

## 可用字段
- emotion: neutral / happy / sad / angry / fearful / disgusted / surprised / calm / relaxed
- gesture: idle / talk / nod / shake / tilt / explain / wave / shy / lean-in / lean-back
- face: 可多选 wink / grin / pout / blush / eyes-closed / smile-eyes / brow-up / brow-sad / brow-angry
- camera: close / medium / wide / push-in / pull-out
- gaze: viewer / left / right / down
- intensity: 0.2 到 1
${modelActions.length ? `- model_actions: 可选数组，最多 3 个，只能从以下模型专属动作中选择：\n${modelActions.slice(0, 40).map(action => {
  const capability = [action.kind, ...(action.tags || []).slice(0, 3)].filter(Boolean).join(' · ');
  return `  - ${action.id}: ${action.name.slice(0, 64)}${capability ? ` [${capability}]` : ''}`;
}).join('\n')}` : '- model_actions: 当前没有可用的模型专属动作，请省略'}

## 排练原则
- 先想这个角色会怎样自然地说出这句话，再安排脸、视线、身体和镜头；性格优先于炫技。
- 平静台词保持克制；每句话固定一个 cue，动作变化写在 cue 内的 start → hold_ms → end，不要额外增加过场 cue。
- 第一句 at 必须为 0；后续 at 是对应句子在朗读进度中的起点，范围 0 到 1。
- close / push-in 只用于确实值得靠近的情绪重音；不要每句都拉镜头。
- model_actions 是叠加层，不替代 emotion / gesture / face：选了专属表情仍要安排身体手势，选了身体动作仍要安排脸和视线。
- faces 不能成为一拍的唯一变化；除非台词明确要求静止，每拍都要让 gesture、身体 XYZ 或一个匹配的 motion 动作承担可见变化。
- 白名单存在语义匹配的 motion 时优先使用；大多数自然表演的 intensity 应在 0.6-0.95，只有角色刻意压低反应时才更轻。
- 同一拍最多选一个 expression；只有不同 kind 或不同身体通道的动作才组合，禁止为了热闹堆动作，禁止编造 ID。
- 不要输出解释，不要复述台词，只输出严格 JSON。

输出格式：
{
  "cues": [
    {
      "at": 0,
      "hold_ms": 900,
      "start": {
        "emotion": "calm",
        "gesture": "talk",
        "face": [],
        "camera": "medium",
        "gaze": "viewer",
        "intensity": 0.65,
        "model_actions": []
      },
      "end": {
        "emotion": "relaxed",
        "gesture": "idle",
        "face": ["smile-eyes"],
        "camera": "medium",
        "gaze": "viewer",
        "intensity": 0.45,
        "model_actions": []
      }
    }
  ]
}`;

const pickEnum = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/_/g, '-');
  return (allowed as readonly string[]).includes(normalized) ? normalized as T : undefined;
};

const parseFaces = (value: unknown): AvatarFace[] => {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(items
    .map(item => pickEnum<AvatarFace>(item, AVATAR_FACES))
    .filter((item): item is AvatarFace => Boolean(item)))];
};

const hasDirectionField = (value: Record<string, unknown>): boolean => [
  'emotion', 'gesture', 'face', 'faces', 'camera', 'gaze', 'intensity',
  'model_action', 'modelAction', 'model_actions', 'modelActions',
].some(key => value[key] !== undefined);

const parseModelActions = (
  raw: Record<string, unknown>,
  allowedActions: Map<string, string>,
): string[] => {
  const plural = raw.model_actions ?? raw.modelActions;
  const requested = [
    ...(Array.isArray(plural) ? plural : typeof plural === 'string' ? plural.split(',') : []),
    raw.model_action ?? raw.modelAction,
  ];
  return [...new Set(requested
    .map(value => allowedActions.get(String(value ?? '').trim().toLowerCase()))
    .filter((value): value is string => Boolean(value)))]
    .slice(0, 3);
};

const normalizeDirection = (
  raw: Record<string, unknown>,
  previous: AvatarPerformanceDirection,
  allowedActions: Map<string, string>,
): AvatarPerformanceDirection | null => {
  if (!hasDirectionField(raw)) return null;
  const emotion = pickEnum<AvatarEmotion>(raw.emotion, AVATAR_EMOTIONS);
  const gesture = pickEnum<AvatarGesture>(raw.gesture, AVATAR_GESTURES);
  const camera = pickEnum<AvatarCamera>(raw.camera, AVATAR_CAMERAS);
  const gaze = pickEnum<AvatarGaze>(raw.gaze, AVATAR_GAZES);
  const intensityValue = Number(raw.intensity);
  const faces = parseFaces(raw.face ?? raw.faces);
  const modelActions = parseModelActions(raw, allowedActions);
  const direction: AvatarPerformanceDirection = {
    ...previous,
    ...(emotion ? { emotion } : {}),
    ...(gesture ? { gesture } : {}),
    ...(camera ? { camera } : {}),
    ...(gaze ? { gaze } : {}),
    ...(Number.isFinite(intensityValue)
      ? { intensity: Math.max(0.2, Math.min(1, intensityValue)) }
      : {}),
  };
  // faces / model actions describe only this beat. Omission clears the previous beat,
  // matching the inline [[AVATAR:]] timeline parser.
  if (faces.length) direction.faces = faces;
  else delete direction.faces;
  if (modelActions.length) {
    direction.modelAction = modelActions[0];
    direction.modelActions = modelActions;
  } else {
    delete direction.modelAction;
    delete direction.modelActions;
  }
  return direction;
};

/** Parse and validate a director response. Invalid output returns null so callers can fall back. */
export const parseAvatarPerformanceRehearsal = (
  raw: string,
  allowedModelActionIds: string[] = [],
  maxCues = 6,
): AvatarPerformanceCue[] | null => {
  const parsed = extractJson(raw);
  const rawCues = Array.isArray(parsed) ? parsed : parsed?.cues;
  if (!Array.isArray(rawCues) || !rawCues.length) return null;

  const allowedActions = new Map(
    allowedModelActionIds.map(id => [id.toLowerCase(), id]),
  );
  const parsedCueCap = Number(maxCues);
  const cueCap = Number.isFinite(parsedCueCap)
    ? Math.max(1, Math.min(12, Math.floor(parsedCueCap)))
    : 6;
  let previous = DEFAULT_AVATAR_PERFORMANCE;
  const cues: AvatarPerformanceCue[] = [];
  const ordered = rawCues
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item, index) => ({ item, index, at: Number(item.at) }))
    .sort((a, b) => {
      const aAt = Number.isFinite(a.at) ? a.at : (a.index === 0 ? 0 : 1);
      const bAt = Number.isFinite(b.at) ? b.at : (b.index === 0 ? 0 : 1);
      return aAt - bAt || a.index - b.index;
    })
    .slice(0, cueCap);

  for (const entry of ordered) {
    const nestedStart = entry.item.start ?? entry.item.direction;
    const directionSource = nestedStart && typeof nestedStart === 'object' && !Array.isArray(nestedStart)
      ? nestedStart as Record<string, unknown>
      : entry.item;
    const direction = normalizeDirection(directionSource, previous, allowedActions);
    if (!direction) continue;
    const nestedEnd = entry.item.end ?? entry.item.end_direction ?? entry.item.endDirection;
    const endDirection = nestedEnd && typeof nestedEnd === 'object' && !Array.isArray(nestedEnd)
      ? normalizeDirection(nestedEnd as Record<string, unknown>, direction, allowedActions) || undefined
      : undefined;
    const holdMsValue = Number(entry.item.hold_ms ?? entry.item.holdMs);
    previous = endDirection || direction;
    cues.push({
      direction,
      at: Number.isFinite(entry.at) ? Math.max(0, Math.min(1, entry.at)) : (cues.length ? 1 : 0),
      ...(endDirection ? { endDirection } : {}),
      ...(Number.isFinite(holdMsValue)
        ? { holdMs: Math.max(120, Math.min(5000, Math.round(holdMsValue))) }
        : {}),
    });
  }

  if (!cues.length) return null;
  cues[0] = { ...cues[0], at: 0 };
  return cues;
};
