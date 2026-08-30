export const AVATAR_EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'relaxed'] as const;
export const AVATAR_GESTURES = ['idle', 'talk', 'nod', 'shake', 'tilt', 'explain', 'wave', 'shy', 'lean-in', 'lean-back'] as const;
export const AVATAR_CAMERAS = ['close', 'medium', 'wide', 'push-in', 'pull-out'] as const;
export const AVATAR_GAZES = ['viewer', 'left', 'right', 'down'] as const;
/** 可叠加在任意情绪/手势之上的微表情：生气也可以咧嘴、wink 可以配任何脸。 */
export const AVATAR_FACES = [
  'wink', 'grin', 'pout', 'blush', 'eyes-closed',
  'smile-eyes', 'brow-up', 'brow-sad', 'brow-angry',
] as const;

export type AvatarEmotion = typeof AVATAR_EMOTIONS[number];
export type AvatarGesture = typeof AVATAR_GESTURES[number];
export type AvatarCamera = typeof AVATAR_CAMERAS[number];
export type AvatarGaze = typeof AVATAR_GAZES[number];
export type AvatarFace = typeof AVATAR_FACES[number];

export interface AvatarPerformancePrecision {
  lockAutonomy?: boolean;
  /** Prevent gesture/emotion overlays from changing the authored head angles. */
  lockHead?: boolean;
  headX?: number;
  headY?: number;
  headZ?: number;
  eyeX?: number;
  eyeY?: number;
  bodyX?: number;
  bodyY?: number;
  bodyZ?: number;
  overshoot?: number;
  settleMs?: number;
}
export interface AvatarPerformanceDirection {
  emotion: AvatarEmotion;
  gesture: AvatarGesture;
  camera: AvatarCamera;
  gaze: AvatarGaze;
  intensity: number;
  /** 微表情叠加层，可多选（如 angry + grin + wink）。 */
  faces?: AvatarFace[];
  /** Live2D 模型专属动作 ID；舞台仍会再次检查角色的 AI 白名单。 */
  modelAction?: string;
  /**
   * 高质量导演可同时选择的模型专属动作层。首项也会写入 modelAction，
   * 兼容只支持单个自定义表情的 VRM 和旧版演出记录。
   */
  modelActions?: string[];
  /** Authored startup pose that temporarily replaces ambient autonomy. */
  precision?: AvatarPerformancePrecision;
}

export const DEFAULT_AVATAR_PERFORMANCE: AvatarPerformanceDirection = {
  emotion: 'calm',
  gesture: 'talk',
  camera: 'medium',
  gaze: 'viewer',
  intensity: 0.7,
};

