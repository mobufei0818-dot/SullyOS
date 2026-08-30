import { describe, expect, it } from 'vitest';
import type { CompanionStartupSettings, CompanionTouchSettings } from '../types';
import {
  activateCompanionStartupPreset,
  activateCompanionTouchPreset,
  collectCompanionVoiceAssetIds,
  saveCompanionStartupPreset,
  saveCompanionTouchPreset,
} from './companionPresets';

const emptySettings = (): CompanionTouchSettings => ({ enabledZones: ['head'], reactions: {} });

const performance = (emotion: 'happy' | 'neutral', gesture: 'wave' | 'idle') => ({
  emotion,
  gesture,
  camera: 'medium' as const,
  gaze: 'viewer' as const,
  intensity: 0.7,
});

const startup = (line: string, voiceAssetId: string): CompanionStartupSettings => ({
  enabled: true,
  line,
  performance: performance('happy', 'wave'),
  voiceAssetId,
});

describe('Live2D companion presets', () => {
  it('creates independent startup presets and restores the selected old preset', () => {
    const first = saveCompanionStartupPreset(emptySettings(), startup('早上好', 'companion-startup-voice:first'), '清晨', {
      now: 10,
      id: 'startup-a',
    });
    const second = saveCompanionStartupPreset(first.settings, startup('欢迎回来', 'companion-startup-voice:second'), '回家', {
      now: 20,
      id: 'startup-b',
    });

    expect(second.settings.startupPresets?.map(item => item.name)).toEqual(['清晨', '回家']);
    expect(second.settings.startupPresets?.[0].startup.voiceAssetId).toBe('companion-startup-voice:first');
    expect(second.settings.startup?.voiceAssetId).toBe('companion-startup-voice:second');

    const selected = activateCompanionStartupPreset(second.settings, 'startup-a');
    expect(selected.activeStartupPresetId).toBe('startup-a');
    expect(selected.startup?.line).toBe('早上好');
    expect(selected.startup?.voiceAssetId).toBe('companion-startup-voice:first');
  });

  it('creates independent touch packs and keeps every referenced Blob id discoverable for backup', () => {
    const first = saveCompanionTouchPreset(emptySettings(), {
      enabledZones: ['head'],
      reactions: { head: [{ id: 'a', text: '嗯？', performance: performance('neutral', 'idle'), voiceAssetId: 'companion-touch-voice:first' }] },
      voiceEnabled: true,
    }, '摸头', { now: 10, id: 'touch-a' });
    const second = saveCompanionTouchPreset(first.settings, {
      enabledZones: ['hand'],
      reactions: { hand: [{ id: 'b', text: '牵住了', performance: performance('happy', 'wave'), voiceAssetId: 'companion-touch-voice:second' }] },
      voiceEnabled: true,
    }, '牵手', { now: 20, id: 'touch-b' });

    expect(second.settings.touchPresets?.map(item => item.name)).toEqual(['摸头', '牵手']);
    const selected = activateCompanionTouchPreset(second.settings, 'touch-a');
    expect(selected.activeTouchPresetId).toBe('touch-a');
    expect(selected.enabledZones).toEqual(['head']);
    expect(selected.reactions.head?.[0].voiceAssetId).toBe('companion-touch-voice:first');
    expect([...collectCompanionVoiceAssetIds(second.settings)].sort()).toEqual([
      'companion-touch-voice:first',
      'companion-touch-voice:second',
    ]);
  });
});
