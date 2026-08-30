import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AppID } from '../types';
import { preloadApp, setAppPayloadWarmer, shouldUseIdleAppPreload } from '../components/os/appPreload';

describe('preloadApp', () => {
  it('keeps idle preloading serial, delayed, interruptible, and off React private payloads', () => {
    const phoneShell = readFileSync(resolve(process.cwd(), 'components/PhoneShell.tsx'), 'utf8');

    expect(phoneShell).not.toContain('ROLE_ENTRY_PRELOAD_ORDER');
    expect(phoneShell).not.toContain('._payload');
    expect(phoneShell).toContain('APP_BY_ID[id]?.preload()');
    expect(phoneShell).toContain('await next.preload()');
    expect(phoneShell).toContain("window.addEventListener('pointerdown', stopForInteraction");
    expect(phoneShell).toContain('IDLE_PRELOAD_START_MS = 600');
  });

  it('skips idle preloading on constrained devices and connections', () => {
    expect(shouldUseIdleAppPreload({ hardwareConcurrency: 4 })).toBe(false);
    expect(shouldUseIdleAppPreload({ hardwareConcurrency: 8, deviceMemory: 4 })).toBe(false);
    expect(shouldUseIdleAppPreload({ hardwareConcurrency: 8, deviceMemory: 8, connection: { saveData: true } })).toBe(false);
    expect(shouldUseIdleAppPreload({ hardwareConcurrency: 8, deviceMemory: 8, connection: { effectiveType: '2g' } })).toBe(false);
  });

  it('allows idle preloading on capable or unclassified devices', () => {
    expect(shouldUseIdleAppPreload({ hardwareConcurrency: 8, deviceMemory: 8, connection: { effectiveType: '4g' } })).toBe(true);
    expect(shouldUseIdleAppPreload({})).toBe(true);
  });

  it('deduplicates repeated pointerdown preloads for the same App', async () => {
    let resolve!: () => void;
    const request = new Promise<void>(done => { resolve = done; });
    const warmer = vi.fn(() => request);
    setAppPayloadWarmer(warmer);

    preloadApp(AppID.Settings);
    preloadApp(AppID.Settings);

    expect(warmer).toHaveBeenCalledTimes(1);
    resolve();
    await request;
  });

  it('allows a pointerdown preload to retry after a temporary failure', async () => {
    const warmer = vi.fn()
      .mockRejectedValueOnce(new Error('temporary chunk failure'))
      .mockResolvedValueOnce(undefined);
    setAppPayloadWarmer(warmer);

    preloadApp(AppID.Chat);
    await Promise.resolve();
    preloadApp(AppID.Chat);

    expect(warmer).toHaveBeenCalledTimes(2);
  });
});
