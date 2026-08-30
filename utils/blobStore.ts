// blobRef 令牌层的 SDK store 单例。通用逻辑（令牌生成/解析、data URL 互转、深度还原、GC）
// 在 @rei-standard/blob-store 里，这里只负责把它接到本项目自己的 IndexedDB 上——
// 适配器必须走 DB.*，绝不自己 indexedDB.open（db.ts 记录过多连接撑爆 backing store 的事故）。
//
// blob_assets 是混用表：blobRef 图片（img_ 老 / b_ 新）、VRM 模型（video-avatar-<uuid>）、
// Live2D 运行时缓存（<assetId>:live2d-runtime-store-v1…）、遗留陪伴语音（companion-*-voice:）
// 全在一张表里。规范要求「一个适配器 keys() 的覆盖范围只对应一个令牌前缀」，
// 所以 keys 必须圈定 blobRef 自己的 id 命名空间——否则 GC 会把用户的模型当孤儿删掉。
// （其他三族 id 都含 - 或 :，恰好也被 SDK 的字符集安全阀拦下，但那是兜底，不能当设计依赖。）

import { createBlobStore } from '@rei-standard/blob-store';
import { DB } from './db';

export const blobStore = createBlobStore({
    adapter: {
        get: (id) => DB.getBlobAsset(id),
        put: (id, blob) => DB.putBlobAsset(id, blob),
        delete: (id) => DB.deleteBlobAsset(id),
        keys: () => DB.listBlobAssetIds(),
    },
});
