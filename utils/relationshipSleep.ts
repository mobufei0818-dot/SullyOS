import type { DailySchedule } from '../types';

export interface RelationshipSleepWindow {
  startMinute: number;
  endMinute: number;
}

const MINUTES_PER_DAY = 24 * 60;
const SLEEP_ACTIVITY_RE = /(?:睡觉|睡眠|入睡|就寝|补觉|午睡|小睡|睡午觉|夜眠|安睡)/u;

const parseClockMinute = (value?: string): number | null => {
  const matched = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!matched) return null;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
};

export const normalizeRelationshipSleepWindows = (windows?: RelationshipSleepWindow[]): RelationshipSleepWindow[] => {
  if (!Array.isArray(windows)) return [];
  const seen = new Set<string>();
  return windows.flatMap(window => {
    const startMinute = Math.round(Number(window?.startMinute));
    const endMinute = Math.round(Number(window?.endMinute));
    if (!Number.isFinite(startMinute) || !Number.isFinite(endMinute)
      || startMinute < 0 || startMinute >= MINUTES_PER_DAY
      || endMinute < 0 || endMinute >= MINUTES_PER_DAY
      || startMinute === endMinute) return [];
    const key = `${startMinute}:${endMinute}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ startMinute, endMinute }];
  });
};

/** 把当天日程中明确写着睡眠的槽位，延伸到下一条日程的开始时间。 */
export const deriveRelationshipSleepWindows = (schedule?: DailySchedule | null): RelationshipSleepWindow[] => {
  const slots = (schedule?.slots || [])
    .map(slot => ({
      minute: parseClockMinute(slot.startTime),
      text: `${slot.activity || ''} ${slot.description || ''} ${slot.emoji || ''}`,
    }))
    .filter((slot): slot is { minute: number; text: string } => slot.minute !== null)
    .sort((a, b) => a.minute - b.minute);
  if (slots.length < 2) return [];
  return normalizeRelationshipSleepWindows(slots.flatMap((slot, index) => {
    if (!SLEEP_ACTIVITY_RE.test(slot.text)) return [];
    const next = slots[(index + 1) % slots.length];
    return [{ startMinute: slot.minute, endMinute: next.minute }];
  }));
};

export const relationshipSleepWindowFromClocks = (start?: string, end?: string): RelationshipSleepWindow[] => {
  const startMinute = parseClockMinute(start);
  const endMinute = parseClockMinute(end);
  return startMinute === null || endMinute === null
    ? []
    : normalizeRelationshipSleepWindows([{ startMinute, endMinute }]);
};

export const isMinuteInRelationshipSleep = (minute: number, windows?: RelationshipSleepWindow[]): boolean =>
  normalizeRelationshipSleepWindows(windows).some(window => window.startMinute < window.endMinute
    ? minute >= window.startMinute && minute < window.endMinute
    : minute >= window.startMinute || minute < window.endMinute);

/**
 * 计算一段现实时间里的清醒毫秒数。按一分钟小段读取角色当地时间，跨夜和跨时区都适用；
 * maxAwakeMs 让首次迁移的超长历史也在达到 100 所需的清醒时长后立即停止扫描。
 */
export const awakeRelationshipElapsedMs = (
  startMs: number,
  endMs: number,
  tzId: string,
  windows?: RelationshipSleepWindow[],
  maxAwakeMs = Number.POSITIVE_INFINITY,
): number => {
  const start = Number(startMs);
  const end = Number(endMs);
  const maximum = Math.max(0, Number(maxAwakeMs));
  const normalized = normalizeRelationshipSleepWindows(windows);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || maximum <= 0) return 0;
  if (!normalized.length) return Math.min(end - start, maximum);

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tzId || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
  }

  let cursor = start;
  let awake = 0;
  while (cursor < end && awake < maximum) {
    const chunk = Math.min(60_000, end - cursor);
    const parts = formatter.formatToParts(new Date(cursor + chunk / 2));
    const hour = Number(parts.find(part => part.type === 'hour')?.value || 0);
    const minute = Number(parts.find(part => part.type === 'minute')?.value || 0);
    if (!isMinuteInRelationshipSleep(hour * 60 + minute, normalized)) awake += chunk;
    cursor += chunk;
  }
  return Math.min(awake, maximum);
};