/** 用户在舞台上校准的构图。offset 是相对画布宽/高的比例，VRM 与 Live2D 共用。 */
export interface AvatarStageFraming {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export const DEFAULT_STAGE_FRAMING: AvatarStageFraming = { scale: 1, offsetX: 0, offsetY: 0 };

/** Percentage insets used to mask the companion avatar without changing its pose. */
export interface AvatarStageCrop {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const DEFAULT_STAGE_CROP: AvatarStageCrop = { top: 0, right: 0, bottom: 0, left: 0 };

export const clampStageCrop = (crop: AvatarStageCrop): AvatarStageCrop => {
  const clampInset = (value: number) => Math.max(0, Math.min(0.42, Number.isFinite(value) ? value : 0));
  let top = clampInset(crop.top);
  let right = clampInset(crop.right);
  let bottom = clampInset(crop.bottom);
  let left = clampInset(crop.left);
  const vertical = top + bottom;
  const horizontal = left + right;
  if (vertical > 0.78) {
    const ratio = 0.78 / vertical;
    top *= ratio;
    bottom *= ratio;
  }
  if (horizontal > 0.78) {
    const ratio = 0.78 / horizontal;
    left *= ratio;
    right *= ratio;
  }
  return { top, right, bottom, left };
};

export const clampStageFraming = (
  framing: AvatarStageFraming,
  limits: { scale: [number, number]; offsetX: [number, number]; offsetY: [number, number] },
): AvatarStageFraming => ({
  scale: Math.max(limits.scale[0], Math.min(limits.scale[1], framing.scale)),
  offsetX: Math.max(limits.offsetX[0], Math.min(limits.offsetX[1], framing.offsetX)),
  offsetY: Math.max(limits.offsetY[0], Math.min(limits.offsetY[1], framing.offsetY)),
});

const DIRECTIVE_RE = /\[\[\s*(?:AVATAR|PERFORMANCE|表演|演出)\s*:\s*([^\]]{0,320})\]\]/gi;

const EMOTION_ALIASES: Record<string, AvatarEmotion> = {
  fun: 'happy', joy: 'happy', pleased: 'happy',
  sorrow: 'sad', upset: 'sad',
  fear: 'fearful', scared: 'fearful',
  disgust: 'disgusted',
  surprise: 'surprised',
  fluent: 'calm', relax: 'relaxed',
};
const GESTURE_ALIASES: Record<string, AvatarGesture> = {
  none: 'idle', neutral: 'idle', talking: 'talk',
  agree: 'nod', yes: 'nod', disagree: 'shake', no: 'shake',
  headtilt: 'tilt', 'head-tilt': 'tilt', explainboth: 'explain',
  greeting: 'wave', bashful: 'shy',
  leanin: 'lean-in', forward: 'lean-in', closer: 'lean-in',
  leanback: 'lean-back', back: 'lean-back', backward: 'lean-back', recline: 'lean-back',
};
const FACE_ALIASES: Record<string, AvatarFace> = {
  'wink-l': 'wink', 'wink-r': 'wink', winking: 'wink',
  smirk: 'grin', 'open-smile': 'grin', teeth: 'grin',
  sulk: 'pout', 'pouty': 'pout',
  shy: 'blush', flush: 'blush', embarrassed: 'blush',
  'eyes-close': 'eyes-closed', eyesclosed: 'eyes-closed', 'close-eyes': 'eyes-closed',
  squint: 'smile-eyes', 'smiling-eyes': 'smile-eyes', smileeyes: 'smile-eyes', 'happy-eyes': 'smile-eyes',
  'raise-brow': 'brow-up', 'raised-brow': 'brow-up', browup: 'brow-up',
  'sad-brow': 'brow-sad', worried: 'brow-sad', 'worried-brow': 'brow-sad',
  frown: 'brow-angry', 'angry-brow': 'brow-angry', glare: 'brow-angry',
};
const CAMERA_ALIASES: Record<string, AvatarCamera> = {
  closeup: 'close', 'close-up': 'close', portrait: 'close',
  mid: 'medium', normal: 'medium',
  full: 'wide', long: 'wide',
  pushin: 'push-in', zoomin: 'push-in',
  pullout: 'pull-out', zoomout: 'pull-out',
};
const GAZE_ALIASES: Record<string, AvatarGaze> = {
  camera: 'viewer', user: 'viewer', center: 'viewer', front: 'viewer',
  'away-left': 'left', awayleft: 'left',
  'away-right': 'right', awayright: 'right',
  lower: 'down', shy: 'down',
};

const normalizeEnum = <T extends string>(value: string, allowed: readonly T[], aliases: Record<string, T>): T | undefined => {
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if ((allowed as readonly string[]).includes(normalized)) return normalized as T;
  return aliases[normalized] || aliases[normalized.replace(/-/g, '')];
};

export const normalizeAvatarEmotion = (value?: string): AvatarEmotion => (
  normalizeEnum(value || '', AVATAR_EMOTIONS, EMOTION_ALIASES) || DEFAULT_AVATAR_PERFORMANCE.emotion
);

export const resolveAvatarPerformance = (
  direction?: AvatarPerformanceDirection,
  fallbackEmotion?: string,
): AvatarPerformanceDirection => ({
  ...DEFAULT_AVATAR_PERFORMANCE,
  ...(direction || {}),
  emotion: direction?.emotion || normalizeAvatarEmotion(fallbackEmotion),
});

export const inferAvatarPerformanceFromText = (text: string): AvatarPerformanceDirection => {
  const value = (text || '').replace(/<[^>]+>/g, ' ').trim();
  if (/(?:^|[，。！？\s])(喂|嗨|哈喽|你好|早安|晚上好)|\b(?:hello|hey|hi)\b/i.test(value)) {
    return { emotion: 'happy', gesture: 'wave', camera: 'medium', gaze: 'viewer', intensity: 0.78 };
  }
  if (/哈哈|笑死|好耶|太好|开心|高兴|喜欢|爱你|可爱|\b(?:haha|great|love)\b/i.test(value)) {
    return { emotion: 'happy', gesture: 'nod', camera: 'push-in', gaze: 'viewer', intensity: 0.82 };
  }
  if (/难过|伤心|委屈|失落|对不起|抱歉|唉|\b(?:sad|sorry)\b/i.test(value)) {
    return { emotion: 'sad', gesture: 'shy', camera: 'pull-out', gaze: 'down', intensity: 0.68 };
  }
  if (/生气|气死|讨厌|不许|不行|别这样|\b(?:angry|mad|stop)\b/i.test(value)) {
    return { emotion: 'angry', gesture: 'shake', camera: 'close', gaze: 'viewer', intensity: 0.82 };
  }
  if (/啊[？！?]|什么[？！?]|真的[？！?]|居然|没想到|天哪|\b(?:wow|really|what)\b/i.test(value)) {
    return { emotion: 'surprised', gesture: 'tilt', camera: 'push-in', gaze: 'viewer', intensity: 0.86 };
  }
  if (/^(?:嗯|对|好|可以|当然|没错)(?:[，。！\s]|$)|\b(?:yes|okay|sure)\b/i.test(value)) {
    return { emotion: 'calm', gesture: 'nod', camera: 'medium', gaze: 'viewer', intensity: 0.62 };
  }
  if (/[？?]$/.test(value)) {
    return { emotion: 'calm', gesture: 'tilt', camera: 'medium', gaze: 'viewer', intensity: 0.58 };
  }
  return DEFAULT_AVATAR_PERFORMANCE;
};

interface LocalPerformanceClause {
  text: string;
  start: number;
}

const splitLocalPerformanceClauses = (rawText: string): LocalPerformanceClause[] => {
  // Voice/translation markup is not part of the spoken semantics. Replacing tags
  // with spaces keeps offsets approximately aligned with the displayed line.
  const text = (rawText || '').replace(/<[^>]+>/g, match => ' '.repeat(match.length));
  const sentenceRanges: Array<{ start: number; end: number }> = [];
  let start = 0;
  const pushRange = (end: number) => {
    if (end > start) sentenceRanges.push({ start, end });
    start = end;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const hardStop = /[。！？!?；;\n]/.test(char);
    const ellipsisStop = char === '…' && text[index + 1] === '…';
    const dashStop = char === '—' && text[index + 1] === '—';
    if (!hardStop && !ellipsisStop && !dashStop) continue;
    let end = index + 1;
    while (end < text.length && /[。！？!?；;\n…—]/.test(text[end])) end += 1;
    pushRange(end);
    index = end - 1;
  }
  pushRange(text.length);

  const clauses: LocalPerformanceClause[] = [];
  const transitionRe = /但是|不过|可是|然而|其实|只是|所以|然后|结果|却/g;
  for (const range of sentenceRanges) {
    const sentence = text.slice(range.start, range.end);
    const cuts = [0];
    transitionRe.lastIndex = 0;
    let marker: RegExpExecArray | null;
    while ((marker = transitionRe.exec(sentence)) !== null) {
      // A transition at the beginning belongs to this clause; only mid-sentence
      // markers create a new beat.
      if (marker.index > 1) cuts.push(marker.index);
    }
    cuts.push(sentence.length);
    for (let index = 0; index < cuts.length - 1; index += 1) {
      const localStart = cuts[index];
      const localEnd = cuts[index + 1];
      const chunk = sentence.slice(localStart, localEnd);
      const leading = chunk.search(/\S/);
      if (leading < 0) continue;
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      clauses.push({ text: trimmed, start: range.start + localStart + leading });
    }
  }
  return clauses;
};

const localDirectionSignature = (direction: AvatarPerformanceDirection): string => [
  direction.emotion,
  direction.gesture,
  direction.camera,
  direction.gaze,
  direction.intensity.toFixed(2),
].join('|');

const localCueSalience = (cue: AvatarPerformanceCue, clauseText: string): number => {
  const direction = cue.direction;
  return (direction.emotion !== DEFAULT_AVATAR_PERFORMANCE.emotion ? 3 : 0)
    + (direction.gesture !== DEFAULT_AVATAR_PERFORMANCE.gesture ? 2 : 0)
    + (direction.camera !== DEFAULT_AVATAR_PERFORMANCE.camera ? 1 : 0)
    + (/[！？!?]/.test(clauseText) ? 0.5 : 0)
    + direction.intensity;
};

/**
 * Zero-API local rehearsal fallback. It turns punctuation and semantic turns into
 * a compact 1–3 beat timeline, so a basic call still changes pose even when the
 * main model emits no (or only one) [[AVATAR:]] instruction.
 */
export const inferAvatarPerformanceTimelineFromText = (text: string): AvatarPerformanceCue[] => {
  const clauses = splitLocalPerformanceClauses(text);
  if (!clauses.length) return [{ direction: DEFAULT_AVATAR_PERFORMANCE, at: 0 }];
  const total = Math.max(1, text.length);
  const candidates: Array<AvatarPerformanceCue & { score: number; clauseText: string }> = [];
  let previousSignature = '';
  for (const clause of clauses) {
    const direction = inferAvatarPerformanceFromText(clause.text);
    const signature = localDirectionSignature(direction);
    if (signature === previousSignature) continue;
    previousSignature = signature;
    const cue: AvatarPerformanceCue = {
      direction,
      at: candidates.length ? Math.max(0, Math.min(0.96, clause.start / total)) : 0,
    };
    candidates.push({ ...cue, score: localCueSalience(cue, clause.text), clauseText: clause.text });
  }
  if (!candidates.length) return [{ direction: DEFAULT_AVATAR_PERFORMANCE, at: 0 }];
  if (candidates.length <= 3) return candidates.map(({ direction, at }) => ({ direction, at }));

  // Always keep the opening pose. For a long reply retain the two most expressive
  // later turns, then restore chronological order.
  const selected = [
    candidates[0],
    ...candidates.slice(1).sort((a, b) => b.score - a.score || a.at - b.at).slice(0, 2),
  ].sort((a, b) => a.at - b.at);
  return selected.map(({ direction, at }) => ({ direction, at }));
};

const parseDirectiveBody = (body: string, base: AvatarPerformanceDirection): AvatarPerformanceDirection => {
  const values: Record<string, string> = {};
  // 值字符集包含逗号：face=wink,grin 这类多值字段需要整段捕获。
  const pairRe = /([a-z_]+)\s*=\s*["']?([a-z0-9_,.-]+)["']?/gi;
  let pair: RegExpExecArray | null;
  while ((pair = pairRe.exec(body)) !== null) values[pair[1].toLowerCase()] = pair[2];

  const emotion = normalizeEnum(values.emotion || values.expression || '', AVATAR_EMOTIONS, EMOTION_ALIASES);
  const gesture = normalizeEnum(values.gesture || values.action || '', AVATAR_GESTURES, GESTURE_ALIASES);
  const camera = normalizeEnum(values.camera || values.shot || '', AVATAR_CAMERAS, CAMERA_ALIASES);
  const gaze = normalizeEnum(values.gaze || values.look || '', AVATAR_GAZES, GAZE_ALIASES);
  const faces = [...new Set(
    (values.face || values.faces || '')
      .split(',')
      .map(item => normalizeEnum(item, AVATAR_FACES, FACE_ALIASES))
      .filter((item): item is AvatarFace => Boolean(item)),
  )];
  const parsedIntensity = Number.parseFloat(values.intensity || values.energy || '');
  const direction: AvatarPerformanceDirection = {
    ...base,
    ...(emotion ? { emotion } : {}),
    ...(gesture ? { gesture } : {}),
    ...(camera ? { camera } : {}),
    ...(gaze ? { gaze } : {}),
    ...(Number.isFinite(parsedIntensity) ? { intensity: Math.max(0.2, Math.min(1, parsedIntensity)) } : {}),
    ...((values.model_action || values.modelaction || values.action_id)
      ? { modelAction: values.model_action || values.modelaction || values.action_id }
      : {}),
  };
  // faces / modelAction 是"这一拍"的瞬时表达，不从上一条指令继承——
  // 没写就清掉，避免一个 wink 从头挂到尾。
  if (faces.length) direction.faces = faces;
  else delete direction.faces;
  if (!(values.model_action || values.modelaction || values.action_id)) delete direction.modelAction;
  return direction;
};

/** 一条演出指令 + 它在正文中的位置（0..1，用于按语音进度调度）。 */
export interface AvatarPerformanceCue {
  direction: AvatarPerformanceDirection;
  at: number;
  /** Optional closing pose for this sentence. Old cue data omits it and remains start-only. */
  endDirection?: AvatarPerformanceDirection;
  /** Milliseconds to keep the opening pose before the closing pose begins. */
  holdMs?: number;
}

export interface AvatarPerformanceBeat {
  direction: AvatarPerformanceDirection;
  delayMs: number;
  cueIndex: number;
  phase: 'start' | 'end';
}

/** Expand sentence cues into concrete start/end timers against the real voice duration. */
export const expandAvatarPerformanceCueBeats = (
  cues: readonly AvatarPerformanceCue[],
  durationMs: number,
): AvatarPerformanceBeat[] => {
  const parsedDuration = Number(durationMs);
  // Persisted rehearsal data can outlive several schema versions. Never let a
  // damaged duration/cue pack create NaN timers or an unbounded timer storm.
  const duration = Number.isFinite(parsedDuration)
    ? Math.max(1, Math.min(3_600_000, parsedDuration))
    : 1;
  const orderedCues = cues
    .slice(0, 64)
    .map((cue, sourceIndex) => {
      const rawAt = Number(cue?.at);
      return {
        cue,
        sourceIndex,
        at: Number.isFinite(rawAt) ? Math.max(0, Math.min(1, rawAt)) : (sourceIndex === 0 ? 0 : 1),
      };
    })
    .filter((entry): entry is typeof entry & { cue: AvatarPerformanceCue } => (
      Boolean(entry.cue?.direction && typeof entry.cue.direction === 'object')
    ))
    .sort((a, b) => a.at - b.at || a.sourceIndex - b.sourceIndex);
  const beats: AvatarPerformanceBeat[] = [];
  orderedCues.forEach((entry, cueIndex) => {
    const { cue } = entry;
    const startDelay = Math.round(entry.at * duration);
    beats.push({ direction: cue.direction, delayMs: startDelay, cueIndex, phase: 'start' });
    if (!cue.endDirection || typeof cue.endDirection !== 'object') return;
    const nextAt = orderedCues[cueIndex + 1]?.at ?? 1;
    const nextDelay = Math.round(Math.max(entry.at, nextAt) * duration);
    const available = Math.max(0, nextDelay - startDelay);
    if (available < 80) return;
    const fallbackHold = Math.round(available * 0.72);
    const parsedHold = Number(cue.holdMs);
    const requestedHold = Number.isFinite(parsedHold) ? parsedHold : fallbackHold;
    const hold = Math.min(Math.max(80, requestedHold), Math.max(80, available - 60));
    beats.push({
      direction: cue.endDirection,
      delayMs: Math.min(duration, startDelay + hold),
      cueIndex,
      phase: 'end',
    });
  });
  // At a sentence boundary the previous closing pose runs first, then the next
  // opening pose wins. Stable cue ordering also avoids comparator ambiguity.
  return beats.sort((a, b) => (
    a.delayMs - b.delayMs
    || (a.phase === b.phase ? a.cueIndex - b.cueIndex : (a.phase === 'end' ? -1 : 1))
  ));
};

/**
 * 演出时间轴：正文中可以穿插多条 [[AVATAR:]] 指令，每条从它所在位置开始生效。
 * 后一条继承前一条的 emotion/gesture/camera 等（只写变化的字段也能用）。
 */
export const extractAvatarPerformanceTimeline = (raw: string): { text: string; cues: AvatarPerformanceCue[] } => {
  const source = raw || '';
  const pending: Array<{ direction: AvatarPerformanceDirection; cleanedAt: number }> = [];
  let cleaned = '';
  let lastEnd = 0;
  let previous = DEFAULT_AVATAR_PERFORMANCE;
  DIRECTIVE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DIRECTIVE_RE.exec(source)) !== null) {
    cleaned += source.slice(lastEnd, match.index);
    previous = parseDirectiveBody(match[1], previous);
    pending.push({ direction: previous, cleanedAt: cleaned.replace(/\s+$/, '').length });
    lastEnd = match.index + match[0].length;
    // 指令独占一行时把它后面的换行一并吃掉，正文不留空行
    if (source[lastEnd] === '\r') lastEnd += 1;
    if (source[lastEnd] === '\n') lastEnd += 1;
  }
  cleaned += source.slice(lastEnd);
  const text = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  const total = Math.max(1, text.length);
  return {
    text,
    cues: pending.map(item => ({
      direction: item.direction,
      at: Math.max(0, Math.min(1, item.cleanedAt / total)),
    })),
  };
};

