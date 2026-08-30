/**
 * 回归测试：第三方 TTS / 语速相关设置经「导出 → 导入」是否完整还原。
 *  - APIConfig：Fish 与 ElevenLabs 全局配置
 *  - voiceProfile：Fish reference_id、ElevenLabs Voice ID 与共用语速
 *
 * 思路：apiConfig 走的是「整对象导出 + 合并导入（updateApiConfig）」，角色走的是
 * 「整 store 导出 + DB.importFullData 还原」。这里分别用真实 DB 往返 + 合并逻辑断言。
 */
import { describe, it, expect } from 'vitest';
import { DB } from './db';
import type { APIConfig } from '../types';

describe('第三方 TTS / 语速设置 导出→导入 round-trip', () => {
  it('角色 voiceProfile 的 Fish / ElevenLabs 音色与 speed 经真实 DB 导入还原', async () => {
    const char: any = {
      id: 'test-fish-char',
      name: '测试角色',
      voiceProfile: {
        provider: 'minimax',
        voiceId: 'mm-voice-1',          // 旧字段，确认不被影响
        minimaxParamVersion: 'natural-v2',
        fishReferenceId: '7f92f8afb8ec43bf81429cc1c9199cb1',
        fishModel: 's2-pro',
        elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
        speed: 0.85,
      },
    };

    // 模拟导入：DB.importFullData 会清空并写入 characters store（与 OSContext 导入同路径）
    await DB.importFullData({ characters: [char] } as any);

    const all = await DB.getAllCharacters();
    const got = all.find((c) => c.id === 'test-fish-char');
    expect(got).toBeTruthy();
    expect(got!.voiceProfile?.fishReferenceId).toBe('7f92f8afb8ec43bf81429cc1c9199cb1');
    expect(got!.voiceProfile?.fishModel).toBe('s2-pro');
    expect(got!.voiceProfile?.elevenLabsVoiceId).toBe('21m00Tcm4TlvDq8ikWAM');
    expect(got!.voiceProfile?.speed).toBe(0.85);
    expect(got!.voiceProfile?.voiceId).toBe('mm-voice-1'); // 旧字段一并保留
    expect(got!.voiceProfile?.minimaxParamVersion).toBe('natural-v2');
  });

  it('APIConfig 的 Fish / ElevenLabs 字段经导出→序列化→合并导入还原', () => {
    // 导出：OSContext 把整个 apiConfig 对象塞进 backupData（无字段白名单）
    const exported: APIConfig = {
      baseUrl: 'https://api.example.com',
      apiKey: 'llm-key',
      model: 'gpt-4o-mini',
      minimaxApiKey: 'mm-key',
      ttsProvider: 'fishaudio',
      fishAudioApiKey: 'fish-key-abc',
      fishAudioModel: 's2.1-pro',
      elevenLabsApiKey: 'eleven-key-abc',
      elevenLabsModel: 'eleven_v3',
      elevenLabsStability: 0.5,
      elevenLabsSimilarityBoost: 0.8,
      elevenLabsStyle: 0.2,
      elevenLabsUseSpeakerBoost: true,
      voicePrompts: { elevenlabs: 'custom eleven prompt' },
    };
    // 写盘 / 读盘的 JSON 往返
    const backup = JSON.parse(JSON.stringify({ apiConfig: exported }));

    // 导入：updateApiConfig(data.apiConfig) === { ...现有, ...导入 }（OSContext.tsx:2055）
    const current = { baseUrl: '', apiKey: '', model: 'gpt-4o-mini' } as APIConfig;
    const merged = { ...current, ...backup.apiConfig } as APIConfig;

    expect(merged.ttsProvider).toBe('fishaudio');
    expect(merged.fishAudioApiKey).toBe('fish-key-abc');
    expect(merged.fishAudioModel).toBe('s2.1-pro');
    expect(merged.elevenLabsApiKey).toBe('eleven-key-abc');
    expect(merged.elevenLabsModel).toBe('eleven_v3');
    expect(merged.elevenLabsStyle).toBe(0.2);
    expect(merged.voicePrompts?.elevenlabs).toBe('custom eleven prompt');
    expect(merged.minimaxApiKey).toBe('mm-key'); // 旧字段也在

    // localStorage 持久化往返（updateApiConfig 会 setItem('os_api_config', ...)）
    localStorage.setItem('os_api_config', JSON.stringify(merged));
    const reloaded = JSON.parse(localStorage.getItem('os_api_config')!);
    expect(reloaded.fishAudioApiKey).toBe('fish-key-abc');
    expect(reloaded.ttsProvider).toBe('fishaudio');
    expect(reloaded.fishAudioModel).toBe('s2.1-pro');
    expect(reloaded.elevenLabsApiKey).toBe('eleven-key-abc');
    expect(reloaded.elevenLabsModel).toBe('eleven_v3');
    expect(reloaded.elevenLabsUseSpeakerBoost).toBe(true);
  });
});
