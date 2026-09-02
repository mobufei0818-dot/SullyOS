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

  it('legacy same-day suffixes never offer a downgrade when order is unknowable', () => {
    expect(isAmsgBundleCurrentOrNewer(
      '2026-09-02.relationship-tick-clock-1',
      '2026-09-02.relationship-stale-lock-1',
    )).toBe(true);
  });

  it('orders all future same-day releases by the explicit rN revision', () => {
    expect(isAmsgBundleCurrentOrNewer(
      '2026-09-02.r3.tick-clock',
      '2026-09-02.r2.stale-lock',
    )).toBe(true);
    expect(isAmsgBundleCurrentOrNewer(
      '2026-09-02.r2.stale-lock',
      '2026-09-02.r3.tick-clock',
    )).toBe(false);
  });

  it('treats the numbered scheme as newer than legacy on the same day', () => {
    expect(isAmsgBundleCurrentOrNewer(
      '2026-09-02.r1.numbered-protocol',
      '2026-09-02.relationship-tick-clock-1',
    )).toBe(true);
    expect(isAmsgBundleCurrentOrNewer(
      '2026-09-02.relationship-tick-clock-1',
      '2026-09-02.r1.numbered-protocol',
    )).toBe(false);
  });

  it('does not treat unknown version formats as newer', () => {
    expect(isAmsgBundleCurrentOrNewer('dev-build', '2026-09-02.d1-cleanup-1')).toBe(false);
  });
});
