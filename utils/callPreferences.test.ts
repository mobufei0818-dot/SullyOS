import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CALL_UPDATE_ANNOUNCEMENT_KEY,
  DEFAULT_CALL_PREFERENCES,
  markCallUpdateAnnouncementSeen,
  parseCallPreferences,
  shouldShowCallUpdateAnnouncement,
} from './callPreferences';

afterEach(() => vi.unstubAllGlobals());

describe('call preferences', () => {
  it('keeps voice/opening defaults on but makes idle follow-ups opt-in', () => {
    expect(parseCallPreferences(null)).toEqual(DEFAULT_CALL_PREFERENCES);
    expect(parseCallPreferences('{broken')).toEqual(DEFAULT_CALL_PREFERENCES);
  });

  it('persists all three preferences independently and migrates old storage safely', () => {
    expect(parseCallPreferences(JSON.stringify({ characterInitiative: false }))).toEqual({
      characterInitiative: false,
      voiceAutoPlay: true,
      idleNudgeEnabled: false,
    });
    expect(parseCallPreferences(JSON.stringify({ voiceAutoPlay: false }))).toEqual({
      characterInitiative: true,
      voiceAutoPlay: false,
      idleNudgeEnabled: false,
    });
    expect(parseCallPreferences(JSON.stringify({ idleNudgeEnabled: true }))).toEqual({
      characterInitiative: true,
      voiceAutoPlay: true,
      idleNudgeEnabled: true,
    });
  });

  it('shows the call update once and remembers acknowledgement', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });

    expect(shouldShowCallUpdateAnnouncement()).toBe(true);
    markCallUpdateAnnouncementSeen();
    expect(values.get(CALL_UPDATE_ANNOUNCEMENT_KEY)).toBe('seen');
    expect(shouldShowCallUpdateAnnouncement()).toBe(false);
  });
});
