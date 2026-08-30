import { describe, it, expect } from 'vitest';
import { DB } from './db';

// fake-indexeddb 已由 test-setup.ts 注入。blob_assets 是混用表（blobRef 图片之外还有
// VRM 模型、Live2D 运行时缓存、遗留陪伴语音），listBlobAssetIds 是 GC 的世界观边界：
// 只许看见 blobRef 自己的 img_（存量）/ b_（SDK 新生成）前缀。别族 id 一旦漏进来，
// GC 就会把用户的模型/语音当孤儿删掉——这组用例把过滤行为钉住，当回归守卫。

const tinyBlob = () => new Blob(['x'], { type: 'application/octet-stream' });

describe('DB.listBlobAssetIds（blobRef 命名空间过滤）', () => {
    it('混用表里只返回 img_ / b_ 前缀的 id，其他 id 族一律不可见', async () => {
        await DB.putBlobAsset('img_aaa', tinyBlob());
        await DB.putBlobAsset('b_bbb', tinyBlob());
        // 同表共存的三族非 blobRef id：VRM 模型 / Live2D 运行时缓存 / 遗留陪伴语音
        await DB.putBlobAsset('video-avatar-1234-5678', tinyBlob());
        await DB.putBlobAsset('x:live2d-runtime-store-v1', tinyBlob());
        await DB.putBlobAsset('companion-startup-voice:y', tinyBlob());

        const ids = await DB.listBlobAssetIds();
        expect([...ids].sort()).toEqual(['b_bbb', 'img_aaa']);
    });
});
