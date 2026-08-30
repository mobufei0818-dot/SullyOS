import { describe, expect, it } from 'vitest';
import {
  AVATAR_PERFORMANCE_PERSONA_MAX_CHARS,
  AVATAR_PERFORMANCE_PERSONA_MAX_TOKENS,
  AVATAR_PERFORMANCE_REHEARSAL_MAX_TOKENS,
  buildAvatarPerformancePersonaPrompt,
  buildAvatarPerformanceRehearsalPrompt,
  isCompleteAvatarPerformanceCuePack,
  parseAvatarPerformancePersona,
  parseAvatarPerformanceRehearsal,
  splitAvatarPerformanceSentences,
} from './avatarPerformanceRehearsal';

describe('avatar performance rehearsal', () => {
  it('builds a one-time persona prompt from the complete ContextBuilder output', () => {
    const tail = '【角色上下文最后一行】';
    const coreContext = `${'完整设定。'.repeat(3000)}${tail}`;
    const prompt = buildAvatarPerformancePersonaPrompt({
      characterName: '小满',
      coreContext,
    });

    expect(prompt).toContain(tail);
    expect(prompt).toContain('200 个中文字符以内');
    expect(prompt).toContain('不要复述世界观、经历、当前事件、记忆细节、用户隐私');
    expect(AVATAR_PERFORMANCE_PERSONA_MAX_TOKENS).toBeGreaterThanOrEqual(512);
  });

  it('parses and hard-caps the cached performance persona', () => {
    const persona = parseAvatarPerformancePersona(JSON.stringify({
      persona: `克制地注视对方，情绪越深动作越轻。${'不抢戏。'.repeat(80)}`,
    }));

    expect(persona).toBeTruthy();
    expect(Array.from(persona || '')).toHaveLength(AVATAR_PERFORMANCE_PERSONA_MAX_CHARS);
    expect(parseAvatarPerformancePersona('表演人格：先移开视线，再很轻地靠近。')).toBe('先移开视线，再很轻地靠近。');
    expect(parseAvatarPerformancePersona('{"persona":')).toBeNull();
  });

  it('builds an isolated prompt from only persona, reply, and model capabilities', () => {
    const prompt = buildAvatarPerformanceRehearsalPrompt({
      characterName: '小满',
      personality: '嘴硬心软，表达克制。',
      reply: '你怎么才来。',
      modelActions: [{ id: 'jito-eye', name: '鄙视眼', kind: 'expression', tags: ['angry'] }],
    });

    expect(prompt).toContain('嘴硬心软，表达克制。');
    expect(prompt).toContain('你怎么才来。');
    expect(prompt).toContain('jito-eye: 鄙视眼');
    expect(prompt).toContain('expression · angry');
    expect(prompt).toContain('model_actions 是叠加层');
    expect(prompt).toContain('不要猜测此前发生过什么');
    expect(prompt).not.toContain('最近聊天');
  });

  it('keeps the complete character persona and reserves a robust director output budget', () => {
    const tail = '【不可截断的角色设定结尾】';
    const personality = `${'克制但敏锐。'.repeat(2200)}${tail}`;
    const prompt = buildAvatarPerformanceRehearsalPrompt({
      characterName: '小满',
      personality,
      reply: '嗯。',
    });

    expect(personality.length).toBeGreaterThan(12_000);
    expect(prompt).toContain(tail);
    expect(prompt).not.toContain('[内容已截断]');
    expect(AVATAR_PERFORMANCE_REHEARSAL_MAX_TOKENS).toBe(4096);
  });

  it('normalizes, orders, clamps, and inherits valid cues', () => {
    const cues = parseAvatarPerformanceRehearsal(JSON.stringify({
      cues: [
        { at: 0.75, emotion: 'happy', gesture: 'lean-in', face: ['wink', 'invalid'], camera: 'push-in', gaze: 'viewer', intensity: 2 },
        { at: 0.2, emotion: 'calm', gesture: 'talk', camera: 'medium', gaze: 'down', intensity: 0.1 },
      ],
    }));

    expect(cues).toHaveLength(2);
    expect(cues?.[0]).toMatchObject({ at: 0, direction: { emotion: 'calm', gesture: 'talk', camera: 'medium', gaze: 'down', intensity: 0.2 } });
    expect(cues?.[1]).toMatchObject({ at: 0.75, direction: { emotion: 'happy', gesture: 'lean-in', camera: 'push-in', gaze: 'viewer', intensity: 1, faces: ['wink'] } });
  });

  it('keeps only whitelisted model actions and accepts nested directions', () => {
    const allowed = parseAvatarPerformanceRehearsal(JSON.stringify({
      cues: [{ at: 0, direction: { emotion: 'surprised', model_action: 'Star-Eyes' } }],
    }), ['Star-Eyes']);
    const blocked = parseAvatarPerformanceRehearsal(JSON.stringify({
      cues: [{ at: 0, emotion: 'surprised', model_action: 'invented-action' }],
    }), ['Star-Eyes']);

    expect(allowed?.[0].direction.modelAction).toBe('Star-Eyes');
    expect(blocked?.[0].direction.modelAction).toBeUndefined();
  });

  it('parses per-sentence opening, hold duration, and closing directions', () => {
    const cues = parseAvatarPerformanceRehearsal(JSON.stringify({
      cues: [{
        at: 0,
        hold_ms: 1180,
        start: { emotion: 'surprised', gesture: 'lean-in', model_actions: ['Star-Eyes'] },
        end: { emotion: 'relaxed', gesture: 'lean-back', face: ['smile-eyes'] },
      }],
    }), ['Star-Eyes']);

    expect(cues?.[0]).toMatchObject({
      at: 0,
      holdMs: 1180,
      direction: { emotion: 'surprised', gesture: 'lean-in', modelAction: 'Star-Eyes' },
      endDirection: { emotion: 'relaxed', gesture: 'lean-back', faces: ['smile-eyes'] },
    });
    expect(isCompleteAvatarPerformanceCuePack(cues, 1)).toBe(true);
  });

  it('rejects incomplete packs in strict mode while keeping legacy parsing compatible', () => {
    const legacy = parseAvatarPerformanceRehearsal(JSON.stringify({
      cues: [{ at: 0, emotion: 'calm', gesture: 'talk' }],
    }));
    expect(legacy).toHaveLength(1);
    expect(isCompleteAvatarPerformanceCuePack(legacy, 1)).toBe(false);
    expect(isCompleteAvatarPerformanceCuePack(legacy, 2)).toBe(false);
  });

  it('shares deterministic sentence boundaries with desktop and high-quality calls', () => {
    expect(splitAvatarPerformanceSentences('第一句。第二句！\n第三句')).toEqual([
      { text: '第一句。', at: 0 },
      { text: '第二句！', at: 4 / 12 },
      { text: '第三句', at: 9 / 12 },
    ]);
  });

  it('accepts up to three deduplicated whitelisted action layers and mirrors the first for compatibility', () => {
    const cues = parseAvatarPerformanceRehearsal(JSON.stringify({
      cues: [{
        at: 0,
        emotion: 'happy',
        model_actions: ['Star-Eyes', 'wave', 'star-eyes', 'invented', 'blush'],
      }],
    }), ['Star-Eyes', 'wave', 'blush']);

    expect(cues?.[0].direction.modelActions).toEqual(['Star-Eyes', 'wave', 'blush']);
    expect(cues?.[0].direction.modelAction).toBe('Star-Eyes');
  });

  it('returns null for unusable director output', () => {
    expect(parseAvatarPerformanceRehearsal('not json')).toBeNull();
    expect(parseAvatarPerformanceRehearsal('{"cues":[{"at":0}]}')).toBeNull();
  });

  it('accepts an explicit cue cap for sentence-level companion direction', () => {
    const cues = parseAvatarPerformanceRehearsal(JSON.stringify({
      cues: Array.from({ length: 8 }, (_, index) => ({
        at: index / 8,
        emotion: 'calm',
        gesture: index % 2 ? 'wave' : 'talk',
      })),
    }), [], 8);

    expect(cues).toHaveLength(8);
  });
});
