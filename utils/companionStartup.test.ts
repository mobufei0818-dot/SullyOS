import { describe, expect, it } from 'vitest';
import {
  buildCompanionStartupPrompt,
  parseCompanionStartupResponse,
} from './companionStartup';

describe('companion startup performance', () => {
  it('repairs fenced JSON and keeps an authored focus pose', () => {
    const result = parseCompanionStartupResponse({
      choices: [{
        message: {
          content: `\`\`\`json
{
  "line": "……你总算回来了。",
  "performance": {
    "emotion": "calm",
    "gesture": "tilt",
    "gaze": "left",
    "intensity": 0.72,
    "faces": ["brow-up"],
    "modelAction": "look-close",
    "precision": { "headX": 0.18, "headZ": -0.12, "eyeX": 0, "overshoot": 0.11, "settleMs": 1080, }
  },
}
\`\`\``,
        },
      }],
    }, [{ id: 'look-close', name: '靠近镜头' }]);

    expect(result?.line).toBe('……你总算回来了。');
    expect(result?.performance.gaze).toBe('viewer');
    expect(result?.performance.modelAction).toBe('look-close');
    expect(result?.performance.precision).toMatchObject({
      lockAutonomy: true,
      lockHead: true,
      headX: 0,
      headY: 0,
      headZ: 0,
      eyeX: 0,
      overshoot: 0.11,
      settleMs: 1080,
    });
  });

  it('accepts a plain character reply but never invents a local fallback', () => {
    const plain = parseCompanionStartupResponse('别盯着我看。 [[AVATAR: emotion=calm; gesture=tilt; gaze=viewer]]');

    expect(plain?.line).toBe('别盯着我看。');
    expect(plain?.performance.precision?.lockAutonomy).toBe(true);
    expect(plain?.performance.precision?.lockHead).toBe(true);
    expect(parseCompanionStartupResponse('')).toBeNull();
  });

  it('tells the model that themes cannot author dialogue', () => {
    const prompt = buildCompanionStartupPrompt('角色完整上下文', 'Sully', '条条');

    expect(prompt).toContain('不要替桌面主题说话');
    expect(prompt).toContain('不要套用通用欢迎');
    expect(prompt).toContain('眼睛默认看镜头');
    expect(prompt).toContain('身体 X/Y/Z');
  });
});
