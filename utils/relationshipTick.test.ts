import { describe, expect, it } from 'vitest';
import { resolveRelationshipNextTickAt } from './relationshipTick';

describe('resolveRelationshipNextTickAt', () => {
  it('does not let page sync push a future tick later', () => {
    expect(resolveRelationshipNextTickAt(1_000, 2_000, false)).toBe(1_000);
  });

  it('keeps an overdue tick due until Cron really processes it', () => {
    expect(resolveRelationshipNextTickAt(1_000, 20_000, false)).toBe(1_000);
  });

  it('still lets an urgent event bring the tick earlier', () => {
    expect(resolveRelationshipNextTickAt(20_000, 1_000, false)).toBe(1_000);
  });

  it('allows a completed Cron tick to advance the cursor', () => {
    expect(resolveRelationshipNextTickAt(1_000, 20_000, true)).toBe(20_000);
  });
});
