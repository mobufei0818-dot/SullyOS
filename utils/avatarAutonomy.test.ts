import { describe, expect, it } from 'vitest';
import { AvatarAutonomy, getViewerEyeContactCompensation, type AvatarActivity, type AvatarAttentionPointer } from './avatarAutonomy';
import { DEFAULT_AVATAR_PERFORMANCE, type AvatarPerformanceDirection } from './avatarPerformance';

const seededRandom = (seed = 0x12345678) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

const noPointer: AvatarAttentionPointer = { x: 0, y: 0, active: false, lastMoved: 0 };

const run = (
  autonomy: AvatarAutonomy,
  duration: number,
  direction: AvatarPerformanceDirection = DEFAULT_AVATAR_PERFORMANCE,
  activity: AvatarActivity = 'idle',
  pointer: AvatarAttentionPointer = noPointer,
) => {
  const frames = [];
  for (let now = 0; now <= duration; now += 16) frames.push(autonomy.step(now, direction, activity, pointer));
  return frames;
};

describe('AvatarAutonomy', () => {
  it('maps the final head pose to a bounded opposite eye correction', () => {
    const correction = getViewerEyeContactCompensation(0.4, -0.25);
    expect(correction.eyeX).toBeCloseTo(-0.36, 8);
    expect(correction.eyeY).toBeCloseTo(0.18, 8);
    expect(getViewerEyeContactCompensation(2, -2)).toEqual({ eyeX: -0.56, eyeY: 0.38 });
  });
  it('starts centered instead of choosing a random left or right turn on boot', () => {
    const frames = run(new AvatarAutonomy(0, seededRandom(5)), 900);

    expect(new Set(frames.map(frame => frame.pose))).toEqual(new Set(['settle']));
    expect(Math.max(...frames.map(frame => Math.abs(frame.headX)))).toBeLessThan(0.04);
    expect(Math.max(...frames.map(frame => Math.abs(frame.eyeX)))).toBeLessThan(0.04);
  });

  it('keeps choosing visible poses and blinking without LLM updates', () => {
    const frames = run(new AvatarAutonomy(0, seededRandom(7)), 10_000);
    const poses = new Set(frames.map(frame => frame.pose));

    expect(poses.size).toBeGreaterThan(1);
    expect(Math.max(...frames.map(frame => Math.abs(frame.headX)))).toBeGreaterThan(0.08);
    expect(Math.max(...frames.map(frame => Math.abs(frame.eyeX)))).toBeGreaterThan(0.08);
    expect(Math.max(...frames.map(frame => frame.blink))).toBeGreaterThan(0.75);
  });

  it('lets eyes follow a fresh pointer more strongly than the head', () => {
    const performer = new AvatarAutonomy(0, seededRandom(12));
    const pointer = { x: 0.9, y: 0.25, active: true, lastMoved: 0 };
    const frames = run(performer, 1_600, DEFAULT_AVATAR_PERFORMANCE, 'idle', pointer);
    const frame = frames[frames.length - 1]!;

    expect(frame.eyeX).toBeGreaterThan(0.55);
    expect(frame.eyeX).toBeGreaterThan(frame.headX * 1.7);
    expect(frame.pose).toBe('pointer');
  });

  it('looks down while thinking and creates non-periodic emphasis while speaking', () => {
    const thinkingFrames = run(new AvatarAutonomy(0, seededRandom(23)), 1_800, DEFAULT_AVATAR_PERFORMANCE, 'thinking');
    const thinking = thinkingFrames[thinkingFrames.length - 1]!;
    const speaking = run(new AvatarAutonomy(0, seededRandom(29)), 5_000, DEFAULT_AVATAR_PERFORMANCE, 'speaking');

    expect(thinking.eyeY).toBeLessThan(-0.25);
    expect(thinking.headY).toBeLessThan(0);
    expect(Math.max(...speaking.map(frame => frame.speechAccent))).toBeGreaterThan(0.5);
    expect(Math.max(...speaking.map(frame => frame.gestureEnvelope))).toBeGreaterThan(0.5);
  });

  it('turns a close camera direction into a physical lean with attack and release', () => {
    const closeDirection: AvatarPerformanceDirection = {
      ...DEFAULT_AVATAR_PERFORMANCE,
      gesture: 'tilt',
      camera: 'push-in',
      intensity: 0.9,
    };
    const frames = run(new AvatarAutonomy(0, seededRandom(31)), 2_000, closeDirection, 'speaking');

    expect(Math.max(...frames.map(frame => frame.lean))).toBeGreaterThan(0.035);
    expect(Math.max(...frames.map(frame => Math.abs(frame.headZ)))).toBeGreaterThan(0.08);
  });

  it('turns a real audio onset into synchronized head and hand emphasis', () => {
    const performer = new AvatarAutonomy(0, seededRandom(41));
    const frames = [];
    for (let now = 0; now <= 520; now += 16) {
      const energy = now < 96 ? 0.04 : now < 240 ? 0.92 : 0.12;
      frames.push(performer.step(now, DEFAULT_AVATAR_PERFORMANCE, 'speaking', noPointer, energy));
    }

    expect(Math.max(...frames.map(frame => frame.speechAccent))).toBeGreaterThan(0.72);
    expect(Math.max(...frames.map(frame => Math.abs(frame.headY)))).toBeGreaterThan(0.03);
  });
  it('keeps eye contact while speaking unless gaze is explicitly averted', () => {
    const pointer = { x: 0.95, y: 0.7, active: true, lastMoved: 1_600 };
    const viewerFrames = run(
      new AvatarAutonomy(0, seededRandom(47)),
      1_600,
      DEFAULT_AVATAR_PERFORMANCE,
      'speaking',
      pointer,
    );
    const viewer = viewerFrames[viewerFrames.length - 1]!;
    const leftDirection: AvatarPerformanceDirection = { ...DEFAULT_AVATAR_PERFORMANCE, gaze: 'left' };
    const avertedFrames = run(new AvatarAutonomy(0, seededRandom(47)), 1_600, leftDirection, 'speaking', pointer);
    const averted = avertedFrames[avertedFrames.length - 1]!;

    expect(Math.abs(viewer.eyeX)).toBeLessThan(0.08);
    expect(Math.abs(viewer.eyeY)).toBeLessThan(0.08);
    expect(viewer.pose).not.toBe('pointer');
    expect(averted.eyeX).toBeLessThan(-0.5);
  });
  it('counter-steers the eyes toward the camera while the head shakes', () => {
    const direction: AvatarPerformanceDirection = {
      ...DEFAULT_AVATAR_PERFORMANCE,
      gesture: 'shake',
      gaze: 'viewer',
      intensity: 1,
    };
    const frames = run(new AvatarAutonomy(0, seededRandom(49)), 2_200, direction, 'speaking');
    const activeFrames = frames.filter(frame => Math.abs(frame.headX) > 0.12);

    expect(activeFrames.length).toBeGreaterThan(10);
    expect(Math.max(...activeFrames.map(frame => Math.abs(frame.eyeX)))).toBeGreaterThan(0.12);
    expect(Math.max(...activeFrames.map(frame => Math.abs(frame.eyeX)))).toBeLessThan(0.58);
    expect(activeFrames.filter(frame => frame.headX * frame.eyeX < 0).length / activeFrames.length).toBeGreaterThan(0.75);
  });
  it('uses a fast touch attack without speeding up ambient call motion', () => {
    const direction: AvatarPerformanceDirection = {
      ...DEFAULT_AVATAR_PERFORMANCE,
      gesture: 'tilt',
      intensity: 0.9,
    };
    const ambient = new AvatarAutonomy(0, seededRandom(53));
    const touched = new AvatarAutonomy(0, seededRandom(53));

    touched.triggerTouchReaction(direction, 'speaking', 0);
    ambient.step(0, direction, 'speaking', noPointer);
    touched.step(0, direction, 'speaking', noPointer);
    const ambientAttack = ambient.step(96, direction, 'speaking', noPointer);
    const touchAttack = touched.step(96, direction, 'speaking', noPointer);

    expect(touchAttack.gestureEnvelope).toBeGreaterThan(ambientAttack.gestureEnvelope + 0.4);
    expect(touched.step(1_500, direction, 'speaking', noPointer).gestureEnvelope).toBe(0);
    expect(ambient.step(1_500, direction, 'speaking', noPointer).gestureEnvelope).toBeGreaterThan(0.5);
  });

  it('turns a short touch gesture into visible body XYZ motion', () => {
    const direction: AvatarPerformanceDirection = {
      ...DEFAULT_AVATAR_PERFORMANCE,
      gesture: 'tilt',
      intensity: 0.9,
    };
    const performer = new AvatarAutonomy(0, seededRandom(57));
    performer.triggerTouchReaction(direction, 'speaking', 0);
    const frames = run(performer, 1_100, direction, 'speaking');

    expect(Math.max(...frames.map(frame => Math.abs(frame.bodyX)))).toBeGreaterThan(0.08);
    expect(Math.max(...frames.map(frame => Math.abs(frame.bodyZ)))).toBeGreaterThan(0.2);
  });

  it('keeps authored head locks while allowing a directed torso reaction', () => {
    const direction: AvatarPerformanceDirection = {
      ...DEFAULT_AVATAR_PERFORMANCE,
      gesture: 'lean-back',
      intensity: 1,
      precision: {
        lockAutonomy: true,
        lockHead: true,
        headX: 0,
        headY: 0,
        headZ: 0,
        bodyX: 0,
        bodyY: 0,
        bodyZ: 0,
      },
    };
    const frames = run(new AvatarAutonomy(0, seededRandom(58)), 1_600, direction, 'speaking');

    expect(Math.max(...frames.map(frame => Math.abs(frame.headX)))).toBe(0);
    expect(Math.max(...frames.map(frame => Math.abs(frame.headY)))).toBe(0);
    expect(Math.max(...frames.map(frame => Math.abs(frame.headZ)))).toBe(0);
    expect(Math.max(...frames.map(frame => Math.abs(frame.bodyY)))).toBeGreaterThan(0.28);
    expect(Math.max(...frames.map(frame => Math.abs(frame.bodyZ)))).toBeGreaterThan(0.06);
  });

  it('locks an authored startup pose, gaze and body against ambient randomness', () => {
    const direction: AvatarPerformanceDirection = {
      ...DEFAULT_AVATAR_PERFORMANCE,
      gesture: 'idle',
      precision: {
        lockAutonomy: true,
        headX: 0.24,
        headY: 0.08,
        headZ: -0.13,
        eyeX: 0,
        eyeY: 0,
        bodyX: 0.05,
        bodyY: 0.03,
        bodyZ: -0.04,
        overshoot: 0.1,
        settleMs: 880,
      },
    };
    const pointer = { x: -0.95, y: 0.8, active: true, lastMoved: 3_000 };
    const frames = run(new AvatarAutonomy(0, seededRandom(59)), 3_000, direction, 'speaking', pointer);
    const final = frames[frames.length - 1]!;

    expect(new Set(frames.map(frame => frame.pose))).toEqual(new Set(['focus']));
    expect(Math.max(...frames.map(frame => frame.speechAccent))).toBe(0);
    expect(final.headX).toBeCloseTo(0.24, 1);
    expect(final.headZ).toBeCloseTo(-0.13, 1);
    expect(Math.abs(final.eyeX)).toBeLessThan(0.03);
    expect(Math.abs(final.eyeY)).toBeLessThan(0.03);
    expect(final.bodyX).toBeCloseTo(0.05, 1);
    expect(final.bodyZ).toBeCloseTo(-0.04, 1);
  });

  it('keeps the head centered for the entire startup speech even when the gesture is shake', () => {
    const direction: AvatarPerformanceDirection = {
      ...DEFAULT_AVATAR_PERFORMANCE,
      emotion: 'surprised',
      gesture: 'shake',
      camera: 'close',
      intensity: 1,
      precision: {
        lockAutonomy: true,
        lockHead: true,
        headX: 0,
        headY: 0,
        headZ: 0,
        bodyX: 0,
        bodyY: 0,
        bodyZ: 0,
        overshoot: 0,
        settleMs: 320,
      },
    };
    const frames = run(new AvatarAutonomy(0, seededRandom(61)), 6_000, direction, 'speaking');

    expect(Math.max(...frames.map(frame => Math.abs(frame.headX)))).toBe(0);
    expect(Math.max(...frames.map(frame => Math.abs(frame.headY)))).toBe(0);
    expect(Math.max(...frames.map(frame => Math.abs(frame.headZ)))).toBe(0);
    expect(Math.max(...frames.map(frame => frame.gestureEnvelope))).toBeGreaterThan(0.5);
  });
});
