import { describe, expect, it } from 'vitest';
import {
  combineLive2DMouthForm,
  live2DMouthFormFromVowel,
  resolveLive2DMouthFrame,
  splitLive2DLipSyncParameters,
} from './live2dLipSync';

describe('Live2D lip-sync parameter roles', () => {
  it('keeps MouthOpenY on amplitude and MouthForm on vowel shape', () => {
    expect(splitLive2DLipSyncParameters(['ParamMouthOpenY', 'ParamMouthForm'])).toEqual({
      mouthOpen: ['ParamMouthOpenY'],
      mouthForm: ['ParamMouthForm'],
    });
  });

  it('falls back to the standard opening parameter without inventing a form parameter', () => {
    expect(splitLive2DLipSyncParameters([])).toEqual({
      mouthOpen: ['ParamMouthOpenY'],
      mouthForm: [],
    });
  });
});

describe('Live2D mouth frame', () => {
  it('uses audio level only for opening and vowel only for form', () => {
    const round = resolveLive2DMouthFrame(true, { active: true, level: 0.4, vowel: 0.1 }, 0);
    const wide = resolveLive2DMouthFrame(true, { active: true, level: 0.4, vowel: 0.9 }, 0);

    expect(round.open).toBe(wide.open);
    expect(round.form).toBeLessThan(0);
    expect(wide.form).toBeGreaterThan(0);
  });

  it('changes vowel form slowly even when realtime analysis is unavailable', () => {
    const first = resolveLive2DMouthFrame(true, undefined, 0);
    const later = resolveLive2DMouthFrame(true, undefined, 1.2);

    expect(first.source).toBe('synthetic');
    expect(later.source).toBe('synthetic');
    expect(later.form).not.toBeCloseTo(first.form, 3);
    expect(first.form).toBeGreaterThanOrEqual(-1);
    expect(first.form).toBeLessThanOrEqual(1);
  });

  it('returns a neutral closed mouth while idle', () => {
    expect(resolveLive2DMouthFrame(false, { active: true, level: 1, vowel: 1 }, 2)).toEqual({
      open: 0,
      form: 0,
      source: 'idle',
    });
  });

  it('adds expression form to the vowel instead of replacing either layer', () => {
    expect(live2DMouthFormFromVowel(0.7)).toBeCloseTo(0.4);
    expect(combineLive2DMouthForm(0.4, 0.25)).toBeCloseTo(0.65);
    expect(combineLive2DMouthForm(0.8, 0.8)).toBe(1);
  });
});
