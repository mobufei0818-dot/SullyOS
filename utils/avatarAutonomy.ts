import {
  DEFAULT_AVATAR_PERFORMANCE,
  type AvatarGesture,
  type AvatarPerformanceDirection,
} from './avatarPerformance';

export type AvatarActivity = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended' | 'error';

export interface AvatarAttentionPointer {
  x: number;
  y: number;
  active: boolean;
  lastMoved: number;
}

export type AvatarAutonomyPose = 'turn' | 'glance' | 'lean' | 'think' | 'settle' | 'pointer' | 'focus';
export type AvatarReactionProfile = 'natural' | 'touch';

export interface AvatarAutonomyFrame {
  headX: number;
  headY: number;
  headZ: number;
  bodyX: number;
  bodyY: number;
  bodyZ: number;
  eyeX: number;
  eyeY: number;
  lean: number;
  lift: number;
  rotation: number;
  breath: number;
  /** 0 = open, 1 = fully closed. */
  blink: number;
  /** A short non-periodic beat used for speech nods and hand emphasis. */
  speechAccent: number;
  /** Attack/release envelope for the current directed gesture. */
  gestureEnvelope: number;
  pose: AvatarAutonomyPose;
}

interface PoseTarget {
  headX: number;
  headY: number;
  headZ: number;
  eyeX: number;
  eyeY: number;
  lean: number;
}

interface Reaction {
  direction: AvatarPerformanceDirection;
  activity: AvatarActivity;
  startedAt: number;
  duration: number;
  profile: AvatarReactionProfile;
}

interface SpeechAccent {
  startedAt: number;
  duration: number;
  side: number;
  strength: number;
}

class Spring {
  value = 0;
  velocity = 0;

  step(target: number, dt: number, frequency: number, damping = 0.88): number {
    const omega = frequency * Math.PI * 2;
    const acceleration = (target - this.value) * omega * omega - 2 * damping * omega * this.velocity;
    this.velocity += acceleration * dt;
    this.value += this.velocity * dt;
    return this.value;
  }
}

const clamp = (value: number, min = -1, max = 1): number => Math.max(min, Math.min(max, value));

/**
 * Counter-steer local eye parameters against the final head pose so a model
 * keeps approximate camera contact while speaking. The caps intentionally
 * preserve some natural head-led gaze instead of producing a rigid stare.
 */
export const getViewerEyeContactCompensation = (headX: number, headY: number): { eyeX: number; eyeY: number } => ({
  eyeX: clamp(-headX * 0.9, -0.56, 0.56),
  eyeY: clamp(-headY * 0.72, -0.38, 0.38),
});

/**
 * Stateful, renderer-independent avatar motion. It is intentionally autonomous:
 * LLM performance directions bias it, but pose choices, attention, blinking and
 * speech beats continue without a new model response.
 */
export class AvatarAutonomy {
  private readonly random: () => number;
  private lastTime: number;
  private nextDecisionAt: number;
  private nextLeanAt: number;
  private nextBlinkAt: number;
  private blinkStartedAt = -1;
  private blinkDuration = 150;
  private blinkRepeatScheduled = false;
  private blinkRepeatPending = false;
  private nextSpeechAccentAt: number;
  private speechAccent?: SpeechAccent;
  private audioAccent?: SpeechAccent;
  private lastSpeechEnergy = 0;
  private lastAudioAccentAt = -Infinity;
  private reaction?: Reaction;
  private behaviorKey = '';
  private focusStartedAt = 0;
  private phase: number;
  private pose: AvatarAutonomyPose = 'settle';
  private target: PoseTarget;
  private headX = new Spring();
  private headY = new Spring();
  private headZ = new Spring();
  private bodyX = new Spring();
  private bodyY = new Spring();
  private bodyZ = new Spring();
  private eyeX = new Spring();
  private eyeY = new Spring();
  private lean = new Spring();
  private lift = new Spring();
  private rotation = new Spring();

  frame: AvatarAutonomyFrame = {
    headX: 0,
    headY: 0,
    headZ: 0,
    bodyX: 0,
    bodyY: 0,
    bodyZ: 0,
    eyeX: 0,
    eyeY: 0,
    lean: 0,
    lift: 0,
    rotation: 0,
    breath: 0.5,
    blink: 0,
    speechAccent: 0,
    gestureEnvelope: 0,
    pose: 'settle',
  };

