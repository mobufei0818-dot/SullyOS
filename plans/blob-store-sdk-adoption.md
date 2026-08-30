# blob-store SDK 接入计划（blobRef 薄壳化）

> 这是啥：把 `utils/blobRef.ts` 的通用部分换成 npm 包 `@rei-standard/blob-store`（从本文件所述的 blobRef 提炼、经六轮对抗复审的 SDK），SullyOS 侧只留薄壳与本项目特有逻辑，并首次接入孤儿 GC（挂开发调试面板）。
>
> 啥时候用：SDK 发出 `0.1.0-next.0` 之后动工。规范与包行为以 ReiStandard 仓的 `standards/blob-storage.md` 与包 README 为准。
>
> 现状：已随 v3.6 (Clean Sweep) 全部落地。本文档保留作实现对照；引用面清单的活版本在 `utils/blobGc.ts` 文件头，新功能动到令牌存储时更新那份即可。

## 前置条件

- npm 上存在 `@rei-standard/blob-store@0.1.0-next.0`（ReiStandard PR #68 合并 → Version Packages PR 合并 → 首发需手动 `npx changeset publish` 补发 + npmjs 配 trusted publisher，此后自动）。
- 版本写法跟随本仓惯例：**预发布版写死精确版本、不带 `^`、不用 `@next` tag**（对照 `package.json` 里 `@rei-standard/amsg-*` 的写法）。
- **禁 `link:`**：本地联调若临时 link 过 ReiStandard，提交前必须 `pnpm install` 回到已发布版本，并 `grep -n 'link:' pnpm-lock.yaml` 确认零命中（lockfile 里的 `link:` 会让 Netlify frozen install 直接失败，`09087e3` 有前科）。

## 总体形状

对外 **API 一个名字都不动**：`utils/blobRef.ts` 的全部导出（`BLOBREF_PREFIX` / `BlobRef` / `isBlobRef` / `putImageBlob` / `getBlobForRef` / `deleteBlobRef` / `deleteBlobRefIfUnreferenced` / `dataUrlToBlob` / `blobToDataUrl` / `migrateDataUrlToRef` / `migrateAppearancePresetBlobRefs` / `resolveRefToDataUrl` / `resolveBlobRefsDeep` / `useBlobRefUrl`）名称与签名原样保留。全仓 23 个 import 点、`appIcon.test.ts` 的 `vi.mock('./blobRef', ...)`、`callAppRuntimeReferences.test.ts` 的源码文本断言，都不需要任何改动。

```
utils/blobStore.ts   （新增）SDK store 单例 + StorageAdapter（包在 DB 之上）
utils/blobRef.ts     （薄壳化）通用导出委托给 store；三样 SullyOS 特有逻辑留守
utils/blobGc.ts      （新增）GC 入口 + 引用面清单（refSources 生成器）
utils/db.ts          （加一个方法）listBlobAssetIds
components/DevDebugPanel.tsx （加一个区块）手动 GC 按钮 + 结果展示
```

## 任务 1：装依赖 + store 单例与适配器

`package.json` dependencies 加 `"@rei-standard/blob-store": "0.1.0-next.0"`（精确版本）。

新建 `utils/blobStore.ts`：

```ts
import { createBlobStore } from '@rei-standard/blob-store';
import { DB } from './db';

// blob_assets 是混用表：blobRef 图片（img_ 老 / b_ 新）、VRM 模型（video-avatar-<uuid>）、
// Live2D 运行时缓存（<assetId>:live2d-runtime-store-v1…）、遗留陪伴语音（companion-*-voice:）
// 全在一张表里。规范要求「一个适配器 keys() 的覆盖范围只对应一个令牌前缀」，
// 所以 keys 必须圈定 blobRef 自己的 id 命名空间——否则 GC 会把用户的模型当孤儿删掉。
// （其他三族 id 都含 - 或 :，恰好也被 SDK 的字符集安全阀拦下，但那是兜底，不能当设计依赖。）
export const blobStore = createBlobStore({
  adapter: {
    get: (id) => DB.getBlobAsset(id),
    put: (id, blob) => DB.putBlobAsset(id, blob),
    delete: (id) => DB.deleteBlobAsset(id),
    keys: () => DB.listBlobAssetIds(),
  },
});
```

适配器**必须复用 `openDB()` 那条单例连接**（走 DB.* 方法即天然复用）——绝不自己 `indexedDB.open`，`db.ts` 注释里记录过多连接撑爆 backing store 的事故。

`utils/db.ts` 加 `listBlobAssetIds`，照 `getAllAssets`（`db.ts:1168`）的写法，带 `objectStoreNames.contains` 兜底（老库没这张表返回 `[]`），用 `store.getAllKeys()`，**返回前按前缀过滤**：

