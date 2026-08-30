import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  VRM,
  VRMExpressionPresetName,
  VRMHumanBoneName,
  VRMLoaderPlugin,
  VRMUtils,
} from '@pixiv/three-vrm';
import { AvatarAutonomy } from '../../utils/avatarAutonomy';
import { isDevDebugAvailable } from '../../utils/devDebug';
import {
  DEFAULT_AVATAR_PERFORMANCE,
  DEFAULT_STAGE_FRAMING,
  type AvatarPerformanceDirection,
  type AvatarStageFraming,
} from '../../utils/avatarPerformance';
import type { CallAudioFeed } from '../../utils/callAudioFeed';
import {
  resolveAvatarTouchTarget,
  type AvatarTouchHit,
  type AvatarTouchRequest,
} from '../../utils/avatarTouch';

export type AvatarMotionState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended' | 'error';

interface VRMAvatarCanvasProps {
  modelUrl: string;
  motionState: AvatarMotionState;
  emotion?: string;
  audioFeed?: CallAudioFeed;
  /** Absolute runtime lock; used for the whole companion startup utterance. */
  headMotionLocked?: boolean;
  /** Companion desktop must not inherit the video-call random pose generator. */
  ambientAutonomyDisabled?: boolean;
  framing?: AvatarStageFraming;
  /** 用户锚定的脸部特写构图；close/push-in 时镜头直接落到这里。 */
  faceFraming?: AvatarStageFraming;
  performance?: AvatarPerformanceDirection;
  onLoadingChange?: (loading: boolean) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
  /** 模型加载后回传自定义表情名（预设之外的），供 LLM 以 model_action 调用。 */
  onExpressionsDiscovered?: (names: string[]) => void;
  touchRequest?: AvatarTouchRequest | null;
  touchImpulseNonce?: number;
  onAvatarTouch?: (hit: AvatarTouchHit) => void;
  maxFps?: number;
}

type MotionSnapshot = {
  state: AvatarMotionState;
  emotion: string;
  performance: AvatarPerformanceDirection;
  framing: AvatarStageFraming;
  faceFraming?: AvatarStageFraming;
};

// 返回 null = 中性脸，什么表情都不挂。calm/neutral 一定要走这里：很多模型把
// Relaxed 预设绑成吐舌/眯眼卖萌脸，旧实现默认情绪 calm→Relaxed 且每帧恒定
// 施加权重，角色就全程吐着舌头站在那里（用户原话）。只有角色明确表达
// relaxed 情绪时才短暂使用 Relaxed。
const emotionExpression = (emotion: string): string | null => {
  switch (emotion.toLowerCase()) {
    case 'happy': return VRMExpressionPresetName.Happy;
    case 'sad': return VRMExpressionPresetName.Sad;
    case 'angry': return VRMExpressionPresetName.Angry;
    case 'fearful': return VRMExpressionPresetName.Surprised;
    case 'disgusted': return VRMExpressionPresetName.Angry;
    case 'surprised': return VRMExpressionPresetName.Surprised;
    case 'relaxed': return VRMExpressionPresetName.Relaxed;
    default: return null;
  }
};

const EMOTION_PRESETS = [
  VRMExpressionPresetName.Happy,
  VRMExpressionPresetName.Sad,
  VRMExpressionPresetName.Angry,
  VRMExpressionPresetName.Surprised,
  VRMExpressionPresetName.Relaxed,
] as const;