  constructor(now = globalThis.performance?.now?.() ?? Date.now(), random: () => number = Math.random) {
    this.random = random;
    this.phase = this.randomBetween(0, Math.PI * 2);
    this.lastTime = now;
    this.target = {
      headX: 0,
      headY: 0,
      headZ: 0,
      eyeX: 0,
      eyeY: 0,
      lean: 0,
    };
    this.nextDecisionAt = now + this.randomBetween(2_200, 3_400);
    this.nextLeanAt = now + this.randomBetween(5_800, 8_200);
    this.nextBlinkAt = now + this.randomBetween(1_200, 3_600);
    this.nextSpeechAccentAt = now + this.randomBetween(350, 900);
  }

  private randomBetween(min: number, max: number): number {
    return min + this.random() * (max - min);
  }

  private randomSign(): number {
    return this.random() < 0.5 ? -1 : 1;
  }

  private signature(direction: AvatarPerformanceDirection, activity: AvatarActivity): string {
    return [
      activity,
      direction.emotion,
      direction.gesture,
      direction.camera,
      direction.gaze,
      direction.intensity.toFixed(2),
      direction.modelAction || '',
      direction.precision ? JSON.stringify(direction.precision) : '',
    ].join('|');
  }

  private react(
    direction: AvatarPerformanceDirection,
    activity: AvatarActivity,
    now: number,
    profile: AvatarReactionProfile = 'natural',
  ): void {
    const gesture = direction.gesture;
    const duration = profile === 'touch'
      ? gesture === 'shy' || gesture === 'lean-back' ? 1_420
        : gesture === 'wave' ? 1_260
          : 1_180
      : direction.camera === 'push-in' || direction.camera === 'close'
        ? 4_000
        : gesture === 'shy' ? 3_600
          : gesture === 'lean-in' || gesture === 'lean-back' ? 3_400
            : gesture === 'explain' ? 3_200
              : gesture === 'wave' ? 2_700
                : 2_300;
    this.reaction = { direction, activity, startedAt: now, duration, profile };
    this.nextDecisionAt = Math.max(this.nextDecisionAt, now + duration * 0.62);
    if (activity === 'speaking') this.nextSpeechAccentAt = now + this.randomBetween(180, 620);
  }

  /**
   * Touch is a discrete game-like impulse, not a faster version of ambient
   * breathing. Normal autonomy resumes after the short release finishes.
   */
  triggerTouchReaction(
    direction: AvatarPerformanceDirection,
    activity: AvatarActivity = 'speaking',
    now = globalThis.performance?.now?.() ?? Date.now(),
  ): void {
    this.behaviorKey = this.signature(direction, activity);
    this.react(direction, activity, now, 'touch');
  }

  private chooseNextPose(now: number): void {
    const choice = this.random();
    let duration: number;

    if (choice < 0.28) {
      const side = this.randomSign();
      this.pose = 'turn';
      this.target = {
        headX: side * this.randomBetween(0.28, 0.58),
        headY: this.randomBetween(-0.12, 0.2),
        headZ: -side * this.randomBetween(0.05, 0.16),
        eyeX: side * this.randomBetween(0.42, 0.8),
        eyeY: this.randomBetween(-0.22, 0.2),
        lean: 0,
      };
      duration = this.randomBetween(1_900, 3_800);
    } else if (choice < 0.47) {
      const side = this.randomSign();
      this.pose = 'glance';
      this.target = {
        headX: side * this.randomBetween(0.04, 0.16),
        headY: this.randomBetween(-0.08, 0.1),
        headZ: -side * this.randomBetween(0.01, 0.05),
        eyeX: side * this.randomBetween(0.62, 0.95),
        eyeY: this.randomBetween(-0.32, 0.3),
        lean: 0,
      };
      duration = this.randomBetween(850, 1_650);
    } else if (choice < 0.62) {
      this.pose = 'lean';
      this.target = {
        headX: this.randomBetween(-0.14, 0.14),
        headY: this.randomBetween(0.12, 0.3),
        headZ: this.randomBetween(-0.05, 0.05),
        eyeX: this.randomBetween(-0.18, 0.18),
        eyeY: this.randomBetween(-0.05, 0.16),
        lean: this.randomBetween(0.035, 0.075),
      };
      duration = this.randomBetween(2_300, 4_500);
    } else if (choice < 0.78) {
      this.pose = 'think';
      this.target = {
        headX: this.randomBetween(-0.12, 0.12),
        headY: this.randomBetween(-0.24, -0.08),
        headZ: this.randomBetween(-0.06, 0.06),
        eyeX: this.randomBetween(-0.3, 0.3),
        eyeY: this.randomBetween(-0.62, -0.25),
        lean: this.randomBetween(0, 0.018),
      };
      duration = this.randomBetween(1_500, 3_200);
    } else {
      this.pose = 'settle';
      this.target = {
        headX: this.randomBetween(-0.11, 0.11),
        headY: this.randomBetween(-0.08, 0.1),
        headZ: this.randomBetween(-0.055, 0.055),
        eyeX: this.randomBetween(-0.2, 0.2),
        eyeY: this.randomBetween(-0.12, 0.12),
        lean: 0,
      };
      duration = this.randomBetween(1_800, 3_600);
    }

    this.nextDecisionAt = now + duration;
  }

