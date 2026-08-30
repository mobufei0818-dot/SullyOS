import { describe, expect, it } from 'vitest';
import {
  blendshapeCategoriesToMap,
  buildUserCameraEmotionPrompt,
  classifyUserCameraBlendshapes,
} from './userCameraEmotion';

describe('user camera emotion calibration', () => {
  it('recognizes a decisive smile without over-weighting one coefficient', () => {
    const result = classifyUserCameraBlendshapes(new Map([
      ['mouthSmileLeft', 0.9],
      ['mouthSmileRight', 0.86],
      ['cheekSquintLeft', 0.62],
      ['cheekSquintRight', 0.58],
    ]));
    expect(result.emotion).toBe('happy');
    expect(result.label).toBe('开心');
  });

  it('prefers neutral when the signal is weak or ambiguous', () => {
    expect(classifyUserCameraBlendshapes(new Map([
      ['mouthSmileLeft', 0.2],
      ['mouthFrownLeft', 0.18],
      ['browDownLeft', 0.14],
    ])).emotion).toBe('neutral');
  });

  it('recognizes normal webcam-strength expressions instead of collapsing to neutral', () => {
    expect(classifyUserCameraBlendshapes(new Map([
      ['mouthSmileLeft', 0.38],
      ['mouthSmileRight', 0.34],
      ['cheekSquintLeft', 0.16],
      ['cheekSquintRight', 0.14],
    ])).emotion).toBe('happy');

    expect(classifyUserCameraBlendshapes(new Map([
      ['jawOpen', 0.42],
      ['eyeWideLeft', 0.26],
      ['eyeWideRight', 0.24],
      ['browInnerUp', 0.3],
    ])).emotion).toBe('surprised');

    expect(classifyUserCameraBlendshapes(new Map([
      ['mouthFrownLeft', 0.35],
      ['mouthFrownRight', 0.33],
      ['browInnerUp', 0.28],
      ['mouthPressLeft', 0.12],
      ['mouthPressRight', 0.1],
    ])).emotion).toBe('sad');

    expect(classifyUserCameraBlendshapes(new Map([
      ['browDownLeft', 0.42],
      ['browDownRight', 0.38],
      ['mouthPressLeft', 0.2],
      ['mouthPressRight', 0.18],
      ['noseSneerLeft', 0.08],
      ['noseSneerRight', 0.06],
    ])).emotion).toBe('angry');
  });

  it('does not treat a partial blink as tired', () => {
    expect(classifyUserCameraBlendshapes(new Map([
      ['eyeBlinkLeft', 0.48],
      ['eyeBlinkRight', 0.46],
    ])).emotion).toBe('neutral');
  });

  it('deduplicates malformed blendshape categories and writes a cautious prompt', () => {
    const shapes = blendshapeCategoriesToMap([
      { categoryName: 'jawOpen', score: 0.4 },
      { categoryName: 'jawOpen', score: 0.8 },
      { categoryName: '', score: 1 },
    ] as any);
    expect(shapes.get('jawOpen')).toBe(0.8);
    const prompt = buildUserCameraEmotionPrompt({ emotion: 'surprised', label: '惊讶', confidence: 0.77 });
    expect(prompt).toContain('用户主动开启了摄像头');
    expect(prompt).toContain('以文字为准');
    expect(prompt).toContain('不要向用户解释识别系统');
  });
});

