import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBuiltinSullyLive2DConfig,
  isBuiltinSullyLive2D,
  setBuiltinSullyLive2DQuality,
  upgradeBuiltinSullyLive2DDefaults,
} from './builtinSullyLive2D';

const pngSize = (file: string): { width: number; height: number } => {
  const bytes = readFileSync(file);
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

describe('Sully built-in Live2D', () => {
  it('ships a 2K default variant and an explicit 4K opt-in variant', () => {
    const lite = createBuiltinSullyLive2DConfig();
    const hd = createBuiltinSullyLive2DConfig('hd');

    expect(lite.builtIn).toBe(true);
    expect(lite.builtinQuality).toBe('balanced');
    expect(lite.builtinModelUrl).toBe('sully/live2d-2k/Sully.model3.json');
    expect(lite.byteLength).toBeLessThan(hd.byteLength);
    expect(hd.builtinQuality).toBe('hd');
    expect(hd.builtinModelUrl).toBe('sully/live2d-4k/Sully.model3.json');
    expect(lite.lipSyncParameterIds).toContain('ParamMouthOpenY');
    expect(lite.actions).toHaveLength(7);
    expect(lite.framing).toEqual({ scale: 1.1, offsetX: 0, offsetY: 0.04 });
    expect(lite.companionFraming).toEqual({ scale: 1.1, offsetX: 0, offsetY: 0.04 });
  });

  it('migrates the previous built-in framing once and leaves later user resets alone', () => {
    const legacy = createBuiltinSullyLive2DConfig();
    legacy.builtinFramingVersion = 1;
    legacy.framing = { scale: 1.5, offsetX: 0, offsetY: 0 };
    legacy.companionFraming = { scale: 0.75, offsetX: 0, offsetY: 0 };

    const upgraded = upgradeBuiltinSullyLive2DDefaults(legacy);
    expect(upgraded.builtinFramingVersion).toBe(2);
    expect(upgraded.framing).toEqual({ scale: 1.1, offsetX: 0, offsetY: 0.04 });
    expect(upgraded.companionFraming).toEqual({ scale: 1.1, offsetX: 0, offsetY: 0.04 });
    const resetByUser = { ...upgraded, companionFraming: undefined };
    expect(upgradeBuiltinSullyLive2DDefaults(resetByUser).companionFraming).toBeUndefined();
  });

  it('preserves a clearly customized framing while advancing its migration version', () => {
    const customized = createBuiltinSullyLive2DConfig();
    customized.builtinFramingVersion = 1;
    customized.framing = { scale: 2.2, offsetX: 0.16, offsetY: -0.12 };
    customized.companionFraming = { scale: 1.35, offsetX: -0.08, offsetY: 0.12 };

    const upgraded = upgradeBuiltinSullyLive2DDefaults(customized);
    expect(upgraded.builtinFramingVersion).toBe(2);
    expect(upgraded.framing).toEqual(customized.framing);
    expect(upgraded.companionFraming).toEqual(customized.companionFraming);
  });

  it('keeps the Sully startup repair gate aligned with the current framing version', () => {
    const osContextSource = readFileSync(path.resolve(__dirname, '../context/OSContext.tsx'), 'utf8');
    expect(osContextSource).toContain('existingSully.videoAvatar.builtinFramingVersion !== 2');
  });

  it('switches quality without losing framing or user action permissions', () => {
    const lite = createBuiltinSullyLive2DConfig();
    lite.framing = { scale: 1.4, offsetX: 0.1, offsetY: -0.2 };
    lite.actions[0] = { ...lite.actions[0], permission: 'manual' };

    const hd = setBuiltinSullyLive2DQuality(lite, 'hd');
    expect(isBuiltinSullyLive2D(hd)).toBe(true);
    expect(hd.assetId).toBe('builtin-sully-live2d-4k-v1');
    expect(hd.framing).toEqual(lite.framing);
    expect(hd.actions[0].permission).toBe('manual');
  });

  it('keeps the static manifests and texture resolutions in sync', () => {
    const liteRoot = path.resolve(__dirname, '../public/sully/live2d-2k');
    const hdRoot = path.resolve(__dirname, '../public/sully/live2d-4k');
    const liteManifest = JSON.parse(readFileSync(path.join(liteRoot, 'Sully.model3.json'), 'utf8'));
    const hdManifest = JSON.parse(readFileSync(path.join(hdRoot, 'Sully.model3.json'), 'utf8'));

    expect(liteManifest.FileReferences.Textures).toEqual(['Sully.2048/texture_00.png']);
    expect(hdManifest.FileReferences.Textures).toEqual(['Sully.4096/texture_00.png']);
    expect(pngSize(path.join(liteRoot, 'Sully.2048/texture_00.png'))).toEqual({ width: 2048, height: 2048 });
    expect(pngSize(path.join(hdRoot, 'Sully.4096/texture_00.png'))).toEqual({ width: 4096, height: 4096 });
  });
});
