import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Live2D production chunk isolation', () => {
  const viteConfig = readFileSync(path.resolve(__dirname, '../vite.config.ts'), 'utf8');
  const canvasSource = readFileSync(path.resolve(__dirname, '../components/call/Live2DAvatarCanvas.tsx'), 'utf8');

  it('keeps the Cubism adapter out of the Pixi chunk eagerly used by the desktop theme', () => {
    const engineRule = "if (id.includes('untitled-pixi-live2d-engine'))";
    const pixiRule = "if (id.includes('@pixi/')";

    expect(viteConfig).toContain(engineRule);
    expect(viteConfig).toContain("return 'vendor-live2d-engine'");
    expect(viteConfig).toContain(pixiRule);
    expect(viteConfig.indexOf(engineRule)).toBeLessThan(viteConfig.indexOf(pixiRule));
    expect(viteConfig).not.toContain("id.includes('untitled-pixi-live2d-engine') || id.includes('@pixi/')");
  });

  it('avoids hidden mobile allocations without lowering the selected atlas resolution', () => {
    const callSource = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');
    const companionSource = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');

    expect(canvasSource).toContain('mobile ? 32 : 64');
    expect(canvasSource).toContain('mobile ? 1_000 : 8_000');
    expect(canvasSource).toContain('antialias: !mobileRuntime');
    expect(canvasSource).toContain('textureOptions: { lod: false }');
    expect(canvasSource).toContain("parser: 'texture'");
    expect(canvasSource).toContain('await prepareLive2DTextureAssets(packageTextureUrls)');
    expect(canvasSource).toContain('findIndex(texture => !isUsableLive2DTexture(texture))');
    expect(canvasSource).not.toContain("textureOptions: { lod: 'full'");
    expect(canvasSource).not.toContain('memorySizeMB: 128');
    expect(callSource).toContain("model={!showLive2DSettings && selectedVisualSource === 'model'");
    expect(companionSource).toContain('model={wardrobeLive2DSettings ? undefined : character.videoAvatar}');
  });
});
