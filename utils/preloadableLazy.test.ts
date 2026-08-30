import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createPreloadableLazy } from '../components/os/preloadableLazy';

const TestComponent: React.FC = () => null;

describe('createPreloadableLazy', () => {
  it('deduplicates concurrent preload requests', async () => {
    let resolve!: (module: { default: React.ComponentType<any> }) => void;
    const factory = vi.fn(() => new Promise<{ default: React.ComponentType<any> }>(done => {
      resolve = done;
    }));
    const Component = createPreloadableLazy(factory);

    const first = Component.preload();
    const second = Component.preload();

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);

    resolve({ default: TestComponent });
    await first;
    await expect(Component.preload()).resolves.toEqual({ default: TestComponent });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('retries after a speculative preload failure', async () => {
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error('temporary chunk failure'))
      .mockResolvedValueOnce({ default: TestComponent });
    const Component = createPreloadableLazy(factory);

    await expect(Component.preload()).rejects.toThrow('temporary chunk failure');
    await expect(Component.preload()).resolves.toEqual({ default: TestComponent });
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
