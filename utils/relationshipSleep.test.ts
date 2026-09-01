import { describe, expect, it } from 'vitest';
import {
  awakeRelationshipElapsedMs,
  deriveRelationshipSleepWindows,
  relationshipSleepWindowFromClocks,
} from './relationshipSleep';

describe('relationship sleep windows', () => {
  it('derives overnight sleep and daytime nap from the role schedule', () => {
    const windows = deriveRelationshipSleepWindows({
      id: 'char_2026-09-02', charId: 'char', date: '2026-09-02', generatedAt: 1,
      slots: [
        { startTime: '08:00', activity: '起床' },
        { startTime: '13:00', activity: '午睡' },
        { startTime: '14:00', activity: '工作' },
        { startTime: '23:30', activity: '睡觉' },
      ],
    });
    expect(windows).toEqual([
      { startMinute: 13 * 60, endMinute: 14 * 60 },
      { startMinute: 23 * 60 + 30, endMinute: 8 * 60 },
    ]);
  });

  it('counts only awake time across an overnight window', () => {
    const start = Date.parse('2026-09-01T14:00:00.000Z'); // 上海 22:00
    const end = Date.parse('2026-09-02T01:00:00.000Z'); // 上海 09:00
    const elapsed = awakeRelationshipElapsedMs(
      start,
      end,
      'Asia/Shanghai',
      relationshipSleepWindowFromClocks('23:30', '08:00'),
    );
    expect(elapsed).toBe(2.5 * 60 * 60_000);
  });

  it('does not add longing while the entire interval is asleep', () => {
    const start = Date.parse('2026-09-01T16:00:00.000Z'); // 上海 00:00
    const end = Date.parse('2026-09-01T23:00:00.000Z'); // 上海 07:00
    expect(awakeRelationshipElapsedMs(
      start,
      end,
      'Asia/Shanghai',
      relationshipSleepWindowFromClocks('23:30', '08:00'),
    )).toBe(0);
  });
});
