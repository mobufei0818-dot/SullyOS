import { describe, expect, it } from 'vitest';
import { inspectAvatarFile, live2DRuntimeCacheAssetId, live2DRuntimeCacheAssetIds } from './avatarModelStore';

const namedBlob = (name: string, bytes: number[]): Blob & { name: string } => {
  const blob = new Blob([new Uint8Array(bytes)]) as Blob & { name: string };
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
};

describe('VRM 文件识别', () => {
  it('为 Live2D 派生运行缓存生成稳定且不碰撞原包的 key', () => {
    expect(live2DRuntimeCacheAssetId('video-avatar-live2d-1')).toBe('video-avatar-live2d-1:live2d-runtime-store-v1');
    expect(live2DRuntimeCacheAssetId('video-avatar-live2d-1', 'balanced')).toBe('video-avatar-live2d-1:live2d-runtime-store-v1:balanced');
    expect(live2DRuntimeCacheAssetIds('video-avatar-live2d-1')).toHaveLength(3);
  });
  it('识别标准 GLB/VRM magic', async () => {
    const result = await inspectAvatarFile(namedBlob('skylar.vrm', [0x67, 0x6c, 0x54, 0x46, 0, 0, 0, 0]));
    expect(result.kind).toBe('vrm');
  });

  it('把 .vroid 识别为需要导出的工程文件', async () => {
    const result = await inspectAvatarFile(namedBlob('skylar.vroid', [0x50, 0x4b, 0x03, 0x04]));
    expect(result.kind).toBe('vroid-project');
  });

  it('拒绝只改扩展名的伪 VRM', async () => {
    const result = await inspectAvatarFile(namedBlob('broken.vrm', [0x50, 0x4b, 0x03, 0x04]));
    expect(result).toMatchObject({ kind: 'unsupported' });
  });
});