```ts
// 只列 blobRef 命名空间的 id（img_ 存量 / b_ SDK 新生成）。blob_assets 是混用表，
// GC 的世界观必须限制在自己的前缀内；今后往这张表加新 id 族时不得使用这两个前缀。
listBlobAssetIds: async (): Promise<string[]> => { /* getAllKeys + filter img_ | b_ */ }
```

行为差异提醒（都由 SDK 契约保证、不需要壳层适配，列出来免得排查时意外）：新令牌 id 前缀是 `b_` 不再是 `img_`（存量 `img_` 照读，GC 按「老」处理）；`put` 传非 Blob 抛 TypeError（原版静默产死令牌）；`resolveDeep` 整块跳过 TypedArray/DataView、遇 frozen 节点抛错（备份路径传的是 `structuredClone` 副本，不受影响）；`dataUrlToBlob` 会先 percent-decode 再解 base64。

## 任务 2：blobRef.ts 薄壳化

逐个导出的去向：

| 导出 | 去向 |
|---|---|
| `BLOBREF_PREFIX` | 保留常量（与 SDK 默认前缀一致） |
| `BlobRef` 品牌类型 / `isBlobRef` | 壳层保留品牌类型，`isBlobRef = (v): v is BlobRef => blobStore.isRef(v)` |
| `putImageBlob` / `getBlobForRef` / `deleteBlobRef` | 委托 `blobStore.put / get / delete`（deleteBlobRef 保留「接受 undefined/null 直接返回」的宽签名） |
| `dataUrlToBlob` / `blobToDataUrl` | re-export SDK 模块级函数 |
| `migrateDataUrlToRef` | 委托 `blobStore.migrateDataUrl` |
| `resolveRefToDataUrl` / `resolveBlobRefsDeep` | 委托 `blobStore.resolveToDataUrl / resolveDeep` |
| `deleteBlobRefIfUnreferenced` | **留守不动**（SullyOS 特有的引用扫描；长远由 GC 取代，本次不碰） |
| `migrateAppearancePresetBlobRefs` | **留守不动**（外观预设三字段迁移 + cache 去重） |
| `useBlobRefUrl` | 薄壳：见任务 3 |

验收：`pnpm vitest run utils/blobRef.test.ts` 原样全绿（这份测试就是壳层兼容性的守卫，一行不改）。

## 任务 3：useBlobRefUrl 薄壳 + 契约测试

壳层保留三分支里的 SullyOS 特有分支（`builtin-room-asset://` 与旧样板房绝对 URL → `resolveBuiltinRoomAssetUrl`），令牌与其余非令牌交给 SDK 的 `useBlobUrl(blobStore, value)`。

SDK hook 与现役实现语义有两处已知分叉，**必须补契约测试钉住**（SDK 侧行为测试当时明确说好随首个消费者落）：

1. **令牌 → 令牌切换期间返回 `undefined`**，不吐上一个（已 revoke 的）objectURL；
2. **非令牌在渲染期直接透传**（data: / http(s) / 渐变串 / undefined），不等 effect、无一帧滞后。

测试落点的坑：`vitest.config.ts` 是 `environment: 'node'` 且 include 只有 `utils/**/*.test.ts`（`.tsx` 不匹配、`components/**` 不跑）。所以契约测试写成 `utils/blobRefHook.contract.test.ts`——文件头加 `// @vitest-environment jsdom`，用 `React.createElement` 不写 JSX。jsdom（devDeps 已有 30.x）+ react-dom 18 的 `createRoot` + `act`，零新增依赖，约 20 行/条。

## 任务 4：GC 接入（`utils/blobGc.ts`）

```ts
export async function runBlobGc(opts?: { minAgeMs?: number }) {
  return blobStore.gc({ refSources: iterateRefSources(), ...opts }); // minAgeMs 默认 72h
}
```

`iterateRefSources()` 是 async generator，逐条 yield 明文字符串。**引用面清单（本计划的生死线，新功能动到令牌存储时必须同步更新此清单与生成器）**：

