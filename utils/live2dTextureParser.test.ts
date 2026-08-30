import { Assets, loadTextures } from 'pixi.js';
import { describe, expect, it } from 'vitest';

describe('Live2D Blob texture parser selection', () => {
  it('does not rely on a fragment extension that Pixi removes', () => {
    expect(loadTextures.test?.('blob:https://localhost/texture#live2d-texture.png')).toBe(false);
  });

  it('keeps an explicit texture parser on a bare Blob URL', () => {
    const url = 'blob:https://localhost/live2d-explicit-parser-test';
    Assets.add({
      alias: url,
      src: url,
      parser: 'texture',
      data: { autoGenerateMipmaps: false },
    });

    try {
      expect(Assets.resolver.resolve(url)).toMatchObject({
        src: url,
        parser: 'texture',
        data: { autoGenerateMipmaps: false },
      });
    } finally {
      Assets.resolver.removeAlias(url);
    }
  });
});
