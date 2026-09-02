import { describe, expect, it } from 'vitest';
import { settleRelationshipLongingAfterSent } from './relationshipEngine';

describe('settleRelationshipLongingAfterSent', () => {
  it('starts a new frequency cycle only after a delivered message at 100/100', () => {
    expect(settleRelationshipLongingAfterSent(100, 100, 8)).toEqual({
      longing: 0,
      nextThreshold: 30,
      cycled: true,
    });
  });

  it('keeps the existing relief and plus-30 threshold before saturation', () => {
    expect(settleRelationshipLongingAfterSent(74, 74, 8)).toEqual({
      longing: 66,
      nextThreshold: 96,
      cycled: false,
    });
  });

  it('does not reset merely because the threshold is capped at 100', () => {
    expect(settleRelationshipLongingAfterSent(92, 100, 8)).toEqual({
      longing: 84,
      nextThreshold: 100,
      cycled: false,
    });
  });

  it('requires both the value and its threshold to have reached 100', () => {
    expect(settleRelationshipLongingAfterSent(100, 99, 8)).toEqual({
      longing: 92,
      nextThreshold: 100,
      cycled: false,
    });
  });
});
