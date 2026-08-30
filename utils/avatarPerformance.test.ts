import { describe, expect, it } from 'vitest';
import {
  buildAvatarPerformancePrompt,
  extractAvatarPerformance,
  extractAvatarPerformanceTimeline,
  expandAvatarPerformanceCueBeats,
  inferAvatarPerformanceTimelineFromText,
} from './avatarPerformance';

describe('extractAvatarPerformance', () => {
  it('解析基础字段并从台词里剥掉指令行', () => {
    const { text, direction } = extractAvatarPerformance(
      '[[AVATAR: emotion=happy; gesture=nod; camera=push-in; gaze=viewer; intensity=0.8]]\n好耶！',
    );
    expect(text).toBe('好耶！');
    expect(direction).toMatchObject({ emotion: 'happy', gesture: 'nod', camera: 'push-in', intensity: 0.8 });
  });

  it('face 多值组合：生气 + 咧嘴 + wink', () => {
    const { direction } = extractAvatarPerformance(
      '[[AVATAR: emotion=angry; face=grin,wink; gesture=shake; intensity=0.95]]\n你说什么？！',
    );
    expect(direction?.emotion).toBe('angry');
    expect(direction?.faces).toEqual(expect.arrayContaining(['grin', 'wink']));
    expect(direction?.faces).toHaveLength(2);
  });

  it('face 别名归一化 + 去重 + 丢弃非法值', () => {
    const { direction } = extractAvatarPerformance(
      '[[AVATAR: face=smirk,winking,wink,invalid-face,blush]]\n嘿嘿。',
    );
    expect(direction?.faces).toEqual(expect.arrayContaining(['grin', 'wink', 'blush']));
    expect(direction?.faces).toHaveLength(3);
  });

  it('lean-in / lean-back 手势（含下划线与别名写法）', () => {
    expect(extractAvatarPerformance('[[AVATAR: gesture=lean_in]]x').direction?.gesture).toBe('lean-in');
    expect(extractAvatarPerformance('[[AVATAR: gesture=leanback]]x').direction?.gesture).toBe('lean-back');
    expect(extractAvatarPerformance('[[AVATAR: gesture=closer]]x').direction?.gesture).toBe('lean-in');
  });

  it('没有指令时 direction 为空、文本原样保留', () => {
    const { text, direction } = extractAvatarPerformance('就是普通一句话');
    expect(text).toBe('就是普通一句话');
    expect(direction).toBeUndefined();
  });
});

describe('extractAvatarPerformanceTimeline', () => {
  it('多条指令按位置生成时间轴，后一条继承前一条', () => {
    const raw = '[[AVATAR: emotion=calm; gesture=talk]]\n唔……我本来是想拒绝的。\n[[AVATAR: emotion=happy; face=grin; intensity=0.9]]\n但看在奶茶的份上——成交！';
    const { text, cues } = extractAvatarPerformanceTimeline(raw);
    expect(text).toBe('唔……我本来是想拒绝的。\n但看在奶茶的份上——成交！');
    expect(cues).toHaveLength(2);
    expect(cues[0].at).toBe(0);
    expect(cues[0].direction.emotion).toBe('calm');
    expect(cues[1].at).toBeGreaterThan(0.3);
    expect(cues[1].at).toBeLessThan(0.8);
    expect(cues[1].direction.emotion).toBe('happy');
    // gesture 从上一条继承
    expect(cues[1].direction.gesture).toBe('talk');
    expect(cues[1].direction.faces).toEqual(['grin']);
  });

  it('faces 不跨指令继承：下一条没写 face 就清掉', () => {
    const raw = '[[AVATAR: emotion=happy; face=wink]]\n嘿嘿。\n[[AVATAR: emotion=sad]]\n……不过算了。';
    const { cues } = extractAvatarPerformanceTimeline(raw);
    expect(cues[0].direction.faces).toEqual(['wink']);
    expect(cues[1].direction.faces).toBeUndefined();
  });

  it('没有指令时 cues 为空、正文原样', () => {
    const { text, cues } = extractAvatarPerformanceTimeline('平平无奇的一句话');
    expect(text).toBe('平平无奇的一句话');
    expect(cues).toHaveLength(0);
  });
});

describe('buildAvatarPerformancePrompt', () => {
  it('包含可组合字段说明与允许的模型动作列表', () => {
    const prompt = buildAvatarPerformancePrompt([{ id: 'custom-params-abc', name: '坏笑wink' }]);
    expect(prompt).toContain('face:');
    expect(prompt).toContain('lean-in');
    expect(prompt).toContain('custom-params-abc');
    expect(prompt).toContain('坏笑wink');
  });
});

