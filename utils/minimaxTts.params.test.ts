import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../types';
import {
  buildMiniMaxTtsCacheKey,
  buildMiniMaxTtsPayload,
  getMiniMaxParamVersion,
  normalizeMiniMaxLanguageBoost,
} from './minimaxTts';

const profile = (overrides: Partial<NonNullable<CharacterProfile['voiceProfile']>> = {}) => ({
  voiceId: 'voice-clone-1',
  model: 'speech-2.8-hd',
  speed: 1.8,
  vol: 1,
  pitch: 11,
  voiceModify: { pitch: 80, intensity: 60, timbre: -75 },
  ...overrides,
});

describe('MiniMax parameter versions', () => {
  it('keeps missing versions on the exact legacy request path', () => {
    const vp = profile();
    const payload = buildMiniMaxTtsPayload('你好，回来啦。', vp, { languageBoost: 'ja' });

    expect(getMiniMaxParamVersion(vp)).toBe('legacy');
    expect(payload.text).toContain('<#');
    expect(payload.voice_setting.speed).toBe(1.4);
    expect(payload.voice_setting.pitch).toBe(8);
    expect(payload.voice_setting.english_normalization).toBe(true);
    expect(payload.language_boost).toBe('ja');
    expect(payload.audio_setting).toEqual({ format: 'mp3' });
    expect(payload.output_format).toBeUndefined();
    expect(payload.voice_modify.intensity).not.toBe(60);
  });

  it('uses one natural request shape without forced punctuation pauses', () => {
    const vp = profile({
      minimaxParamVersion: 'natural-v2',
      emotion: 'calm',
    });
    const payload = buildMiniMaxTtsPayload('你好，回来啦。', vp, {
      languageBoost: 'ja',
      emotion: 'angry',
    });

    expect(payload.text).toBe('你好，回来啦。');
    expect(payload.text).not.toContain('<#');
    expect(payload.stream).toBe(false);
    expect(payload.output_format).toBe('url');
    expect(payload.audio_setting).toEqual({ format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 });
    expect(payload.language_boost).toBe('Japanese');
    expect(payload.voice_setting).toMatchObject({ speed: 1.8, pitch: 11, emotion: 'calm' });
    expect(payload.voice_setting.english_normalization).toBeUndefined();
    expect(payload.voice_modify).toEqual({ pitch: 80, intensity: 60, timbre: -75 });
  });

  it('uses dynamic emotion only when the character leaves emotion on auto', () => {
    const payload = buildMiniMaxTtsPayload('测试', profile({
      minimaxParamVersion: 'natural-v2',
      emotion: undefined,
    }), { emotion: 'happy' });
    expect(payload.voice_setting.emotion).toBe('happy');
  });

  it('maps project language codes to official MiniMax values', () => {
    expect(normalizeMiniMaxLanguageBoost('en')).toBe('English');
    expect(normalizeMiniMaxLanguageBoost('ko')).toBe('Korean');
    expect(normalizeMiniMaxLanguageBoost('yue')).toBe('Chinese,Yue');
    expect(normalizeMiniMaxLanguageBoost('French')).toBe('French');
  });

  it('uses the official Cantonese enum on both parameter versions', () => {
    expect(buildMiniMaxTtsPayload('今日去饮茶。', profile(), { languageBoost: 'yue' }).language_boost).toBe('Chinese,Yue');
    expect(buildMiniMaxTtsPayload('今日去饮茶。', profile({ minimaxParamVersion: 'natural-v2' }), { languageBoost: 'yue' }).language_boost).toBe('Chinese,Yue');
  });

  it('separates natural-v2 audio from legacy cache entries', () => {
    const payload = { text: '相同文本', model: 'speech-2.8-hd', voice_setting: { voice_id: 'v1' }, audio_setting: { format: 'mp3' } };
    expect(buildMiniMaxTtsCacheKey(payload, 'natural-v2')).not.toBe(buildMiniMaxTtsCacheKey(payload, 'legacy'));
  });
});
