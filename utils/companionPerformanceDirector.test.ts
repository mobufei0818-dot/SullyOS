import { describe, expect, it } from 'vitest';
import { DEFAULT_AVATAR_PERFORMANCE, type AvatarPerformanceCue } from './avatarPerformance';
import {
  alignCompanionPerformanceCuesToSentences,
  splitCompanionPerformanceSentences,
} from './companionPerformanceDirector';

describe('companion sentence performance direction', () => {
  it('creates exactly one deterministic timeline slot per spoken sentence', () => {
    const sentences = splitCompanionPerformanceSentences('第一句。第二句！\n第三句？');

    expect(sentences.map(item => item.text)).toEqual(['第一句。', '第二句！', '第三句？']);
    expect(sentences[0].at).toBe(0);
    expect(sentences[1].at).toBeGreaterThan(sentences[0].at);
    expect(sentences[2].at).toBeGreaterThan(sentences[1].at);
  });

  it('uses sentence starts instead of accepting drifting LLM timestamps', () => {
    const cues: AvatarPerformanceCue[] = [
      { at: 0.42, direction: DEFAULT_AVATAR_PERFORMANCE },
      { at: 0.91, direction: { ...DEFAULT_AVATAR_PERFORMANCE, gesture: 'wave' } },
    ];
    const aligned = alignCompanionPerformanceCuesToSentences(cues, '回来啦。欢迎你！');

    expect(aligned).toHaveLength(2);
    expect(aligned[0].at).toBe(0);
    expect(aligned[1].at).toBeGreaterThan(0);
    expect(aligned[1].at).toBeLessThan(1);
    expect(aligned[1].direction.gesture).toBe('wave');
  });

  it('rejects an incomplete pack instead of retrying or inventing missing sentence actions', () => {
    const cues: AvatarPerformanceCue[] = [{ at: 0, direction: DEFAULT_AVATAR_PERFORMANCE }];

    expect(() => alignCompanionPerformanceCuesToSentences(cues, '第一句。第二句。'))
      .toThrow('需要 2 个，实际 1 个');
  });
});
