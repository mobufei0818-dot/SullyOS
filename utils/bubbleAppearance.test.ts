import { describe, expect, it } from 'vitest';
import { resolveBubbleCornerRadii, shouldHideBubbleTail } from './bubbleAppearance';

describe('bubble appearance compatibility', () => {
  it('keeps old themes on one shared radius', () => {
    expect(resolveBubbleCornerRadii({ borderRadius: 18 })).toEqual({
      topLeft: 18,
      topRight: 18,
      bottomRight: 18,
      bottomLeft: 18,
    });
  });

  it('allows every corner to override the shared radius independently', () => {
    expect(resolveBubbleCornerRadii({
      borderRadius: 12,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 0,
      borderBottomRightRadius: 6,
      borderBottomLeftRadius: 2,
    })).toEqual({ topLeft: 24, topRight: 0, bottomRight: 6, bottomLeft: 2 });
  });

  it('supports every, group-last and hidden tail modes', () => {
    expect(shouldHideBubbleTail(undefined, false)).toBe(false);
    expect(shouldHideBubbleTail('every', false)).toBe(false);
    expect(shouldHideBubbleTail('last', false)).toBe(true);
    expect(shouldHideBubbleTail('last', true)).toBe(false);
    expect(shouldHideBubbleTail('none', true)).toBe(true);
  });
});
