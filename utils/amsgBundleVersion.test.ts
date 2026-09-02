import { describe, expect, it } from 'vitest';
import { isAmsgBundleCurrentOrNewer } from './amsgBundleVersion';

describe('isAmsgBundleCurrentOrNewer', () => {
  it('accepts an exact match', () => {
    expect(isAmsgBundleCurrentOrNewer(
      '2026-09-02.d1-cleanup-1',
      '2026-09-02.d1-cleanup-1',
    )).toBe(true);
  });

  it('accepts a worker newer than the still-open frontend', () => {
    expect(isAmsgBundleCurrentOrNewer(
      '2026-09-02.d1-cleanup-1',
      '2026-09-01.relationship-2',
    )).toBe(true);
  });

  it('rejects an older worker', () => {
    expect(isAmsgBundleCurrentOrNewer(
      '2026-09-01.relationship-2',
      '2026-09-02.d1-cleanup-1',
    )).toBe(false);
  });

  it('requires an exact match for different same-day suffixes', () => {
    expect(isAmsgBundleCurrentOrNewer(
      '2026-09-02.relationship-1',
      '2026-09-02.d1-cleanup-1',
    )).toBe(false);
  });

  it('does not treat unknown version formats as newer', () => {
    expect(isAmsgBundleCurrentOrNewer('dev-build', '2026-09-02.d1-cleanup-1')).toBe(false);
  });
});
