import { describe, expect, it } from 'vitest';
import { nextMomentsDecisionAt, shouldRunMomentsCron } from './index';

describe('moments offline schedule', () => {
  it('only enters the Moments database path every fifteen minutes', () => {
    const base = Date.UTC(2026, 8, 2, 0, 0, 0);
    expect(shouldRunMomentsCron(base)).toBe(true);
    expect(shouldRunMomentsCron(base + 14 * 60_000)).toBe(false);
    expect(shouldRunMomentsCron(base + 15 * 60_000)).toBe(true);
    expect(shouldRunMomentsCron(base + 59 * 60_000)).toBe(false);
  });

  it('does not schedule disabled or view-only actors', () => {
    const from = Date.UTC(2026, 8, 2, 0, 0, 0);
    expect(nextMomentsDecisionAt('actor-a', 'off', from, 480)).toBe(0);
    expect(nextMomentsDecisionAt('actor-a', 'view_only', from, 480)).toBe(0);
  });

  it('schedules enabled actors in a future life window', () => {
    const from = Date.UTC(2026, 8, 2, 0, 0, 0);
    const next = nextMomentsDecisionAt('actor-a', 'high', from, 480);
    expect(next).toBeGreaterThan(from + 5 * 60_000);
    const localHour = new Date(next + 480 * 60_000).getUTCHours();
    expect(localHour).toBeGreaterThanOrEqual(8);
    expect(localHour).toBeLessThan(23);
  });

  it('low frequency skips non-candidate days instead of calling the model daily', () => {
    const from = Date.UTC(2026, 8, 2, 15, 30, 0); // UTC+8 23:30, today window is over
    const next = nextMomentsDecisionAt('stable-low-actor', 'low', from, 480);
    expect(next).toBeGreaterThan(from + 5 * 60_000);
    const localHour = new Date(next + 480 * 60_000).getUTCHours();
    expect(localHour).toBeGreaterThanOrEqual(9);
    expect(localHour).toBeLessThan(22);
  });
});