  private updateBlink(now: number): number {
    if (this.blinkStartedAt < 0 && now >= this.nextBlinkAt) {
      this.blinkStartedAt = now;
      this.blinkDuration = this.randomBetween(125, 175);
      if (this.blinkRepeatScheduled) {
        this.blinkRepeatScheduled = false;
        this.blinkRepeatPending = false;
      } else {
        this.blinkRepeatPending = this.random() < 0.16;
      }
    }

    if (this.blinkStartedAt < 0) return 0;
    const age = now - this.blinkStartedAt;
    if (age >= this.blinkDuration) {
      this.blinkStartedAt = -1;
      if (this.blinkRepeatPending) {
        this.blinkRepeatPending = false;
        this.blinkRepeatScheduled = true;
        this.nextBlinkAt = now + this.randomBetween(75, 125);
      } else {
        this.nextBlinkAt = now + this.randomBetween(2_300, 5_800);
      }
      return 0;
    }
    const phase = clamp(age / this.blinkDuration, 0, 1);
    return Math.sin(phase * Math.PI) ** 0.72;
  }

  private updateSpeechAccent(now: number, activity: AvatarActivity): { value: number; side: number } {
    if (activity !== 'speaking') {
      this.speechAccent = undefined;
      this.nextSpeechAccentAt = now + this.randomBetween(280, 780);
      return { value: 0, side: 0 };
    }
    if (!this.speechAccent && now >= this.nextSpeechAccentAt) {
      this.speechAccent = {
        startedAt: now,
        duration: this.randomBetween(320, 620),
        side: this.randomSign(),
        strength: this.randomBetween(0.55, 1),
      };
    }
    if (!this.speechAccent) return { value: 0, side: 0 };
    const age = now - this.speechAccent.startedAt;
    if (age >= this.speechAccent.duration) {
      this.speechAccent = undefined;
      this.nextSpeechAccentAt = now + this.randomBetween(650, 1_850);
      return { value: 0, side: 0 };
    }
    const phase = clamp(age / this.speechAccent.duration, 0, 1);
    return {
      value: Math.sin(phase * Math.PI) * this.speechAccent.strength,
      side: this.speechAccent.side,
    };
  }

  private updateAudioAccent(
    now: number,
    activity: AvatarActivity,
    speechEnergy?: number,
  ): { value: number; side: number } {
    if (activity !== 'speaking' || speechEnergy === undefined) {
      this.lastSpeechEnergy = 0;
      this.audioAccent = undefined;
      return { value: 0, side: 0 };
    }
    const energy = clamp(speechEnergy, 0, 1);
    const rise = Math.max(0, energy - this.lastSpeechEnergy);
    this.lastSpeechEnergy = energy;
    // A strong onset after a pause/softer syllable is a real speech beat. Debounce
    // close syllables so normal dialogue produces emphasis, not continuous nodding.
    if (!this.audioAccent && now - this.lastAudioAccentAt > 260 && energy > 0.42 && rise > 0.1) {
      this.lastAudioAccentAt = now;
      this.audioAccent = {
        startedAt: now,
        duration: 360,
        side: this.randomSign(),
        strength: clamp(0.5 + rise * 1.25, 0.58, 1),
      };
    }
    if (!this.audioAccent) return { value: 0, side: 0 };
    const age = now - this.audioAccent.startedAt;
    if (age >= this.audioAccent.duration) {
      this.audioAccent = undefined;
      return { value: 0, side: 0 };
    }
    const phase = clamp(age / this.audioAccent.duration, 0, 1);
    return {
      value: Math.sin(phase * Math.PI) * this.audioAccent.strength,
      side: this.audioAccent.side,
    };
  }

