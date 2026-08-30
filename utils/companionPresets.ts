import type {
  CharacterProfile,
  CompanionStartupPreset,
  CompanionStartupSettings,
  CompanionTouchPreset,
  CompanionTouchReaction,
  CompanionTouchSettings,
  CompanionTouchZone,
} from '../types';

type TouchSnapshot = Pick<
  CompanionTouchSettings,
  'enabledZones' | 'reactions' | 'voiceLanguage' | 'voiceEnabled' | 'voiceGeneratedCount' | 'generatedAt'
>;

const cloneJson = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const makePresetId = (kind: 'startup' | 'touch', now: number): string => {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 12);
  return `companion-${kind}-preset:${now.toString(36)}:${random}`;
};

const presetName = (name: string, fallback: string): string => name.trim().slice(0, 40) || fallback;

export function saveCompanionStartupPreset(
  settings: CompanionTouchSettings,
  startup: CompanionStartupSettings,
  name: string,
  options: { now?: number; id?: string } = {},
): { settings: CompanionTouchSettings; preset: CompanionStartupPreset } {
  const now = options.now ?? Date.now();
  const presets = settings.startupPresets || [];
  const preset: CompanionStartupPreset = {
    id: options.id || makePresetId('startup', now),
    name: presetName(name, `开机演出 ${presets.length + 1}`),
    startup: cloneJson(startup),
    createdAt: now,
    updatedAt: now,
  };
  return {
    preset,
    settings: {
      ...settings,
      startup: cloneJson(startup),
      startupPresets: [...presets, preset],
      activeStartupPresetId: preset.id,
    },
  };
}

export function activateCompanionStartupPreset(
  settings: CompanionTouchSettings,
  presetId: string,
): CompanionTouchSettings {
  const preset = settings.startupPresets?.find(item => item.id === presetId);
  if (!preset) return settings;
  return {
    ...settings,
    startup: cloneJson(preset.startup),
    activeStartupPresetId: preset.id,
  };
}

export function saveCompanionTouchPreset(
  settings: CompanionTouchSettings,
  snapshot: TouchSnapshot,
  name: string,
  options: { now?: number; id?: string } = {},
): { settings: CompanionTouchSettings; preset: CompanionTouchPreset } {
  const now = options.now ?? Date.now();
  const presets = settings.touchPresets || [];
  const preset: CompanionTouchPreset = {
    id: options.id || makePresetId('touch', now),
    name: presetName(name, `触摸反馈 ${presets.length + 1}`),
    enabledZones: [...snapshot.enabledZones],
    reactions: cloneJson(snapshot.reactions),
    voiceLanguage: snapshot.voiceLanguage,
    voiceEnabled: snapshot.voiceEnabled,
    voiceGeneratedCount: snapshot.voiceGeneratedCount,
    generatedAt: snapshot.generatedAt,
    createdAt: now,
    updatedAt: now,
  };
  return {
    preset,
    settings: {
      ...settings,
      ...cloneJson(snapshot),
      touchPresets: [...presets, preset],
      activeTouchPresetId: preset.id,
    },
  };
}

export function activateCompanionTouchPreset(
  settings: CompanionTouchSettings,
  presetId: string,
): CompanionTouchSettings {
  const preset = settings.touchPresets?.find(item => item.id === presetId);
  if (!preset) return settings;
  return {
    ...settings,
    enabledZones: [...preset.enabledZones],
    reactions: cloneJson(preset.reactions),
    voiceLanguage: preset.voiceLanguage,
    voiceEnabled: preset.voiceEnabled,
    voiceGeneratedCount: preset.voiceGeneratedCount,
    generatedAt: preset.generatedAt,
    activeTouchPresetId: preset.id,
  };
}

export const removeCompanionStartupPreset = (
  settings: CompanionTouchSettings,
  presetId: string,
): CompanionTouchSettings => ({
  ...settings,
  startupPresets: (settings.startupPresets || []).filter(item => item.id !== presetId),
  activeStartupPresetId: settings.activeStartupPresetId === presetId ? undefined : settings.activeStartupPresetId,
});

export const removeCompanionTouchPreset = (
  settings: CompanionTouchSettings,
  presetId: string,
): CompanionTouchSettings => ({
  ...settings,
  touchPresets: (settings.touchPresets || []).filter(item => item.id !== presetId),
  activeTouchPresetId: settings.activeTouchPresetId === presetId ? undefined : settings.activeTouchPresetId,
});

const collectReactionVoiceIds = (
  reactions: Partial<Record<CompanionTouchZone, CompanionTouchReaction[]>> | undefined,
  ids: Set<string>,
) => {
  Object.values(reactions || {}).forEach(items => items?.forEach(item => {
    if (item.voiceAssetId) ids.add(item.voiceAssetId);
  }));
};

export function collectCompanionVoiceAssetIds(settings?: CompanionTouchSettings | null): Set<string> {
  const ids = new Set<string>();
  if (!settings) return ids;
  if (settings.startup?.voiceAssetId) ids.add(settings.startup.voiceAssetId);
  collectReactionVoiceIds(settings.reactions, ids);
  settings.startupPresets?.forEach(preset => {
    if (preset.startup.voiceAssetId) ids.add(preset.startup.voiceAssetId);
  });
  settings.touchPresets?.forEach(preset => collectReactionVoiceIds(preset.reactions, ids));
  return ids;
}

export const collectCharacterCompanionVoiceAssetIds = (characters: CharacterProfile[]): Set<string> => {
  const ids = new Set<string>();
  characters.forEach(character => {
    collectCompanionVoiceAssetIds(character.companionTouchSettings).forEach(id => ids.add(id));
  });
  return ids;
};