export const extractAvatarPerformance = (raw: string): { text: string; direction?: AvatarPerformanceDirection } => {
  const { text, cues } = extractAvatarPerformanceTimeline(raw);
  return { text, direction: cues.length ? cues[cues.length - 1].direction : undefined };
};

export const buildAvatarPerformancePrompt = (modelActions: Array<{ id: string; name: string }> = []): string => `### 这是视频通话——对方能看见你

你有一副真实的身体（VRM/Live2D 形象）出现在对方屏幕上。你说话时的表情、小动作、和镜头的距离，对方全都看在眼里。**身体语言是你台词的一部分，不是附加任务。**

每条回复的第一行放一条演出指令（它不会显示、不会被朗读，之后再写你说出口的话）：

[[AVATAR: emotion=happy; gesture=nod; camera=push-in; gaze=viewer; intensity=0.7]]

字段取值（只能从这些里选）：
- emotion: neutral / happy / sad / angry / fearful / disgusted / surprised / calm / relaxed
- gesture: idle / talk / nod / shake / tilt / explain / wave / shy / lean-in（前倾凑近）/ lean-back（后仰靠回去）
- face: 可选的微表情叠加层，逗号分隔可多选：wink / grin（咧嘴）/ pout（撅嘴）/ blush（脸红）/ eyes-closed / smile-eyes（眯眯笑眼）/ brow-up（挑眉）/ brow-sad（八字眉委屈）/ brow-angry（皱眉瞪）
- camera: close / medium / wide / push-in / pull-out
- gaze: viewer / left / right / down
- intensity: 0.2 到 1（同时控制情绪浓度和动作幅度：0.9 的 nod 是大幅度点头，0.4 只是轻轻颔首）
${modelActions.length ? `- model_action: 可选；这个模型有一些专属动作/表情，用户允许你使用的有：\n${modelActions.slice(0, 40).map(action => `  - ${action.id}: ${action.name.slice(0, 48)}`).join('\n')}` : ''}

**这些字段是用来自由搭配的，不是单选题**——真人的脸和身体从来不是一次只做一件事：
- 气到想笑：emotion=angry; face=grin —— 咧着嘴的生气比板着脸生动十倍
- 得意地眨眼：emotion=happy; face=wink,grin; gesture=lean-in; intensity=0.85
- 被夸到不好意思：emotion=happy; face=blush; gesture=shy; gaze=down
- 用力否认：emotion=angry; gesture=shake; intensity=0.95 —— 大幅度摇头
- 恍然大悟往前凑：emotion=surprised; gesture=lean-in; camera=push-in
- 无语地靠回去：emotion=disgusted; gesture=lean-back; face=eyes-closed
怎么选？别想"该填什么"，想"我这句话说出口的时候，我的脸和身体在做什么"。
大部分平静的对话就是 calm + talk + medium，**不必每句都加戏**——但情绪一动，就大胆组合，你的身体不是雕塑。
${modelActions.length ? '- model_action 是你的招牌动作，台词正好对上的时候用它比通用手势更有性格；不合适就省略，禁止编造列表外的 ID。' : ''}

**指令可以放多条**：一条回复里情绪有转折时，在转折的那一段前面再插一行指令，从那句话开始生效（后一条只写变化的字段也行）。就像：

[[AVATAR: emotion=calm; gesture=talk]]
唔……这个嘛，我本来是想拒绝的。
[[AVATAR: emotion=happy; face=grin,wink; gesture=lean-in; intensity=0.85]]
但看在你请我喝奶茶的份上——成交！

铁律：第一行必须是一条指令；指令要单独占一行、放在它对应的那段话前面；不要在台词里解释这些字段的存在。`;
