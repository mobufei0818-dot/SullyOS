import type { LipSyncFrame } from './callAudioFeed';

export const DEFAULT_LIVE2D_MOUTH_OPEN_PARAMETER = 'ParamMouthOpenY';
export const DEFAULT_LIVE2D_MOUTH_FORM_PARAMETER = 'ParamMouthForm';

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const clampSigned = (value: number): number => Math.max(-1, Math.min(1, value));

export interface Live2DLipSyncParameters {
  mouthOpen: string[];
  mouthForm: string[];
}

/**
 * Cubism's standard mouth parameters carry different signals:
 * MouthOpenY is amplitude, while MouthForm is the round-to-wide vowel axis.
 * Some models put both in the LipSync group, so they must never be driven by
 * the same scalar.
 */
export const splitLive2DLipSyncParameters = (parameterIds: string[]): Live2DLipSyncParameters => {
  const source = parameterIds.length ? [...new Set(parameterIds)] : [DEFAULT_LIVE2D_MOUTH_OPEN_PARAMETER];
  return source.reduce<Live2DLipSyncParameters>((result, id) => {
    if (/mouth.*form/i.test(id)) result.mouthForm.push(id);
    else result.mouthOpen.push(id);
    return result;
  }, { mouthOpen: [], mouthForm: [] });
};

/** 0 = round/Oh side, 1 = wide/Ee side, mapped onto Cubism's -1..1 MouthForm axis. */
export const live2DMouthFormFromVowel = (vowel: number): number => (
  clampSigned(clamp01(Number.isFinite(vowel) ? vowel : 0.5) * 2 - 1)
);

/** Expression smile/pout stays an independent additive layer over the vowel shape. */
export const combineLive2DMouthForm = (vowelForm: number, expressionForm: number): number => (
  clampSigned(vowelForm + expressionForm)
);

const syntheticVowelAt = (seconds: number): number => clamp01(
  0.5
  + Math.sin(seconds * 1.75 + 0.4) * 0.32
  + Math.sin(seconds * 0.63 + 1.2) * 0.12,
);

export interface Live2DMouthFrame {
  open: number;
  form: number;
  source: 'idle' | 'audio' | 'synthetic';
}

/** Resolve one frame without mixing expression state; the renderer adds that separately. */
export const resolveLive2DMouthFrame = (
  speaking: boolean,
  lip: LipSyncFrame | undefined,
  seconds: number,
): Live2DMouthFrame => {
  if (!speaking) return { open: 0, form: 0, source: 'idle' };

  if (lip?.active) {
    return {
      open: clamp01(lip.level * 1.1),
      form: live2DMouthFormFromVowel(lip.vowel),
      source: 'audio',
    };
  }

  // No analyser signal (not configured, CORS, or native iOS audio): keep the
  // existing speech rhythm for opening, and add a slower independent vowel
  // drift so a rig with MouthForm does more than flap open and shut.
  const rhythm = clamp01(0.16 + Math.sin(seconds * 13.1) * 0.35 + Math.sin(seconds * 21.7 + 0.8) * 0.2);
  const phraseGate = Math.sin(seconds * 3.15) > -0.72 ? 1 : 0.08;
  return {
    open: Math.min(0.82, rhythm) * phraseGate,
    form: live2DMouthFormFromVowel(syntheticVowelAt(seconds)),
    source: 'synthetic',
  };
};
