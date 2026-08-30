import { describe, expect, it } from 'vitest';
import type { APIConfig, CharacterProfile } from '../types';
import {
  buildElevenLabsRequestBody,
  cleanTextForTtsElevenLabs,
  getElevenLabsVoiceActingGuide,
  normalizeElevenLabsVoiceId,
  stripElevenLabsMarkupForDisplay,
} from './elevenLabsTts';
import { normalizeTtsProvider } from './ttsProvider';

const character = {
  id: 'char-1',
  name: '测试角色',
  avatar: '',
  description: '',
  systemPrompt: '',
  memories: [],
  voiceProfile: {
    elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
    speed: 1.1,
  },
} as CharacterProfile;

describe('ElevenLabs voice id', () => {
  it('accepts a raw id and extracts ids from common links', () => {
    expect(normalizeElevenLabsVoiceId('21m00Tcm4TlvDq8ikWAM')).toBe('21m00Tcm4TlvDq8ikWAM');
    expect(normalizeElevenLabsVoiceId('https://elevenlabs.io/app/voice-library?voiceId=21m00Tcm4TlvDq8ikWAM'))
      .toBe('21m00Tcm4TlvDq8ikWAM');
    expect(normalizeElevenLabsVoiceId('https://elevenlabs.io/app/voice-library/21m00Tcm4TlvDq8ikWAM'))
      .toBe('21m00Tcm4TlvDq8ikWAM');
    expect(normalizeElevenLabsVoiceId('https://elevenlabs.io/app/settings')).toBe('');
  });
});

describe('ElevenLabs text cleanup', () => {
  it('keeps supported v3 tags and converts known parenthesized cues', () => {
    expect(cleanTextForTtsElevenLabs('<语音>[laughs] 你好 (sigh)</语音>', 'eleven_v3'))
      .toBe('[laughs] 你好 [sighs]');
  });

  it('removes performance tags for non-v3 models so they are not spoken aloud', () => {
    const output = cleanTextForTtsElevenLabs('[laughs] 你好 (sighs)（看向窗外）', 'eleven_flash_v2_5');
    expect(output).toBe('你好');
  });

  it('removes cues only from display text and preserves ordinary brackets', () => {
    expect(stripElevenLabsMarkupForDisplay('[whispers] 小声说 [第2章]')).toBe('小声说 [第2章]');
  });
});

describe('ElevenLabs request body', () => {
  it('uses global voice settings, role speed and ISO language code', () => {
    const config: APIConfig = {
      baseUrl: '',
      apiKey: '',
      model: '',
      elevenLabsModel: 'eleven_flash_v2_5',
      elevenLabsStability: 0.35,
      elevenLabsSimilarityBoost: 1.5,
      elevenLabsStyle: -1,
      elevenLabsUseSpeakerBoost: true,
    };
    const body = buildElevenLabsRequestBody('你好', character, config, { languageBoost: 'JA' });
    expect(body).toMatchObject({
      text: '你好',
      model_id: 'eleven_flash_v2_5',
      language_code: 'ja',
      voice_settings: {
        stability: 0.35,
        similarity_boost: 1,
        style: 0,
        speed: 1.1,
        use_speaker_boost: true,
      },
    });
  });

  it('snaps v3 stability to supported tiers and adds an emotion cue once', () => {
    const config = {
      baseUrl: '', apiKey: '', model: '',
      elevenLabsModel: 'eleven_v3',
      elevenLabsStability: 0.76,
    } as APIConfig;
    const body = buildElevenLabsRequestBody('真的？', character, config, { emotion: 'surprised' });
    expect(body.voice_settings.stability).toBe(1);
    expect(body.text).toBe('[curious] 真的？');
  });
});

describe('ElevenLabs prompt and provider routing', () => {
  it('uses audio-tag guidance only for v3 and recognizes the provider', () => {
    expect(getElevenLabsVoiceActingGuide('eleven_v3')).toContain('Audio Tags');
    expect(getElevenLabsVoiceActingGuide('eleven_flash_v2_5')).toContain('不要输出方括号');
    expect(normalizeTtsProvider('elevenlabs')).toBe('elevenlabs');
  });
});