describe('inferAvatarPerformanceTimelineFromText', () => {
  it('turns a semantic reversal into multiple local performance beats', () => {
    const cues = inferAvatarPerformanceTimelineFromText('嗯，我本来想拒绝。不过你真的太可爱了，我很喜欢！');

    expect(cues.length).toBeGreaterThanOrEqual(2);
    expect(cues.length).toBeLessThanOrEqual(3);
    expect(cues[0].at).toBe(0);
    expect(cues.at(-1)?.at).toBeGreaterThan(0.2);
    expect(cues.at(-1)?.direction.emotion).toBe('happy');
  });

  it('keeps a neutral line restrained instead of manufacturing busy motion', () => {
    const cues = inferAvatarPerformanceTimelineFromText('我知道了，晚点再说。');

    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ at: 0, direction: { gesture: 'talk', camera: 'medium' } });
  });

  it('caps long locally inferred timelines at three chronological beats', () => {
    const cues = inferAvatarPerformanceTimelineFromText('你好！真的吗？不过我有点难过。可是现在又很开心，我喜欢你！');

    expect(cues).toHaveLength(3);
    expect(cues.map(cue => cue.at)).toEqual([...cues.map(cue => cue.at)].sort((a, b) => a - b));
  });
});

describe('expandAvatarPerformanceCueBeats', () => {
  it('schedules a start, held middle, and closing action for every authored sentence cue', () => {
    const beats = expandAvatarPerformanceCueBeats([
      {
        at: 0,
        direction: { emotion: 'calm', gesture: 'talk', camera: 'medium', gaze: 'viewer', intensity: 0.6 },
        holdMs: 900,
        endDirection: { emotion: 'relaxed', gesture: 'idle', camera: 'medium', gaze: 'viewer', intensity: 0.4 },
      },
      {
        at: 0.5,
        direction: { emotion: 'happy', gesture: 'wave', camera: 'medium', gaze: 'viewer', intensity: 0.7 },
      },
    ], 4000);

    expect(beats.map(beat => [beat.phase, beat.delayMs])).toEqual([
      ['start', 0],
      ['end', 900],
      ['start', 2000],
    ]);
    expect(beats[1].direction.gesture).toBe('idle');
  });

  it('keeps legacy start-only cues unchanged', () => {
    const beats = expandAvatarPerformanceCueBeats([
      { at: 0, direction: { emotion: 'calm', gesture: 'talk', camera: 'medium', gaze: 'viewer', intensity: 0.6 } },
    ], 2000);
    expect(beats).toHaveLength(1);
    expect(beats[0].phase).toBe('start');
  });

  it('sanitizes corrupt timing data, restores chronological order, and caps timer fan-out', () => {
    const direction = { emotion: 'calm', gesture: 'talk', camera: 'medium', gaze: 'viewer', intensity: 0.6 } as const;
    const closing = { ...direction, gesture: 'idle' as const };
    const beats = expandAvatarPerformanceCueBeats([
      { at: Number.NaN, direction },
      { at: 0.2, direction, endDirection: closing, holdMs: Number.POSITIVE_INFINITY },
      { at: -4, direction },
      ...Array.from({ length: 80 }, (_, index) => ({ at: (index + 1) / 100, direction })),
    ], Number.POSITIVE_INFINITY);

    expect(beats.every(beat => Number.isFinite(beat.delayMs) && beat.delayMs >= 0)).toBe(true);
    expect(beats.map(beat => beat.delayMs)).toEqual([...beats.map(beat => beat.delayMs)].sort((a, b) => a - b));
    expect(beats.filter(beat => beat.phase === 'start')).toHaveLength(64);
  });

  it('lets the next sentence opening win when it shares a boundary with the prior closing pose', () => {
    const direction = { emotion: 'calm', gesture: 'talk', camera: 'medium', gaze: 'viewer', intensity: 0.6 } as const;
    const beats = expandAvatarPerformanceCueBeats([
      { at: 0, direction, endDirection: { ...direction, gesture: 'idle' }, holdMs: 5000 },
      { at: 0.02, direction: { ...direction, gesture: 'wave' } },
    ], 4000);

    expect(beats.slice(-2).map(beat => beat.phase)).toEqual(['end', 'start']);
    expect(beats.slice(-1)[0].direction.gesture).toBe('wave');
  });
});