| 面 | 内容 | 吐法 |
|---|---|---|
| `characters` 表 | avatar / sprites / dateSkinSets / roomConfig / vrState.chibi / companionAvatar（含 imageWardrobe，令牌兼任条目 id 与 imageRef 两个值位）/ videoCallBackground / companionBackground / studio.like520 | 游标逐行 `JSON.stringify(row)` |
| `messages` 表 | `metadata.cameraSnapshotRef` | 游标逐行（表大，不 getAll 全量占内存） |
| `cc_custom_parts` 表 | src / shadowSrc | 游标逐行 |
| `songs` 表 | coverImage | 游标逐行 |
| `assets` 表 | wallpaper / lock_wallpaper / wallpaper_user_backup / icon_* / appearance_preset_*（JSON）/ room_custom_assets_list（JSON）/ **ls_mirror_v1（localStorage 镜像，最容易漏）** / spark_* 等 | 游标逐行 |
| `themes`、`pixel_home_assets` 表 | 目前未见令牌写入，纳入白名单防未来回归 | 游标逐行 |
| `localStorage` 全量**值** | tama_board_img_<charId> 与旧单键 / acnh_wallpaper_backup / sully-call-fake-camera-image-v1 / os_theme（JSON，令牌不剥）等 | 逐 key 吐 value |

规范的四条宿主义务对照：

1. **面要全且明文**——上表即清单；各面都是 JSON/裸串，令牌逐字可见，无压缩加密面。
2. **一表一前缀**——由任务 1 的 `listBlobAssetIds` 前缀过滤保证（混用表的世界观切割）。
3. **GC 期间引用不跨面搬家**——首版只挂调试面板手动触发，操作者自己避开备份导入等批量写入时段即可；多 tab 独跑（`navigator.locks`）留给产品化阶段。
4. **令牌边界完整**——侦察确认全仓没有 `${token}_xxx` 复合键、没有对象**键位**令牌（衣橱条目的 `{ id: imageRef }` 是值位，安全；这也满足 SDK「令牌须独占字段值」的备份形态约束）。

`keptBoundary` 语义（调试面板要展示）：边界歧义豁免的单独计数，**接近库存量 = 某个引用面混进了杂散的令牌前缀文本**（比如把 `blobref:b_` 当例子写进会被扫到的文案），此时 GC 整轮空转且 `deleted:0` 与「没垃圾」同形——它是唯一报警信号。

### 顺手修：songs 缺席备份导出名单

现状：`OSContext.tsx:4219` 的逐 store `resolveBlobRefsDeep` 循环只有 characters / cc_custom_parts / messages，`songs.coverImage` 的令牌会原样进备份（跨设备恢复即死键）。本次把 `songs` 补进名单，并在 `backupRoundtrip.test.ts` 加一条守卫（歌曲封面令牌导出后必须是 data URL）。

## 任务 5：调试面板挂 GC

照 `DevDebugPanel.tsx:447-470` 的日志动作行模式：`LogActionButton` 一枚（「清理孤儿图片」），点击跑 `runBlobGc()`，按钮下方一行 `text-[11px] text-white/55` 展示 `deleted / kept / keptBoundary / aborted` 四个数（keptBoundary 必须露出，见上）。区块间照例插 `<div className="h-px bg-white/10" />`。是动作按钮不是行为开关，不需要动 `DevDebugFlags` 三件套。

## 测试清单（新增）

| 测试 | 钉住什么 |
|---|---|
| `utils/blobRef.test.ts`（不改） | 薄壳对外行为与原版一致 |
| hook 契约 ×2（任务 3） | 令牌切换返回 undefined；非令牌渲染期透传 |
| **混用表守卫**（最重要） | 表里塞 `video-avatar-<uuid>`、`x:live2d-runtime-store-v1`、`companion-startup-voice:y` 假行 + 一个无引用老 `img_` 孤儿 → GC 后仅孤儿被删，三个外族 id 一根毛都不少 |
| GC 基础三件 | 老孤儿删 / 被引用留 / 新鲜留 |
| `listBlobAssetIds` 过滤 | 只返回 `img_` / `b_` 前缀 |
| songs 备份守卫 | 歌曲封面令牌导出后为 data URL |

全部走既有 `fake-indexeddb` + `MemStorage`（test-setup.ts），跑法 `pnpm vitest run`。

## 验收与提交前自查

- [ ] `pnpm vitest run` 全绿（含既有 blobRef / appIcon / callAppRuntimeReferences 等连带测试零改动通过）
- [ ] `grep -n 'link:' pnpm-lock.yaml` 零命中
- [ ] 真机冒烟：上传头像/壁纸（新令牌为 `b_` 前缀）、备份导出导入往返、调试面板 GC 跑一轮数字合理
- [ ] PR 描述附上文引用面清单
- [ ] 大功能落地，记得改 `utils/buildInfo.ts` 的 `APP_VERSION`

## 留给后续（本次不做）

- GC 产品化入口（设置页存储统计区「清理未使用文件」）+ `navigator.locks` 独跑保护
- `deleteBlobRefIfUnreferenced` 退役（由 GC 统一收口）
- `img_` 存量 id 的迁移（无收益，SDK 对存量按「老」正常处理）