const VRMAvatarCanvas: React.FC<VRMAvatarCanvasProps> = ({
  modelUrl,
  motionState,
  emotion = 'calm',
  audioFeed,
  headMotionLocked = false,
  ambientAutonomyDisabled = false,
  framing = DEFAULT_STAGE_FRAMING,
  faceFraming,
  performance: performanceDirection = DEFAULT_AVATAR_PERFORMANCE,
  onLoadingChange,
  onReady,
  onError,
  onExpressionsDiscovered,
  touchRequest,
  touchImpulseNonce,
  onAvatarTouch,
  maxFps,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const audioFeedRef = useRef<CallAudioFeed | undefined>(audioFeed);
  const headMotionLockedRef = useRef(headMotionLocked);
  const ambientAutonomyDisabledRef = useRef(ambientAutonomyDisabled);
  const onReadyRef = useRef(onReady);
  const onExpressionsDiscoveredRef = useRef(onExpressionsDiscovered);
  const onAvatarTouchRef = useRef(onAvatarTouch);
  const touchResolverRef = useRef<((request: AvatarTouchRequest) => void) | null>(null);
  const touchImpulseNonceRef = useRef(touchImpulseNonce);
  const motionRef = useRef<MotionSnapshot>({ state: motionState, emotion, performance: performanceDirection, framing, faceFraming });

  useEffect(() => { audioFeedRef.current = audioFeed; }, [audioFeed]);
  useEffect(() => { headMotionLockedRef.current = headMotionLocked; }, [headMotionLocked]);
  useEffect(() => { ambientAutonomyDisabledRef.current = ambientAutonomyDisabled; }, [ambientAutonomyDisabled]);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { onExpressionsDiscoveredRef.current = onExpressionsDiscovered; }, [onExpressionsDiscovered]);
  useEffect(() => { onAvatarTouchRef.current = onAvatarTouch; }, [onAvatarTouch]);
  useEffect(() => { touchImpulseNonceRef.current = touchImpulseNonce; }, [touchImpulseNonce]);
  useEffect(() => {
    if (touchRequest) touchResolverRef.current?.(touchRequest);
  }, [touchRequest]);
  useEffect(() => {
    motionRef.current = { state: motionState, emotion, performance: performanceDirection, framing, faceFraming };
  }, [motionState, emotion, performanceDirection, framing, faceFraming]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !modelUrl) return;

    let disposed = false;
    let frameId = 0;
    let currentVrm: VRM | null = null;
    let avatarHeight = 1;
    let modelBasePositionX = 0;
    let modelBasePositionY = 0;
    let modelBasePositionZ = 0;
    let modelBaseRotationY = 0;
    let cameraLookY = 0.82;
    const pointer = { x: 0, y: 0, active: false, lastMoved: 0 };
    const autonomy = new AvatarAutonomy(window.performance.now());
    let handledTouchImpulseNonce = touchImpulseNonceRef.current;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 20);
    const touchRaycaster = new THREE.Raycaster();
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    host.appendChild(renderer.domElement);

    const handlePointerMove = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pointer.x = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1));
      pointer.y = Math.max(-1, Math.min(1, 1 - ((event.clientY - rect.top) / rect.height) * 2));
      pointer.active = true;
      pointer.lastMoved = window.performance.now();
    };
    const handlePointerLeave = () => { pointer.active = false; };
    host.addEventListener('pointermove', handlePointerMove);
    host.addEventListener('pointerleave', handlePointerLeave);

    touchResolverRef.current = request => {
      const vrm = currentVrm;
      if (!vrm) return;
      touchRaycaster.setFromCamera(
        new THREE.Vector2(request.normalizedX * 2 - 1, 1 - request.normalizedY * 2),
        camera,
      );
      const intersection = touchRaycaster.intersectObject(vrm.scene, true)
        .find(item => item.object.visible);
      if (!intersection) return;
      const bounds = new THREE.Box3().setFromObject(vrm.scene);
      const size = bounds.getSize(new THREE.Vector3());
      if (!Number.isFinite(size.y) || size.y <= 0) return;
      const xRatio = (intersection.point.x - bounds.min.x) / Math.max(0.001, size.x);
      const yFromTop = 1 - ((intersection.point.y - bounds.min.y) / size.y);
      const rawAreas: string[] = [];
      let object: THREE.Object3D | null = intersection.object;
      for (let depth = 0; object && depth < 6; depth += 1, object = object.parent) {
        const name = String(object.name || '').trim();
        if (name && !rawAreas.includes(name)) rawAreas.push(name);
      }
      const boneAnchors: Array<{ bone: VRMHumanBoneName; label: string; radius: number }> = [
        { bone: VRMHumanBoneName.LeftHand, label: 'LeftHand', radius: 0.095 },
        { bone: VRMHumanBoneName.RightHand, label: 'RightHand', radius: 0.095 },
        { bone: VRMHumanBoneName.LeftLowerArm, label: 'LeftArm', radius: 0.1 },
        { bone: VRMHumanBoneName.RightLowerArm, label: 'RightArm', radius: 0.1 },
        { bone: VRMHumanBoneName.LeftUpperArm, label: 'LeftArm', radius: 0.1 },
        { bone: VRMHumanBoneName.RightUpperArm, label: 'RightArm', radius: 0.1 },
        { bone: VRMHumanBoneName.LeftShoulder, label: 'LeftShoulder', radius: 0.085 },
        { bone: VRMHumanBoneName.RightShoulder, label: 'RightShoulder', radius: 0.085 },
        { bone: VRMHumanBoneName.Head, label: 'Head', radius: 0.16 },
        { bone: VRMHumanBoneName.UpperChest, label: 'Chest', radius: 0.12 },
        { bone: VRMHumanBoneName.Chest, label: 'Chest', radius: 0.12 },
        { bone: VRMHumanBoneName.Spine, label: 'Waist', radius: 0.11 },
      ];
      const nearestAnchor = boneAnchors
        .map(anchor => {
          const node = vrm.humanoid.getNormalizedBoneNode(anchor.bone);
          if (!node) return null;
          const distance = node.getWorldPosition(new THREE.Vector3()).distanceTo(intersection.point) / size.y;
          return { ...anchor, distance };
        })
        .filter((anchor): anchor is NonNullable<typeof anchor> => Boolean(anchor))
        .filter(anchor => anchor.distance <= anchor.radius)
        .sort((a, b) => (a.distance / a.radius) - (b.distance / b.radius))[0];
      if (nearestAnchor && !rawAreas.includes(nearestAnchor.label)) rawAreas.unshift(nearestAnchor.label);
      const target = resolveAvatarTouchTarget(
        nearestAnchor ? [nearestAnchor.label] : rawAreas,
        yFromTop,
        xRatio,
      );
      onAvatarTouchRef.current?.({
        ...request,
        ...target,
        source: 'vrm-raycast',
        rawAreas,
      });
    };

    const hemi = new THREE.HemisphereLight(0xe8edff, 0x17101e, 2.35);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffe9dc, 3.1);
    key.position.set(1.7, 2.8, 2.6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8297ff, 2.4);
    rim.position.set(-2.2, 1.8, -1.5);
    scene.add(rim);

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);

    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));
    onLoadingChange?.(true);

    const setBone = (
      vrm: VRM,
      name: (typeof VRMHumanBoneName)[keyof typeof VRMHumanBoneName],
      x: number,
      y: number,
      z: number,
      alpha: number,
    ) => {
      const node = vrm.humanoid.getNormalizedBoneNode(name);
      if (!node) return;
      const target = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'YXZ'));
      node.quaternion.slerp(target, alpha);
    };

    let previousFrameTime = performance.now() / 1000;
    let lastRenderedAt = 0;
    let elapsedTime = 0;
    const debugFrameDatasets = isDevDebugAvailable();
    let lastPoseDataset = '';
    // 表情包络：说话时保持、说完后停留片刻再指数衰减回中性脸，
    // 而不是永远挂着上一条回复的表情。
    let lastPerformanceDirection: AvatarPerformanceDirection | null = null;
    let performanceChangedAt = 0;
    const expressionWeights = new Map<string, number>();
    // 模型自带的自定义表情（预设之外），LLM 通过 model_action 按名字调用。
    let customExpressionNames: string[] = [];
    const animate = () => {
      if (disposed) return;
      frameId = requestAnimationFrame(animate);
      const frameNowMs = performance.now();
      if (maxFps && maxFps > 0 && frameNowMs - lastRenderedAt < 1000 / maxFps) return;
      lastRenderedAt = frameNowMs;
      const currentFrameTime = frameNowMs / 1000;
      const delta = Math.min(Math.max(0, currentFrameTime - previousFrameTime), 1 / 20);
      previousFrameTime = currentFrameTime;
      elapsedTime += delta;
      const t = elapsedTime;
      const vrm = currentVrm;

      if (vrm) {
        const { state, emotion: fallbackEmotion, performance: currentPerformance, framing: userFraming, faceFraming: anchorFraming } = motionRef.current;
        const headLocked = headMotionLockedRef.current;
        const suppressesAmbientAutonomy = ambientAutonomyDisabledRef.current;
        const effectivePerformance = headLocked || suppressesAmbientAutonomy ? {
          ...currentPerformance,
          precision: {
            ...(currentPerformance.precision || {}),
            lockAutonomy: true,
            lockHead: headLocked || currentPerformance.precision?.lockHead,
            headX: 0,
            headY: 0,
            headZ: 0,
            eyeX: currentPerformance.precision?.eyeX ?? 0,
            eyeY: currentPerformance.precision?.eyeY ?? 0,
            bodyX: currentPerformance.precision?.bodyX ?? 0,
            bodyY: currentPerformance.precision?.bodyY ?? 0,
            bodyZ: currentPerformance.precision?.bodyZ ?? 0,
            overshoot: 0,
          },
        } : currentPerformance;
        const speaking = state === 'speaking';
        const currentEmotion = effectivePerformance.emotion || fallbackEmotion;
        const gesture = effectivePerformance.gesture;
        const intensity = Math.max(0.2, Math.min(1, effectivePerformance.intensity));
        const frameNow = window.performance.now();
        const touchNonce = touchImpulseNonceRef.current;
        if (touchNonce !== undefined && touchNonce !== handledTouchImpulseNonce) {
          handledTouchImpulseNonce = touchNonce;
          autonomy.triggerTouchReaction(effectivePerformance, state, frameNow);
          host.dataset.avatarTouchImpulse = String(touchNonce);
        }
        // Sample once per render frame: the same live signal drives both visemes
        // and emphasis beats, keeping head/hands synchronized with the voice.
        const lip = audioFeedRef.current?.sample(frameNow);
        const autonomyFrame = autonomy.step(
          frameNow,
          effectivePerformance,
          state,
          pointer,
          speaking && lip?.active ? lip.level : undefined,
        );
        const frame = headLocked ? {
          ...autonomyFrame,
          headX: 0,
          headY: 0,
          headZ: 0,
          rotation: 0,
          speechAccent: 0,
        } : autonomyFrame;
        const breath = frame.breath * 2 - 1;
        const blend = 1 - Math.exp(-delta * 7.5);
        // 姿态低频、变了才写；逐帧变化的眨眼调试值只在 dev 面板可用时写 DOM。
        if (frame.pose !== lastPoseDataset) {
          lastPoseDataset = frame.pose;
          host.dataset.avatarAutonomyPose = frame.pose;
        }
        if (debugFrameDatasets) host.dataset.avatarBlink = frame.blink.toFixed(3);

        vrm.scene.position.x = modelBasePositionX + frame.bodyX * avatarHeight * 0.004;
        vrm.scene.position.y = modelBasePositionY
          + breath * avatarHeight * 0.0015
          + frame.lift * avatarHeight * 0.08;
        vrm.scene.position.z = modelBasePositionZ + frame.lean * avatarHeight * 0.12;
        vrm.scene.rotation.y = headLocked
          ? modelBaseRotationY
          : modelBaseRotationY + frame.bodyX * 0.018 + frame.rotation;

        // Autonomy uses normalized tracker coordinates (horizontal, vertical,
        // roll). Convert them once here to humanoid Euler rotations.
        const headX = headLocked ? 0 : -frame.headY * 0.24;
        const headY = headLocked ? 0 : frame.headX * 0.3;
        const headZ = headLocked ? 0 : -frame.headZ * 0.18;
        setBone(vrm, VRMHumanBoneName.Head, headX, headY, headZ, headLocked ? 1 : blend);
        setBone(vrm, VRMHumanBoneName.Neck, headX * 0.25, headY * 0.22, headZ * 0.25, headLocked ? 1 : blend);
        setBone(vrm, VRMHumanBoneName.Chest, -frame.bodyY * 0.075 + breath * 0.003, frame.bodyX * 0.1, -frame.bodyZ * 0.06, blend * 0.65);
        setBone(vrm, VRMHumanBoneName.Spine, -frame.bodyY * 0.035 + breath * 0.0015, frame.bodyX * 0.04, -frame.bodyZ * 0.025, blend * 0.5);

        const accent = frame.speechAccent;
        const accentSide = frame.headX < 0 ? -1 : 1;
        let leftLift = speaking ? 0.07 + accent * (accentSide < 0 ? 0.15 : 0.08) : 0;
        let rightLift = speaking ? 0.06 + accent * (accentSide > 0 ? 0.15 : 0.08) : 0;
        let leftLowerX = speaking ? -0.11 - accent * 0.08 : -0.08;
        let rightLowerX = speaking ? -0.1 - accent * 0.07 : -0.08;
        let leftLowerZ = -0.06;
        let rightLowerZ = 0.06;
        if (gesture === 'explain' && speaking) {
          leftLift = 0.18 + accent * 0.2 * intensity;
          rightLift = 0.22 + accent * 0.24 * intensity;
          leftLowerX = -0.23 - accent * 0.08;
          rightLowerX = -0.22 - accent * 0.07;
          leftLowerZ = -0.42;
          rightLowerZ = 0.52;
        } else if (gesture === 'wave' && frame.gestureEnvelope > 0.01) {
          rightLift = 0.84 * frame.gestureEnvelope;
          rightLowerX = -0.25;
          rightLowerZ = 0.92 + Math.sin(t * 7.2) * 0.18 * frame.gestureEnvelope;
        } else if (gesture === 'shy' && frame.gestureEnvelope > 0.01) {
          leftLift = 0.36 * frame.gestureEnvelope;
          rightLift = 0.36 * frame.gestureEnvelope;
          leftLowerX = -0.32;
          rightLowerX = -0.32;
          leftLowerZ = -0.78;
          rightLowerZ = 0.78;
        }
        setBone(vrm, VRMHumanBoneName.LeftUpperArm, leftLift * 0.42, -0.06 + accent * 0.025, 1.08 - leftLift, blend);
        setBone(vrm, VRMHumanBoneName.RightUpperArm, rightLift * 0.36, 0.06 - accent * 0.022, -1.08 + rightLift, blend);
        setBone(vrm, VRMHumanBoneName.LeftLowerArm, leftLowerX, 0, leftLowerZ, blend);
        setBone(vrm, VRMHumanBoneName.RightLowerArm, rightLowerX, 0, rightLowerZ, blend);

        setBone(vrm, VRMHumanBoneName.LeftEye, -frame.eyeY * 0.14, frame.eyeX * 0.18, 0, Math.min(1, blend * 1.8));
        setBone(vrm, VRMHumanBoneName.RightEye, -frame.eyeY * 0.14, frame.eyeX * 0.18, 0, Math.min(1, blend * 1.8));

        const manager = vrm.expressionManager;
        if (manager) {
          manager.setValue(VRMExpressionPresetName.Blink, frame.blink);

          // 口型：优先用逐帧音频信号（开口度 + 元音倾向）；拿不到实时信号
          // （未配语音 / CORS 音频接不进 WebAudio）才退回节奏型假口型。
          const hasLiveSignal = !!lip?.active;
          const fallbackSpeech = 0.2 + Math.max(0, Math.sin(t * 12.2)) * 0.3 + Math.max(0, Math.sin(t * 7.7)) * 0.14;
          const mouth = speaking ? Math.min(0.9, hasLiveSignal ? lip.level : fallbackSpeech) : 0;
          const vowel = hasLiveSignal ? lip.vowel : (Math.sin(t * 8.1) + 1) * 0.5;
          manager.setValue(VRMExpressionPresetName.Aa, mouth * (0.6 + (1 - vowel) * 0.35));
          manager.setValue(VRMExpressionPresetName.Oh, speaking ? mouth * (1 - vowel) * 0.32 : 0);
          manager.setValue(VRMExpressionPresetName.Ee, speaking ? mouth * vowel * 0.38 : 0);

          if (currentPerformance !== lastPerformanceDirection) {
            lastPerformanceDirection = currentPerformance;
            performanceChangedAt = t;
          }
          const sincePerformance = t - performanceChangedAt;
          const activeExpression = emotionExpression(currentEmotion);
          const hold = speaking ? 0.4 + intensity * 0.26 : 0.2 + intensity * 0.16;
          const decay = speaking ? 1 : Math.exp(-Math.max(0, sincePerformance - 2.4) / 3);
          const expressionBlend = 1 - Math.exp(-delta * 4.2);
          EMOTION_PRESETS.forEach(name => {
            const target = name === activeExpression ? Math.min(0.72, hold * decay) : 0;
            const currentWeight = expressionWeights.get(name) ?? 0;
            const next = currentWeight + (target - currentWeight) * expressionBlend;
            expressionWeights.set(name, next);
            manager.setValue(name, next < 0.004 ? 0 : next);
          });

          // 微表情叠加层（face=wink,grin…）：独立于情绪预设，可任意组合。
          // 说话期间保持，说完停留片刻后衰减，与情绪包络同节奏。
          const faceSet = new Set(currentPerformance.faces || []);
          const faceHold = Math.min(1, 0.55 + intensity * 0.45) * (speaking ? 1 : Math.exp(-Math.max(0, sincePerformance - 2.8) / 2.6));
          const faceWeight = (key: string, active: boolean): number => {
            const target = active ? faceHold : 0;
            const currentWeight = expressionWeights.get(`face:${key}`) ?? 0;
            const next = currentWeight + (target - currentWeight) * expressionBlend;
            expressionWeights.set(`face:${key}`, next);
            return next < 0.004 ? 0 : next;
          };
          const winkWeight = faceWeight('wink', faceSet.has('wink'));
          const grinWeight = faceWeight('grin', faceSet.has('grin'));
          const poutWeight = faceWeight('pout', faceSet.has('pout'));
          const blushWeight = faceWeight('blush', faceSet.has('blush'));
          const eyesClosedWeight = faceWeight('eyes-closed', faceSet.has('eyes-closed'));
          const smileEyesWeight = faceWeight('smile-eyes', faceSet.has('smile-eyes'));
          const browUpWeight = faceWeight('brow-up', faceSet.has('brow-up'));
          const browSadWeight = faceWeight('brow-sad', faceSet.has('brow-sad'));
          const browAngryWeight = faceWeight('brow-angry', faceSet.has('brow-angry'));
          if (winkWeight) manager.setValue(VRMExpressionPresetName.BlinkRight, Math.max(frame.blink, winkWeight * 0.95));
          if (grinWeight) manager.setValue(VRMExpressionPresetName.Ih, grinWeight * 0.62);
          if (poutWeight) manager.setValue(VRMExpressionPresetName.Ou, poutWeight * 0.68);
          const eyelidClose = Math.max(eyesClosedWeight * 0.96, smileEyesWeight * 0.5);
          if (eyelidClose > frame.blink) manager.setValue(VRMExpressionPresetName.Blink, eyelidClose);
          // 眉眼系借情绪预设的部分权重表达；与情绪包络取 max，不互相压低。
          const boostPreset = (name: string, weight: number) => {
            if (weight > (expressionWeights.get(name) ?? 0)) manager.setValue(name, weight);
          };
          if (browUpWeight) boostPreset(VRMExpressionPresetName.Surprised, browUpWeight * 0.32);
          if (browSadWeight) boostPreset(VRMExpressionPresetName.Sad, browSadWeight * 0.36);
          if (browAngryWeight) boostPreset(VRMExpressionPresetName.Angry, browAngryWeight * 0.32);
          if (smileEyesWeight) boostPreset(VRMExpressionPresetName.Happy, smileEyesWeight * 0.24);
          // 脸红没有标准预设；模型带自定义 Blush/blush 表情时生效，没有就静默跳过。
          if (blushWeight) {
            manager.setValue('Blush', blushWeight);
            manager.setValue('blush', blushWeight);
          }

          // 模型自定义表情（星星眼/黑脸/蚊香眼…）：LLM 用 model_action 按名字点播，
          // 与 faces 同一套"说话保持→说完衰减"包络；指令切换时旧表情平滑淡出。
          if (customExpressionNames.length) {
            const activeAction = currentPerformance.modelAction;
            for (const name of customExpressionNames) {
              const target = name === activeAction ? faceHold * 0.9 : 0;
              const key = `custom:${name}`;
              const currentWeight = expressionWeights.get(key) ?? 0;
              const next = currentWeight + (target - currentWeight) * expressionBlend;
              expressionWeights.set(key, next);
              if (next > 0.004) manager.setValue(name, next);
              else if (currentWeight > 0.004) manager.setValue(name, 0);
            }
          }
        }

        const closeShot = currentPerformance.camera === 'close' || currentPerformance.camera === 'push-in';
        // 用户锚定过脸部时，特写镜头直接落到锚点构图——不再按"身高的 84%"
        // 这类启发式猜脸的位置（Q版/戴帽/比例特殊的模型会飘出画面）。
        const anchored = closeShot && anchorFraming ? anchorFraming : null;
        // Companion touches must not replace the user's desktop composition
        // with a one-size-fits-all full-body close-up. A saved face anchor is
        // the only close-shot position allowed on the always-on desktop.
        const suppressUnanchoredCloseShot = closeShot
          && ambientAutonomyDisabledRef.current
          && !anchored;
        const cameraZFactor = anchored
          ? 0.7
          : suppressUnanchoredCloseShot
            ? 0.7
          : closeShot
            ? 0.57
            : currentPerformance.camera === 'wide' || currentPerformance.camera === 'pull-out'
              ? 0.88
              : 0.7;
        // 各机位的取景高度差收窄（0.84/0.82/0.80）：小屏舞台上镜头切换
        // 引起的上下跳动要尽量轻，拉近拉远主要靠距离（Z）表达。
        const cameraYFactor = anchored
          ? 0.82
          : suppressUnanchoredCloseShot
            ? 0.82
          : closeShot
            ? 0.84
            : currentPerformance.camera === 'wide' || currentPerformance.camera === 'pull-out'
              ? 0.8
              : 0.82;
        // 用户构图叠加在导演机位之上：scale 缩短相机距离，offset 换算成
        // 目标距离处的世界坐标平移，保证拖拽时模型 1:1 跟手。
        const activeFraming = anchored || userFraming;
        const zoom = Math.max(0.4, Math.min(4.5, activeFraming.scale || 1));
        const cameraDistance = (avatarHeight * cameraZFactor) / zoom;
        const viewWorldHeight = 2 * Math.tan((camera.fov * Math.PI) / 360) * cameraDistance;
        const panX = activeFraming.offsetX * viewWorldHeight * camera.aspect;
        const panY = activeFraming.offsetY * viewWorldHeight;
        const cameraSpeed = currentPerformance.camera === 'push-in' || currentPerformance.camera === 'pull-out' ? 1.35 : 3.6;
        const cameraBlend = 1 - Math.exp(-delta * cameraSpeed);
        camera.position.x += ((frame.bodyX * avatarHeight * 0.004 - panX) - camera.position.x) * cameraBlend;
        camera.position.y += ((avatarHeight * cameraYFactor + panY) - camera.position.y) * cameraBlend;
        camera.position.z += (cameraDistance - camera.position.z) * cameraBlend;
        cameraLookY += ((avatarHeight * cameraYFactor + panY) - cameraLookY) * cameraBlend;
        camera.lookAt(-panX, cameraLookY, 0);

        vrm.update(delta);
      }

      renderer.render(scene, camera);
    };

    loader.load(
      modelUrl,
      gltf => {
        if (disposed) return;
        const vrm = gltf.userData.vrm as VRM | undefined;
        if (!vrm) {
          onLoadingChange?.(false);
          onError?.('这个文件是 glTF，但没有找到 VRM 人形数据。');
          return;
        }

        VRMUtils.removeUnnecessaryVertices(vrm.scene);
        VRMUtils.combineSkeletons(vrm.scene);
        VRMUtils.rotateVRM0(vrm);
        currentVrm = vrm;
        scene.add(vrm.scene);

        const box = new THREE.Box3().setFromObject(vrm.scene);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const height = Math.max(1, size.y);
        avatarHeight = height;
        vrm.scene.position.x -= center.x;
        vrm.scene.position.y -= box.min.y;
        vrm.scene.position.z -= center.z;
        modelBasePositionX = vrm.scene.position.x;
        modelBasePositionY = vrm.scene.position.y;
        modelBasePositionZ = vrm.scene.position.z;
        modelBaseRotationY = vrm.scene.rotation.y;

        camera.position.set(0, height * 0.82, height * 0.64);
        camera.lookAt(0, height * 0.82, 0);
        cameraLookY = height * 0.82;
        camera.near = Math.max(0.01, height * 0.01);
        camera.far = height * 12;
        camera.updateProjectionMatrix();

        // 枚举预设之外的自定义表情（星星眼/黑脸这类），回传给上层喂进
        // LLM 的 model_action 白名单。
        try {
          const customMap = (vrm.expressionManager as any)?.customExpressionMap;
          customExpressionNames = customMap ? Object.keys(customMap) : [];
          onExpressionsDiscoveredRef.current?.(customExpressionNames);
        } catch { /* 表情枚举失败不影响渲染 */ }

        onLoadingChange?.(false);
        onReadyRef.current?.();
      },
      undefined,
      error => {
        if (disposed) return;
        onLoadingChange?.(false);
        const message = error instanceof Error ? error.message : '模型解析失败';
        onError?.(message);
      },
    );

    animate();
    return () => {
      disposed = true;
      touchResolverRef.current = null;
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      host.removeEventListener('pointermove', handlePointerMove);
      host.removeEventListener('pointerleave', handlePointerLeave);
      if (currentVrm) {
        scene.remove(currentVrm.scene);
        VRMUtils.deepDispose(currentVrm.scene);
      }
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
  }, [modelUrl, onError, onLoadingChange, maxFps]);

  return <div ref={hostRef} className="absolute inset-0 touch-none" aria-label="VRM 角色舞台" />;
};

export default VRMAvatarCanvas;