  step(
    now: number,
    direction: AvatarPerformanceDirection = DEFAULT_AVATAR_PERFORMANCE,
    activity: AvatarActivity = 'idle',
    pointer: AvatarAttentionPointer = { x: 0, y: 0, active: false, lastMoved: 0 },
    /** Normalized live audio level. Undefined means WebAudio is unavailable. */
    speechEnergy?: number,
  ): AvatarAutonomyFrame {
    const behaviorKey = this.signature(direction, activity);
    if (behaviorKey !== this.behaviorKey) {
      this.behaviorKey = behaviorKey;
      this.focusStartedAt = now;
      this.react(direction, activity, now);
    }
    const precision = direction.precision?.lockAutonomy ? direction.precision : undefined;

    const dt = Math.min(1 / 30, Math.max(1 / 240, (now - this.lastTime) / 1000));
    this.lastTime = now;
    if (!precision && now >= this.nextLeanAt && !this.reaction && activity !== 'thinking') {
      this.pose = 'lean';
      this.target = {
        headX: this.randomBetween(-0.12, 0.12),
        headY: this.randomBetween(0.16, 0.28),
        headZ: this.randomBetween(-0.04, 0.04),
        eyeX: this.randomBetween(-0.12, 0.12),
        eyeY: this.randomBetween(-0.02, 0.14),
        lean: this.randomBetween(0.055, 0.085),
      };
      this.nextDecisionAt = now + this.randomBetween(2_800, 4_200);
      this.nextLeanAt = now + this.randomBetween(14_000, 24_000);
    } else if (!precision && now >= this.nextDecisionAt) {
      this.chooseNextPose(now);
    }

    const seconds = now / 1000;
    const intensity = clamp(direction.intensity, 0.2, 1);
    const microX = precision ? 0 : Math.sin(seconds * 0.71 + this.phase) * 0.022 + Math.sin(seconds * 1.37 + 1.9) * 0.009;
    const microY = precision ? 0 : Math.sin(seconds * 0.53 + this.phase * 0.7) * 0.016;
    const microZ = precision ? 0 : Math.sin(seconds * 0.43 + this.phase + 2.2) * 0.012;
    let targetHeadX = this.target.headX + microX;
    let targetHeadY = this.target.headY + microY;
    let targetHeadZ = this.target.headZ + microZ;
    let targetEyeX = this.target.eyeX;
    let targetEyeY = this.target.eyeY;
    let targetLean = this.target.lean;
    let targetLift = 0;
    let targetRotation = 0;
    let targetBodyX = 0;
    let targetBodyY = 0;
    let targetBodyZ = 0;

    if (activity === 'thinking') {
      targetHeadY -= 0.17;
      targetHeadZ -= 0.035;
      targetEyeY = Math.min(targetEyeY, -0.48);
    } else if (activity === 'listening') {
      targetHeadY += 0.045;
      targetEyeX *= 0.48;
      targetEyeY *= 0.52;
    } else if (activity === 'speaking') {
      targetEyeX *= 0.38;
      targetEyeY *= 0.42;
      targetLean += 0.008 * intensity;
    }

    if (direction.gaze === 'left') {
      targetEyeX = -0.78 * intensity;
      targetHeadX -= 0.22 * intensity;
    } else if (direction.gaze === 'right') {
      targetEyeX = 0.78 * intensity;
      targetHeadX += 0.22 * intensity;
    } else if (direction.gaze === 'down') {
      targetEyeY = -0.62 * intensity;
      targetHeadY -= 0.18 * intensity;
    } else if (activity === 'speaking') {
      // Dialogue defaults to sustained eye contact. Averted gaze must be an
      // explicit performance direction (left/right/down), not ambient drift.
      targetEyeX = 0;
      targetEyeY = 0;
      targetHeadX *= 0.18;
      targetHeadY *= 0.42;
      targetHeadZ *= 0.45;
    } else {
      const viewerBias = activity === 'listening' ? 0.66 : 0.16;
      targetEyeX *= 1 - viewerBias;
      targetEyeY *= 1 - viewerBias;
      targetHeadX *= 1 - viewerBias * 0.34;
    }

    const pointerIsFresh = pointer.active && now - pointer.lastMoved < 2_400;
    const tracksPointer = !precision && pointerIsFresh && direction.gaze === 'viewer' && activity !== 'speaking';
    if (tracksPointer) {
      targetEyeX = pointer.x * 0.88;
      targetEyeY = pointer.y * 0.72;
      targetHeadX = targetHeadX * 0.55 + pointer.x * 0.18;
      targetHeadY = targetHeadY * 0.62 + pointer.y * 0.12;
    }

    let precisionPoseFactor = 1;
    if (precision) {
      const settleMs = Math.max(320, Math.min(2_400, precision.settleMs ?? 920));
      const phase = clamp((now - this.focusStartedAt) / settleMs, 0, 1);
      const overshoot = clamp(precision.overshoot ?? 0.08, 0, 0.2);
      const smooth = (value: number) => value * value * (3 - 2 * value);
      const poseFactor = phase < 0.62
        ? (1 + overshoot) * smooth(phase / 0.62)
        : 1 + overshoot * (1 - smooth((phase - 0.62) / 0.38));
      precisionPoseFactor = poseFactor;
      targetHeadX = (precision.headX ?? 0) * poseFactor;
      targetHeadY = (precision.headY ?? 0) * poseFactor;
      targetHeadZ = (precision.headZ ?? 0) * poseFactor;
      targetEyeX = (precision.eyeX ?? 0) * poseFactor;
      targetEyeY = (precision.eyeY ?? 0) * poseFactor;
      targetBodyX = (precision.bodyX ?? 0) * poseFactor;
      targetBodyY = (precision.bodyY ?? 0) * poseFactor;
      targetBodyZ = (precision.bodyZ ?? 0) * poseFactor;
    }

    const randomAccent = precision ? { value: 0, side: 0 } : this.updateSpeechAccent(now, activity);
    const audioAccent = precision ? { value: 0, side: 0 } : this.updateAudioAccent(now, activity, speechEnergy);
    const accent = audioAccent.value > randomAccent.value ? audioAccent : randomAccent;
    targetHeadY += accent.value * 0.11 * intensity;
    targetHeadX += accent.value * accent.side * 0.035 * intensity;
    targetLift -= accent.value * 0.006 * intensity;
    // Speech should travel through the torso too. Without a body impulse the
    // renderer can faithfully drive nine axes while the last three stay close
    // to zero, which makes a detailed rig read like a face-only animation.
    targetBodyY += accent.value * 0.18 * intensity;
    targetBodyX += accent.value * accent.side * 0.065 * intensity;

    let gestureEnvelope = 0;
    const reaction = this.reaction;
    if (reaction) {
      const elapsed = now - reaction.startedAt;
      if (elapsed >= reaction.duration) {
        this.reaction = undefined;
      } else {
        const touchProfile = reaction.profile === 'touch';
        const attack = clamp(elapsed / (touchProfile ? 96 : 260), 0, 1);
        const release = clamp((reaction.duration - elapsed) / (touchProfile ? 620 : 720), 0, 1);
        gestureEnvelope = Math.min(attack, release) * intensity;
        const localTime = (elapsed / 1000) * (touchProfile ? 1.48 : 1);
        const gesture: AvatarGesture = reaction.direction.gesture;

        switch (gesture) {
          // nod/shake 的振幅随 gestureEnvelope（已含 intensity）线性放大：
          // intensity 0.95 是用力点头/摇头，0.4 只是轻轻颔首。
          case 'nod':
            {
              const beat = Math.sin(localTime * 8.4);
              targetHeadY += beat * 0.44 * gestureEnvelope;
              targetBodyY += beat * 0.34 * gestureEnvelope;
              targetLift += beat * 0.01 * gestureEnvelope;
            }
            break;
          case 'shake':
            {
              const sweep = Math.sin(localTime * 7.2);
              targetHeadX += sweep * 0.48 * gestureEnvelope;
              targetHeadZ -= sweep * 0.1 * gestureEnvelope;
              targetBodyX += sweep * 0.36 * gestureEnvelope;
              targetBodyZ -= sweep * 0.12 * gestureEnvelope;
            }
            break;
          case 'tilt':
            targetHeadZ -= 0.3 * gestureEnvelope;
            targetHeadX += 0.1 * gestureEnvelope;
            targetBodyZ -= 0.38 * gestureEnvelope;
            targetBodyX += 0.11 * gestureEnvelope;
            break;
          case 'lean-in':
            targetLean += 0.1 * gestureEnvelope;
            targetHeadY += 0.1 * gestureEnvelope;
            targetBodyY += 0.56 * gestureEnvelope;
            targetBodyZ -= 0.08 * gestureEnvelope;
            targetLift -= 0.012 * gestureEnvelope;
            break;
          case 'lean-back':
            targetLean -= 0.09 * gestureEnvelope;
            targetHeadY += 0.06 * gestureEnvelope;
            targetHeadZ += 0.05 * gestureEnvelope;
            targetBodyY -= 0.52 * gestureEnvelope;
            targetBodyZ += 0.14 * gestureEnvelope;
            break;
          case 'explain':
            {
              const sweep = Math.sin(localTime * 2.4);
              targetHeadX += sweep * 0.2 * gestureEnvelope;
              targetHeadZ -= sweep * 0.1 * gestureEnvelope;
              targetBodyX += sweep * 0.34 * gestureEnvelope;
              targetBodyZ -= sweep * 0.22 * gestureEnvelope;
              targetRotation += sweep * 0.009 * gestureEnvelope;
            }
            break;
          case 'wave':
            targetHeadX -= 0.12 * gestureEnvelope;
            targetHeadZ += 0.13 * gestureEnvelope;
            targetBodyX -= 0.25 * gestureEnvelope;
            targetBodyZ += 0.24 * gestureEnvelope;
            targetLean += 0.018 * gestureEnvelope;
            break;
          case 'shy':
            targetHeadY -= 0.18 * gestureEnvelope;
            targetHeadX += 0.1 * gestureEnvelope;
            targetHeadZ -= 0.16 * gestureEnvelope;
            targetBodyX += 0.16 * gestureEnvelope;
            targetBodyY += 0.2 * gestureEnvelope;
            targetBodyZ -= 0.28 * gestureEnvelope;
            targetLean += 0.018 * gestureEnvelope;
            break;
          case 'talk':
            targetHeadY += accent.value * 0.08 * gestureEnvelope;
            targetBodyY += accent.value * 0.24 * gestureEnvelope;
            targetBodyX += accent.value * accent.side * 0.09 * gestureEnvelope;
            break;
          default:
            break;
        }

        if (reaction.direction.camera === 'push-in' || reaction.direction.camera === 'close') {
          targetLean += 0.075 * gestureEnvelope;
          targetHeadY += 0.12 * gestureEnvelope;
          targetBodyY += 0.28 * gestureEnvelope;
          targetLift -= 0.018 * gestureEnvelope;
        } else if (reaction.direction.camera === 'pull-out') {
          targetLean *= 1 - gestureEnvelope * 0.8;
          targetBodyY -= 0.18 * gestureEnvelope;
        }

        if (reaction.direction.emotion === 'surprised') {
          targetHeadY += 0.26 * gestureEnvelope;
          targetBodyY += 0.24 * gestureEnvelope;
          targetLean += 0.022 * gestureEnvelope;
          targetLift -= 0.014 * gestureEnvelope;
        } else if (reaction.direction.emotion === 'sad') {
          targetHeadY -= 0.12 * gestureEnvelope;
          targetHeadZ -= 0.09 * gestureEnvelope;
          targetBodyY -= 0.14 * gestureEnvelope;
          targetBodyZ -= 0.12 * gestureEnvelope;
        } else if (reaction.direction.emotion === 'happy') {
          targetLean += 0.012 * gestureEnvelope;
          targetHeadY += 0.06 * gestureEnvelope;
          targetBodyY += 0.1 * gestureEnvelope;
        }
      }
    }

    // Strong authored locks (used throughout startup speech) win over every
    // gesture/emotion head accent. Body, face and arm animation may continue.
    if (precision?.lockHead) {
      targetHeadX = (precision.headX ?? 0) * precisionPoseFactor;
      targetHeadY = (precision.headY ?? 0) * precisionPoseFactor;
      targetHeadZ = (precision.headZ ?? 0) * precisionPoseFactor;
    }

    const touchSpeed = this.reaction?.profile === 'touch';
    const headX = this.headX.step(clamp(targetHeadX), dt, 0.72 * (touchSpeed ? 1.45 : 1));
    const headY = this.headY.step(clamp(targetHeadY), dt, 0.68 * (touchSpeed ? 1.45 : 1));
    const headZ = this.headZ.step(clamp(targetHeadZ), dt, 0.64 * (touchSpeed ? 1.45 : 1));
    // Body axes used to run at ~0.3 Hz and then get smoothed a second time in
    // Live2D. A short touch reaction ended before the torso reached a visible
    // fraction of its target. Keep the springs damped, but let them arrive while
    // the authored beat is still on screen.
    const bodyFrequency = precision ? 0.62 : 0.64 * (touchSpeed ? 1.25 : 1);
    const bodyX = this.bodyX.step(clamp(precision ? targetBodyX : headX * 0.5 + microX * 0.8 + targetBodyX), dt, bodyFrequency);
    const bodyY = this.bodyY.step(clamp(precision ? targetBodyY : headY * 0.36 + microY * 0.7 + targetBodyY), dt, precision ? 0.58 : 0.6 * (touchSpeed ? 1.25 : 1));
    const bodyZ = this.bodyZ.step(clamp(precision ? targetBodyZ : headZ * 0.54 + microZ + targetBodyZ), dt, precision ? 0.56 : 0.58 * (touchSpeed ? 1.25 : 1));
    // “眼球归零”只表示眼睛朝着脸的正前方；头在摇晃/点头时，眼睛仍会随头骨一起
    // 离开镜头。说话且明确 gaze=viewer 时，按弹簧平滑后的实际头姿做有限反向补偿。
    // 眼球响应略快于普通扫视，减少摇头换向时的错相；显式 left/right/down 与导演
    // 精确姿态保持原样，不在这里抢控制权。
    const maintainsViewerEyeContact = !precision && activity === 'speaking' && direction.gaze === 'viewer';
    if (maintainsViewerEyeContact) {
      const correction = getViewerEyeContactCompensation(headX, headY);
      targetEyeX = correction.eyeX;
      targetEyeY = correction.eyeY;
    }
    const eyeX = this.eyeX.step(clamp(targetEyeX), dt, maintainsViewerEyeContact ? 3.1 : 2.4, maintainsViewerEyeContact ? 0.9 : 0.78);
    const eyeY = this.eyeY.step(clamp(targetEyeY), dt, maintainsViewerEyeContact ? 2.8 : 2.2, maintainsViewerEyeContact ? 0.9 : 0.78);
    // lean 允许为负（lean-back 后仰）；正向前倾上限稍高。
    const lean = this.lean.step(clamp(targetLean, -0.1, 0.14), dt, 0.42 * (touchSpeed ? 1.3 : 1));
    const lift = this.lift.step(targetLift, dt, 0.5 * (touchSpeed ? 1.3 : 1));
    const rotation = this.rotation.step(targetRotation, dt, 0.48 * (touchSpeed ? 1.3 : 1));
    const breath = (Math.sin(seconds * 1.12 + this.phase * 0.2) + 1) / 2;
    const pose = precision ? 'focus' : tracksPointer ? 'pointer' : this.pose;

    this.frame = {
      headX,
      headY,
      headZ,
      bodyX,
      bodyY,
      bodyZ,
      eyeX,
      eyeY,
      lean,
      lift,
      rotation,
      breath,
      blink: this.updateBlink(now),
      speechAccent: accent.value,
      gestureEnvelope,
      pose,
    };
    return this.frame;
  }
}
