import { describe, expect, it } from 'vitest';
import { describeMomentsLocalTime, findImpossibleMomentsTimeClaim, MOMENTS_TASK_UPSERT_SQL, nextMomentsDecisionAt, shouldRunMomentsCron } from './index';

describe('moments offline schedule', () => {
  it('accepts both task primary-key and idempotency-key replays', () => {
    expect(MOMENTS_TASK_UPSERT_SQL).toContain('ON CONFLICT DO UPDATE');
    expect(MOMENTS_TASK_UPSERT_SQL).not.toContain('ON CONFLICT(idempotency_key)');
  });

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

  it('gives the model an explicit device-local wall clock', () => {
    const clock = describeMomentsLocalTime(Date.UTC(2026, 8, 2, 4, 4, 0), 480);
    expect(clock.localDateTime).toBe('2026-09-02 12:04:00');
    expect(clock.weekday).toBe('星期三');
    expect(clock.timezone).toBe('UTC+08:00');
  });

  it('uses each character IANA timezone instead of forcing the user timezone', () => {
    const instant = Date.UTC(2026, 8, 2, 4, 4, 0);
    expect(describeMomentsLocalTime(instant, 'America/New_York').localDateTime).toBe('2026-09-02 00:04:00');
    expect(describeMomentsLocalTime(instant, 'Asia/Tokyo').localDateTime).toBe('2026-09-02 13:04:00');

    const next = nextMomentsDecisionAt('foreign-actor', 'high', instant, 'America/New_York');
    const localHour = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
    }).format(new Date(next)));
    expect(localHour).toBeGreaterThanOrEqual(8);
    expect(localHour).toBeLessThan(23);
  });

  it('rejects a future clock written as if it has already happened', () => {
    const current = Date.UTC(2026, 8, 2, 4, 4, 0); // UTC+8 12:04
    expect(findImpossibleMomentsTimeClaim('下午四点半，靠咖啡把魂拽回工位。', current, 480)).toContain('下午四点半');
    expect(findImpossibleMomentsTimeClaim('16:30，靠咖啡把魂拽回工位。', current, 480)).toContain('16:30');
    expect(findImpossibleMomentsTimeClaim('上午十一点半，咖啡终于送到了。', current, 480)).toBeNull();
  });

  it('still allows an explicitly stated future plan', () => {
    const current = Date.UTC(2026, 8, 2, 4, 4, 0); // UTC+8 12:04
    expect(findImpossibleMomentsTimeClaim('计划下午四点半去开会，先把材料理完。', current, 480)).toBeNull();
    expect(findImpossibleMomentsTimeClaim('昨天下午四点半的那杯咖啡太苦了。', current, 480)).toBeNull();
  });
});
