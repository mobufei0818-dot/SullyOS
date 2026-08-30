import { describe, expect, it } from 'vitest';
import { clampStageCrop, DEFAULT_STAGE_CROP } from './avatarPerformance';

describe('avatar stage crop', () => {
  it('keeps the default crop fully open', () => {
    expect(clampStageCrop(DEFAULT_STAGE_CROP)).toEqual(DEFAULT_STAGE_CROP);
  });

  it('clamps each edge and preserves a usable visible window', () => {
    const crop = clampStageCrop({ top: 1, right: 0.7, bottom: 1, left: 0.7 });

    expect(crop.top).toBeLessThanOrEqual(0.42);
    expect(crop.right).toBeLessThanOrEqual(0.42);
    expect(crop.top + crop.bottom).toBeLessThanOrEqual(0.78);
    expect(crop.left + crop.right).toBeLessThanOrEqual(0.78);
  });

  it('normalizes negative and non-finite values', () => {
    expect(clampStageCrop({ top: -1, right: Number.NaN, bottom: 0.2, left: Number.POSITIVE_INFINITY }))
      .toEqual({ top: 0, right: 0, bottom: 0.2, left: 0 });
  });
});
