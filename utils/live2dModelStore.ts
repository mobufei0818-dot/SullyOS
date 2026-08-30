import type { Entry as StreamingZipEntry, FileEntry as StreamingZipFileEntry, ZipReader as StreamingZipReader } from '@zip.js/zip.js';
import type { CharacterProfile } from '../types';
import { DB } from './db';
import { live2DRuntimeCacheAssetId, type Live2DTextureQuality } from './avatarModelStore';
import { isBuiltinSullyLive2D } from './builtinSullyLive2D';

export type Live2DAvatarConfig = Extract<NonNullable<CharacterProfile['videoAvatar']>, { format: 'live2d' }>;
export type Live2DAction = Live2DAvatarConfig['actions'][number];
export type Live2DActionPermission = Live2DAction['permission'];
export type Live2DActionParameterValue = NonNullable<Live2DAction['parameterValues']>[number];

export interface Live2DMissingFileDetail {
  /** Reference exactly as written in model3/vtube JSON. */
  reference: string;
  /** Normalized package path the importer tried to resolve. */
  resolvedPath: string;
  /** JSON file that owns the reference. */
  referencedBy: string;
  /** Existing path with only letter-case differences, when present. */
  caseInsensitiveMatch?: string;
  /** Existing files with the same basename, useful for spotting an extra folder level. */
  sameNameCandidates?: string[];
}

export class Live2DMissingFilesError extends Error {
  readonly code = 'LIVE2D_MISSING_REFERENCES';

  constructor(
    readonly modelPath: string,
    readonly missingFiles: Live2DMissingFileDetail[],
    readonly packageFileCount: number,
  ) {
    const names = missingFiles.slice(0, 3).map(item => basename(item.resolvedPath));
    super(`模型引用的文件不完整：${names.join('、')}${missingFiles.length > 3 ? ` 等 ${missingFiles.length} 个` : ''}`);
    this.name = 'Live2DMissingFilesError';
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      modelPath: this.modelPath,
      packageFileCount: this.packageFileCount,
      missingCount: this.missingFiles.length,
      missingFiles: this.missingFiles,
    };
  }
}

/** 衣橱动作拥有独立的强制手动通道，旧数据即使残留 ai 权限也不会暴露给模型。 */
export const isLive2DWardrobeAction = (action: Live2DAction): boolean => action.wardrobe === true;
export const getLive2DAIActions = (config: Live2DAvatarConfig): Live2DAction[] => (
  config.actions.filter(action => action.permission === 'ai' && !isLive2DWardrobeAction(action))
);
export const getLive2DWardrobeActions = (config: Live2DAvatarConfig): Live2DAction[] => (
  config.actions.filter(isLive2DWardrobeAction)
);

/**
 * Remove an item from the manual wardrobe without deleting the underlying
 * model action. It stays manual so a later compatibility upgrade cannot expose
 * a former clothing switch to the AI action whitelist.
 */
export const removeLive2DWardrobeAction = (
  config: Live2DAvatarConfig,
  actionId: string,
): Live2DAvatarConfig => {
  const target = config.actions.find(action => action.id === actionId && isLive2DWardrobeAction(action));
  if (!target) return config;
  const actions = config.actions.map(action => action.id === actionId
    ? { ...action, wardrobe: false, permission: 'manual' as const }
    : action);
  const nextWardrobe = actions.find(isLive2DWardrobeAction);
  return {
    ...config,
    actionPolicyVersion: 2,
    actions,
    activeWardrobeActionId: config.activeWardrobeActionId === actionId
      ? nextWardrobe?.id
      : config.activeWardrobeActionId,
  };
};

/** Resolve the parameter layer that must remain pinned for the selected outfit. */
export const getActiveLive2DWardrobeParameters = (
  config: Live2DAvatarConfig,
  runtimeValues: Record<string, Live2DActionParameterValue[]> = {},
): Live2DActionParameterValue[] => {
  const action = config.actions.find(item => (
    item.id === config.activeWardrobeActionId && isLive2DWardrobeAction(item)
  ));
  if (!action) return [];
  if (action.kind === 'params') {
    return (action.params || []).map(param => ({ ...param, blend: 'Overwrite' as const }));
  }
  if (action.kind !== 'expression') return [];
  return action.parameterValues || runtimeValues[action.id] || [];
};

const isIdleOnlyMotion = (action: Live2DAction): boolean => (
  action.kind === 'motion'
  && (action.group === 'Idle' || (action.tags.length > 0 && action.tags.every(tag => tag === 'idle')))
);

/**
 * One-time compatibility upgrade for models imported before automatic action
 * onboarding. Only previously-unclassified built-in files are promoted: a
 * user's explicit "manual" choice on a tagged/custom action is preserved.
 */
export const upgradeLive2DAutoPermissions = (config: Live2DAvatarConfig): Live2DAvatarConfig => {
  if (config.actionPolicyVersion === 2) return config;
  const actions = config.actions.map(action => {
    if (isLive2DWardrobeAction(action)) return { ...action, permission: 'manual' as const };
    const autoEligible = action.permission === 'manual'
      && action.tags.length === 0
      && action.source !== 'custom'
      && action.kind !== 'params'
      && !action.resetExpression
      && !isIdleOnlyMotion(action);
    return autoEligible ? { ...action, permission: 'ai' as const } : action;
  });
  return { ...config, actionPolicyVersion: 2, actions };
};

type Model3Json = {
  Version?: number;
  FileReferences?: {
    Moc?: string;
    Textures?: string[];
    Physics?: string;
    Pose?: string;
    DisplayInfo?: string;
    UserData?: string;
    Motions?: Record<string, Array<{ File?: string; Sound?: string; Name?: string }>>;
    Expressions?: Array<{ Name?: string; File?: string }>;
  };
  Groups?: Array<{ Name?: string; Ids?: string[] }>;
};

type VTubeJson = {
  FileReferences?: {
    Model?: string;
    IdleAnimation?: string;
    IdleAnimationWhenTrackingLost?: string;
  };
  SavedModelPosition?: {
    Position?: { x?: number; y?: number };
    Scale?: { x?: number; y?: number };
  };
  Hotkeys?: Array<{
    Name?: string;
    Action?: string;
    File?: string;
    Folder?: string;
    IsActive?: boolean;
    Triggers?: { Trigger1?: string; Trigger2?: string; Trigger3?: string };
  }>;
};

type PackageEntry = { path: string; blob: Blob };
type OpenStreamingZip = {
  reader: StreamingZipReader<Blob>;
  entries: StreamingZipFileEntry[];
};
type ParsedPackage = {
  modelPath: string;
  modelName: string;
  actions: Live2DAction[];
  lipSyncParameterIds: string[];
  texturePaths: string[];
  framing?: Live2DAvatarConfig['framing'];
};

export type Live2DImportProgress = (stage: string) => void;

const normalizePath = (value: string): string => {
  // ZIP tools on macOS/iOS may store decomposed Unicode while model3.json uses
  // composed characters. They are the same visible filename, so compare in NFC.
  const path = value.normalize('NFC').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  const parts = path.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '..')) throw new Error(`Live2D 包含不安全的路径：${value}`);
  return parts.join('/');
};

const dirname = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash + 1);
};

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const mimeForPath = (path: string): string => {
  if (/\.png$/i.test(path)) return 'image/png';
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg';
  if (/\.webp$/i.test(path)) return 'image/webp';
  if (/\.json$/i.test(path)) return 'application/json';
  if (/\.wav$/i.test(path)) return 'audio/wav';
  if (/\.mp3$/i.test(path)) return 'audio/mpeg';
  if (/\.ogg$/i.test(path)) return 'audio/ogg';
  return 'application/octet-stream';
};

const isIgnoredLive2DZipPath = (path: string): boolean => (
  /(^|\/)__MACOSX\//i.test(path) || /(^|\/)\.DS_Store$/i.test(path)
);

/**
 * zip.js reads Blob slices on demand. Unlike JSZip.loadAsync(file), opening a
 * large archive does not first copy the complete ZIP into the WebView JS heap.
 */
const openStreamingLive2DZip = async (blob: Blob): Promise<OpenStreamingZip> => {
  const { BlobReader, ZipReader } = await import('@zip.js/zip.js');
  const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false });
  try {
    const entries = (await reader.getEntries())
      .filter((entry): entry is Extract<StreamingZipEntry, { directory: false }> => !entry.directory)
      .filter(entry => !isIgnoredLive2DZipPath(entry.filename));
    return { reader, entries };
  } catch (error) {
    await reader.close().catch(() => {});
    throw error;
  }
};

const extractStreamingZipEntry = async (entry: StreamingZipFileEntry): Promise<Blob> => {
  const { BlobWriter } = await import('@zip.js/zip.js');
  return entry.getData(new BlobWriter(mimeForPath(entry.filename)), { useWebWorkers: false });
};

/** Only JSON bodies are needed to validate references and discover actions. */
const buildStreamingInspectionEntries = async (
  entries: StreamingZipFileEntry[],
  onProgress?: Live2DImportProgress,
): Promise<PackageEntry[]> => {
  const inspected: PackageEntry[] = [];
  let jsonCount = 0;
  for (const entry of entries) {
    const path = normalizePath(entry.filename);
    const needsBody = /\.json$/i.test(path);
    inspected.push({ path, blob: needsBody ? await extractStreamingZipEntry(entry) : new Blob() });
    if (needsBody) {
      jsonCount += 1;
      if (jsonCount % 8 === 0) onProgress?.(`正在读取模型配置 ${jsonCount} 个…`);
    }
  }
  return inspected;
};

const modelRelativePath = (modelPath: string, fullPath: string): string => {
  const base = dirname(modelPath);
  return base && fullPath.startsWith(base) ? fullPath.slice(base.length) : fullPath;
};

const finiteOr = (value: unknown, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** Source packages retain at most 4K so users can switch between runtime tiers. */
export const LIVE2D_MAX_TEXTURE_DIMENSION = 4096;
export const LIVE2D_BALANCED_TEXTURE_DIMENSION = 2048;

export const getLive2DTextureQuality = (config: Live2DAvatarConfig): Live2DTextureQuality => (
  config.textureQuality === 'hd' ? 'hd' : 'balanced'
);

export const getLive2DTextureMaxDimension = (config: Live2DAvatarConfig): number => (
  getLive2DTextureQuality(config) === 'hd'
    ? LIVE2D_MAX_TEXTURE_DIMENSION
    : LIVE2D_BALANCED_TEXTURE_DIMENSION
);

export interface Live2DTextureDimensions {
  width: number;
  height: number;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export interface Live2DTextureResizeTarget {
  width: number;
  height: number;
}

const readUint24LE = (bytes: Uint8Array, offset: number): number => (
  bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
);

/** Read texture dimensions from the file header without decoding a potentially huge bitmap. */
export const readLive2DTextureDimensions = async (blob: Blob): Promise<Live2DTextureDimensions | null> => {
  const bytes = new Uint8Array(await blob.slice(0, Math.min(blob.size, 512 * 1024)).arrayBuffer());
  if (bytes.length >= 24
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    return width > 0 && height > 0 ? { width, height, mimeType: 'image/png' } : null;
  }

  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const chunk = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      const chunkSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset + 4, true);
      const dataOffset = offset + 8;
      if (chunk === 'VP8X' && dataOffset + 10 <= bytes.length) {
        return {
          width: readUint24LE(bytes, dataOffset + 4) + 1,
          height: readUint24LE(bytes, dataOffset + 7) + 1,
          mimeType: 'image/webp',
        };
      }
      if (chunk === 'VP8 ' && dataOffset + 10 <= bytes.length
        && bytes[dataOffset + 3] === 0x9d && bytes[dataOffset + 4] === 0x01 && bytes[dataOffset + 5] === 0x2a) {
        return {
          width: (bytes[dataOffset + 6] | (bytes[dataOffset + 7] << 8)) & 0x3fff,
          height: (bytes[dataOffset + 8] | (bytes[dataOffset + 9] << 8)) & 0x3fff,
          mimeType: 'image/webp',
        };
      }
      if (chunk === 'VP8L' && dataOffset + 5 <= bytes.length && bytes[dataOffset] === 0x2f) {
        return {
          width: 1 + bytes[dataOffset + 1] + ((bytes[dataOffset + 2] & 0x3f) << 8),
          height: 1 + (bytes[dataOffset + 2] >> 6) + (bytes[dataOffset + 3] << 2) + ((bytes[dataOffset + 4] & 0x0f) << 10),
          mimeType: 'image/webp',
        };
      }
      const next = dataOffset + chunkSize + (chunkSize % 2);
      if (next <= offset) break;
      offset = next;
    }
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 1 >= bytes.length) break;
      const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if (sofMarkers.has(marker) && segmentLength >= 7) {
        const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
        const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
        return width > 0 && height > 0 ? { width, height, mimeType: 'image/jpeg' } : null;
      }
      offset += segmentLength;
    }
  }

  return null;
};

export const getLive2DTextureResizeTarget = (
  width: number,
  height: number,
  maxDimension = LIVE2D_MAX_TEXTURE_DIMENSION,
): Live2DTextureResizeTarget | null => {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= maxDimension) return null;
  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

export interface Live2DResizedTexture {
  path: string;
  fromWidth: number;
  fromHeight: number;
  toWidth: number;
  toHeight: number;
}

export interface Live2DTextureDownscaleResult {
  entries: PackageEntry[];
  resizedTextures: Live2DResizedTexture[];
}

const downscaleLive2DTextureEntry = async (
  entry: PackageEntry,
  onProgress?: Live2DImportProgress,
  maxDimension = LIVE2D_MAX_TEXTURE_DIMENSION,
): Promise<{ entry: PackageEntry; resized?: Live2DResizedTexture }> => {
  const dimensions = await readLive2DTextureDimensions(entry.blob);
  if (!dimensions) return { entry };
  const target = getLive2DTextureResizeTarget(dimensions.width, dimensions.height, maxDimension);
  if (!target) return { entry };

  onProgress?.(`贴图 ${basename(entry.path)} 为 ${dimensions.width}×${dimensions.height}，正在直接生成 ${target.width}×${target.height} 运行图…`);
  try {
    const resizedBlob = await resizeLive2DTextureBlob(entry.blob, dimensions, target);
    return {
      entry: { ...entry, blob: resizedBlob },
      resized: {
        path: normalizePath(entry.path),
        fromWidth: dimensions.width,
        fromHeight: dimensions.height,
        toWidth: target.width,
        toHeight: target.height,
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`贴图 ${basename(entry.path)} 超过 ${maxDimension}px，但自动降档失败：${detail}`);
  }
};

const encodeResizedTexture = async (
  source: CanvasImageSource,
  target: Live2DTextureResizeTarget,
  mimeType: Live2DTextureDimensions['mimeType'],
): Promise<Blob> => {
  const quality = mimeType === 'image/jpeg' ? 0.9 : undefined;
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(target.width, target.height);
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器无法创建图片缩放画布');
      context.drawImage(source, 0, 0, target.width, target.height);
      return await canvas.convertToBlob({ type: mimeType, quality });
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
  }

  if (typeof document === 'undefined') throw new Error('当前环境不支持图片缩放');
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法创建图片缩放画布');
    context.drawImage(source, 0, 0, target.width, target.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        result => result ? resolve(result) : reject(new Error('浏览器无法编码降档后的贴图')),
        mimeType,
        quality,
      );
    });
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
};

const resizeLive2DTextureBlob = async (
  blob: Blob,
  dimensions: Live2DTextureDimensions,
  target: Live2DTextureResizeTarget,
): Promise<Blob> => {
  const typedBlob = blob.type === dimensions.mimeType ? blob : blob.slice(0, blob.size, dimensions.mimeType);
  let source: CanvasImageSource | undefined;
  let closeSource: (() => void) | undefined;
  let objectUrl = '';

  try {
    // WebCodecs can consume the Blob stream and ask the decoder for the target
    // size up front. On supporting Android WebViews this avoids materializing
    // the full 8192px RGBA bitmap before the 2K result is produced.
    if (typeof ImageDecoder !== 'undefined') {
      let decoder: ImageDecoder | undefined;
      try {
        decoder = new ImageDecoder({
          data: typedBlob.stream(),
          type: dimensions.mimeType,
          desiredWidth: target.width,
          desiredHeight: target.height,
        });
        const decoded = await decoder.decode({ frameIndex: 0, completeFramesOnly: true });
        source = decoded.image;
        closeSource = () => {
          decoded.image.close();
          decoder?.close();
        };
      } catch (error) {
        decoder?.close();
        console.warn('[live2d] streaming ImageDecoder unavailable, falling back:', error);
      }
    }

    if (!source && typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(typedBlob, {
        resizeWidth: target.width,
        resizeHeight: target.height,
        resizeQuality: 'high',
      });
      source = bitmap;
      closeSource = () => bitmap.close();
    }

    if (!source) {
      if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        throw new Error('当前浏览器不支持图片降档');
      }
      objectUrl = URL.createObjectURL(typedBlob);
      const image = document.createElement('img');
      image.decoding = 'async';
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('浏览器无法解码这张贴图'));
        image.src = objectUrl;
      });
      source = image;
    }

    const resized = await encodeResizedTexture(source, target, dimensions.mimeType);
    if (!resized.size) throw new Error('降档后的贴图为空');
    return resized;
  } finally {
    closeSource?.();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
};

/** Downscale referenced textures sequentially to keep peak decode memory bounded. */
export const downscaleOversizedLive2DTextures = async (
  entries: PackageEntry[],
  texturePaths: string[],
  onProgress?: Live2DImportProgress,
  maxDimension = LIVE2D_MAX_TEXTURE_DIMENSION,
): Promise<Live2DTextureDownscaleResult> => {
  const nextEntries = [...entries];
  const entryIndexByPath = new Map(entries.map((entry, index) => [normalizePath(entry.path), index]));
  const resizedTextures: Live2DResizedTexture[] = [];

  for (const path of [...new Set(texturePaths.map(normalizePath))]) {
    const index = entryIndexByPath.get(path);
    if (index === undefined) continue;
    const result = await downscaleLive2DTextureEntry(nextEntries[index], onProgress, maxDimension);
    nextEntries[index] = result.entry;
    if (result.resized) resizedTextures.push(result.resized);
  }

  return { entries: nextEntries, resizedTextures };
};

/**
 * Extract one archive entry at a time and immediately replace oversized source
 * textures. At most one 8K source texture and its resized result overlap.
 */
const extractStreamingRuntimeEntries = async (
  entries: StreamingZipFileEntry[],
  texturePaths: string[],
  onProgress?: Live2DImportProgress,
  maxDimension = LIVE2D_BALANCED_TEXTURE_DIMENSION,
  reusedEntries: Map<string, Blob> = new Map(),
): Promise<Live2DTextureDownscaleResult> => {
  const texturePathSet = new Set(texturePaths.map(normalizePath));
  const runtimeEntries: PackageEntry[] = [];
  const resizedTextures: Live2DResizedTexture[] = [];
  let loaded = 0;

  for (const zipEntry of entries) {
    const path = normalizePath(zipEntry.filename);
    const sourceBlob = reusedEntries.get(path) || await extractStreamingZipEntry(zipEntry);
    let result: { entry: PackageEntry; resized?: Live2DResizedTexture } = {
      entry: { path, blob: sourceBlob },
    };
    if (texturePathSet.has(path)) {
      result = await downscaleLive2DTextureEntry(result.entry, onProgress, maxDimension);
    }
    runtimeEntries.push(result.entry);
    if (result.resized) resizedTextures.push(result.resized);
    loaded += 1;
    if (loaded === entries.length || loaded % 6 === 0) {
      onProgress?.(`正在低内存解包模型文件 ${loaded}/${entries.length}…`);
    }
    // Give Android WebView a paint/GC opportunity between large entries.
    if (texturePathSet.has(path)) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }

  return { entries: runtimeEntries, resizedTextures };
};

export const extractStreamingLive2DRuntimeArchive = async (
  packageBlob: Blob,
  modelPath: string,
  maxDimension: number,
  onProgress?: Live2DImportProgress,
): Promise<Live2DTextureDownscaleResult> => {
  const opened = await openStreamingLive2DZip(packageBlob);
  try {
    const normalizedModelPath = normalizePath(modelPath);
    const modelEntry = opened.entries.find(entry => normalizePath(entry.filename) === normalizedModelPath);
    if (!modelEntry) throw new Error('模型包内找不到 model3.json，请重新导入。');
    const modelBlob = await extractStreamingZipEntry(modelEntry);
    let settings: Model3Json;
    try {
      settings = JSON.parse(await modelBlob.text()) as Model3Json;
    } catch {
      throw new Error(`${basename(normalizedModelPath)} 不是有效的 JSON。`);
    }
    const texturePaths = (settings.FileReferences?.Textures || [])
      .map(reference => resolveModelReference(normalizedModelPath, reference));
    return extractStreamingRuntimeEntries(
      opened.entries,
      texturePaths,
      onProgress,
      maxDimension,
      new Map([[normalizedModelPath, modelBlob]]),
    );
  } finally {
    await opened.reader.close().catch(() => {});
  }
};

const resolveModelReference = (modelPath: string, reference: string): string => {
  const base = dirname(modelPath).split('/').filter(Boolean);
  for (const part of reference.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') base.pop();
    else base.push(part);
  }
  return normalizePath(base.join('/'));
};

const actionTagRules: Array<[string, RegExp]> = [
  ['happy', /happy|smile|joy|laugh|grin|star|tail|开心|高兴|微笑|笑|星星|尾巴/i],
  ['sad', /sad|cry|gloom|tear|upset|伤心|难过|哭|失落|脸黑/i],
  ['angry', /angry|anger|mad|rage|生气|愤怒|气恼/i],
  ['surprised', /surpris|shock|wow|sweat|惊讶|震惊|吃惊|汗/i],
  ['shy', /shy|blush|bashful|love|heart|cat.?ear|害羞|脸红|爱心|猫耳/i],
  ['wave', /wave|hello|greet|hand|挥手|招呼|你好/i],
  ['nod', /nod|agree|yes|点头|同意/i],
  ['shake', /shake|disagree|no|摇头|拒绝/i],
  ['tilt', /tilt|question|confus|歪头|疑问|困惑/i],
  ['explain', /explain|present|talk|speak|chat|microphone|介绍|解释|说话|麦克风/i],
  ['idle', /idle|standby|breath|待机|呼吸/i],
  ['idle', /循环|loop/i],
];

export const inferLive2DActionTags = (...parts: Array<string | undefined>): string[] => {
  const text = parts.filter(Boolean).join(' ');
  return actionTagRules.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
};

const discoverActionParameters = async (
  action: Live2DAction,
  entries: Map<string, Blob>,
  modelPath: string,
): Promise<{ ids: string[]; values: Live2DActionParameterValue[] }> => {
  if (action.kind === 'params') {
    const values = (action.params || [])
      .filter(param => Boolean(param.id) && Number.isFinite(param.value))
      .map(param => ({ ...param, blend: 'Overwrite' as const }));
    return { ids: [...new Set(values.map(param => param.id))], values };
  }
  if (!action.file) return { ids: action.parameterIds || [], values: action.parameterValues || [] };
  try {
    const blob = entries.get(resolveModelReference(modelPath, action.file));
    // Motion/expression JSON should be tiny. Refuse unexpectedly large files so
    // metadata discovery can never stall model loading.
    if (!blob || blob.size > 8 * 1024 * 1024) {
      return { ids: action.parameterIds || [], values: action.parameterValues || [] };
    }
    const parsed = JSON.parse(await blob.text()) as {
      Curves?: Array<{ Target?: string; Id?: string }>;
      Parameters?: Array<{ Id?: string; Value?: number; Blend?: string }>;
    };
    const ids = action.kind === 'motion'
      ? (parsed.Curves || []).filter(curve => curve.Target === 'Parameter').map(curve => curve.Id)
      : (parsed.Parameters || []).map(parameter => parameter.Id);
    const values = action.kind === 'expression'
      ? (parsed.Parameters || []).flatMap(parameter => {
          if (!parameter.Id || !Number.isFinite(parameter.Value)) return [];
          const blend: Live2DActionParameterValue['blend'] = parameter.Blend === 'Multiply' || parameter.Blend === 'Overwrite'
            ? parameter.Blend
            : 'Add';
          return [{ id: parameter.Id, value: Number(parameter.Value), blend }];
        })
      : [];
    return {
      ids: [...new Set(ids.filter((id): id is string => typeof id === 'string' && Boolean(id)))],
      values,
    };
  } catch {
    return { ids: action.parameterIds || [], values: action.parameterValues || [] };
  }
};

type Live2DDeclaredReference = {
  reference: string;
  required: boolean;
};

const collectReferencedFiles = (model: Model3Json): Live2DDeclaredReference[] => {
  const refs = model.FileReferences || {};
  const required = [refs.Moc, ...(refs.Textures || [])];
  const optional = [refs.Physics, refs.Pose, refs.DisplayInfo, refs.UserData];
  Object.values(refs.Motions || {}).forEach(items => items.forEach(item => optional.push(item.File, item.Sound)));
  (refs.Expressions || []).forEach(item => optional.push(item.File));
  const compact = (items: Array<string | undefined>, isRequired: boolean): Live2DDeclaredReference[] => items
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map(reference => ({ reference, required: isRequired }));
  return [...compact(required, true), ...compact(optional, false)];
};

/**
 * Cubism only needs Moc + textures to construct the model. Stale expressions,
 * motions, sounds, physics and editor metadata are common in VTube Studio packs;
 * remove missing optional references before turning paths into Blob URLs.
 */
export const pruneUnavailableLive2DReferences = (
  model: Model3Json,
  modelPath: string,
  availablePaths: Iterable<string>,
): number => {
  const refs = model.FileReferences;
  if (!refs) return 0;
  const available = new Set([...availablePaths].map(normalizePath));
  const exists = (reference?: string): boolean => (
    Boolean(reference) && available.has(resolveModelReference(modelPath, reference!))
  );
  let pruned = 0;

  for (const key of ['Physics', 'Pose', 'DisplayInfo', 'UserData'] as const) {
    if (refs[key] && !exists(refs[key])) {
      delete refs[key];
      pruned += 1;
    }
  }

  for (const [group, motions] of Object.entries(refs.Motions || {})) {
    const kept = motions.filter(motion => {
      if (exists(motion.File)) return true;
      if (motion.File) pruned += 1;
      return false;
    });
    for (const motion of kept) {
      if (motion.Sound && !exists(motion.Sound)) {
        delete motion.Sound;
        pruned += 1;
      }
    }
    if (kept.length) refs.Motions![group] = kept;
    else delete refs.Motions![group];
  }

  refs.Expressions = (refs.Expressions || []).filter(expression => {
    if (exists(expression.File)) return true;
    if (expression.File) pruned += 1;
    return false;
  });
  return pruned;
};

const parsePackage = async (entries: PackageEntry[]): Promise<ParsedPackage> => {
  const byPath = new Map(entries.map(entry => [normalizePath(entry.path), entry.blob]));
  const modelPaths = [...byPath.keys()].filter(path => path.toLowerCase().endsWith('.model3.json'));
  if (!modelPaths.length) throw new Error('没有找到 *.model3.json；请选择完整的 Live2D Cubism 3/4/5 模型文件夹或 ZIP。');
  if (modelPaths.length > 1) throw new Error(`包里发现 ${modelPaths.length} 个 model3.json，请一次只导入一个 Live2D 模型。`);

  const modelPath = modelPaths[0];
  let model: Model3Json;
  try {
    model = JSON.parse(await byPath.get(modelPath)!.text()) as Model3Json;
  } catch {
    throw new Error(`${basename(modelPath)} 不是有效的 JSON。`);
  }
  const refs = model.FileReferences;
  if (!refs?.Moc || !Array.isArray(refs.Textures) || !refs.Textures.length) {
    throw new Error('model3.json 缺少 FileReferences.Moc 或 Textures，无法作为 Cubism 模型加载。');
  }

  let vtubePath = '';
  let vtube: VTubeJson | undefined;
  for (const path of [...byPath.keys()].filter(item => item.toLowerCase().endsWith('.vtube.json'))) {
    try {
      const candidate = JSON.parse(await byPath.get(path)!.text()) as VTubeJson;
      const targetModel = candidate.FileReferences?.Model;
      if (!targetModel || resolveModelReference(path, targetModel) === modelPath) {
        vtubePath = path;
        vtube = candidate;
        break;
      }
    } catch {
      // A malformed optional VTube Studio settings file must not block Cubism import.
    }
  }

  const vtubeReferencedFiles = [
    vtube?.FileReferences?.IdleAnimation,
    vtube?.FileReferences?.IdleAnimationWhenTrackingLost,
    ...(vtube?.Hotkeys || []).map(hotkey => hotkey.File),
  ].filter((item): item is string => Boolean(item));
  const referencedFiles = [
    ...collectReferencedFiles(model).map(({ reference, required }) => ({
      reference,
      required,
      resolvedPath: resolveModelReference(modelPath, reference),
      referencedBy: modelPath,
    })),
    ...vtubeReferencedFiles.map(reference => ({
      reference,
      required: false,
      resolvedPath: resolveModelReference(vtubePath || modelPath, reference),
      referencedBy: vtubePath || modelPath,
    })),
  ];
  const packagePaths = [...byPath.keys()];
  const missing = referencedFiles
    .filter(item => !byPath.has(item.resolvedPath))
    .filter((item, index, items) => items.findIndex(candidate => (
      candidate.referencedBy === item.referencedBy
      && candidate.reference === item.reference
      && candidate.resolvedPath === item.resolvedPath
    )) === index)
    .map(item => {
      const lowerPath = item.resolvedPath.toLowerCase();
      const targetName = basename(item.resolvedPath).toLowerCase();
      const caseInsensitiveMatch = packagePaths.find(path => path.toLowerCase() === lowerPath);
      const sameNameCandidates = packagePaths
        .filter(path => basename(path).toLowerCase() === targetName && path !== caseInsensitiveMatch)
        .slice(0, 8);
      return {
        ...item,
        ...(caseInsensitiveMatch ? { caseInsensitiveMatch } : {}),
        ...(sameNameCandidates.length ? { sameNameCandidates } : {}),
      };
    });
  const toMissingDetail = ({ required: _required, ...detail }: typeof missing[number]): Live2DMissingFileDetail => detail;
  const requiredMissing = missing.filter(item => item.required).map(toMissingDetail);
  const optionalMissing = missing.filter(item => !item.required).map(toMissingDetail);
  if (requiredMissing.length) {
    const error = new Live2DMissingFilesError(modelPath, requiredMissing, packagePaths.length);
    // Keep the user-facing message compact, but make the browser/debug console
    // fully actionable. JSON text is intentional: embedded WebView consoles
    // often collapse Error custom fields and only retain Error.message.
    console.error(
      `[live2d] ${error.message}\n完整缺失引用诊断：\n${JSON.stringify(error.toJSON(), null, 2)}`,
    );
    throw error;
  }
  if (optionalMissing.length) {
    console.warn(
      `[live2d] 已忽略 ${optionalMissing.length} 个缺失的可选文件引用：\n${JSON.stringify(optionalMissing, null, 2)}`,
    );
  }

  const actions: Live2DAction[] = [];
  const expressionByPath = new Map<string, Live2DAction>();
  const motionByPath = new Map<string, Live2DAction>();
  let expressionIndex = 0;
  const addExpression = (
    name: string,
    file: string,
    source: NonNullable<Live2DAction['source']>,
    hotkey?: string,
  ): Live2DAction => {
    const resolvedPath = resolveModelReference(modelPath, file);
    const existing = expressionByPath.get(resolvedPath);
    if (existing) {
      if (source === 'vtube') {
        existing.name = name || existing.name;
        existing.expressionId = name || existing.expressionId;
        existing.hotkey = hotkey || existing.hotkey;
        existing.source = source;
        existing.tags = inferLive2DActionTags(existing.name, existing.file);
        existing.permission = 'ai';
      }
      return existing;
    }
    const actionName = name || basename(file).replace(/\.exp3\.json$/i, '');
    const tags = inferLive2DActionTags(actionName, file);
    const action: Live2DAction = {
      id: `expression-${expressionIndex++}`,
      kind: 'expression',
      name: actionName,
      expressionId: actionName,
      file,
      hotkey,
      source,
      tags,
      permission: 'ai',
    };
    actions.push(action);
    expressionByPath.set(resolvedPath, action);
    return action;
  };

  for (const expression of refs.Expressions || []) {
    if (!expression.File) continue;
    if (!byPath.has(resolveModelReference(modelPath, expression.File))) continue;
    addExpression(expression.Name || '', expression.File, 'model3');
  }

  let motionIndex = 0;
  const motionCounts = new Map<string, number>();
  const addMotion = (
    name: string,
    file: string,
    group: string,
    source: NonNullable<Live2DAction['source']>,
    declaredIndex?: number,
  ): Live2DAction => {
    const resolvedPath = resolveModelReference(modelPath, file);
    const existing = motionByPath.get(resolvedPath);
    if (existing) return existing;
    const index = declaredIndex ?? motionCounts.get(group) ?? 0;
    motionCounts.set(group, Math.max(motionCounts.get(group) ?? 0, index + 1));
    const actionName = name || `${group} ${index + 1}`;
    const tags = inferLive2DActionTags(group, actionName, file);
    const action: Live2DAction = {
      id: `motion-${motionIndex++}`,
      kind: 'motion',
      name: actionName,
      group,
      index,
      file,
      source,
      tags,
      // Idle already runs automatically in the engine. Keeping it out of the
      // director list avoids wasting a cue slot without asking the user.
      permission: group === 'Idle' || (tags.length > 0 && tags.every(tag => tag === 'idle')) ? 'manual' : 'ai',
    };
    actions.push(action);
    motionByPath.set(resolvedPath, action);
    return action;
  };

  for (const [group, motions] of Object.entries(refs.Motions || {})) {
    motions.forEach((motion, index) => {
      if (!motion.File) return;
      if (!byPath.has(resolveModelReference(modelPath, motion.File))) return;
      addMotion(motion.Name || '', motion.File, group, 'model3', index);
    });
  }

  const hotkeyText = (hotkey: NonNullable<VTubeJson['Hotkeys']>[number]): string | undefined => {
    const keys = [hotkey.Triggers?.Trigger1, hotkey.Triggers?.Trigger2, hotkey.Triggers?.Trigger3].filter(Boolean);
    return keys.length ? keys.join('+') : undefined;
  };
  for (const hotkey of vtube?.Hotkeys || []) {
    if (hotkey.IsActive === false) continue;
    const key = hotkeyText(hotkey);
    if (hotkey.Action === 'ToggleExpression' && hotkey.File) {
      const fullPath = resolveModelReference(vtubePath, hotkey.File);
      if (!byPath.has(fullPath)) continue;
      addExpression(hotkey.Name || '', modelRelativePath(modelPath, fullPath), 'vtube', key);
    } else if (hotkey.Action === 'RemoveAllExpressions') {
      actions.push({
        id: `expression-reset-${expressionIndex++}`,
        kind: 'expression',
        name: hotkey.Name || '清除全部表情',
        file: '',
        expressionId: '__reset__',
        hotkey: key,
        source: 'vtube',
        resetExpression: true,
        tags: ['neutral', 'idle'],
        permission: 'manual',
      });
    }
  }

  const idleFile = vtube?.FileReferences?.IdleAnimation;
  if (idleFile) {
    const fullPath = resolveModelReference(vtubePath, idleFile);
    if (byPath.has(fullPath)) addMotion('待机循环', modelRelativePath(modelPath, fullPath), 'Idle', 'vtube');
  }

  const modelDirectory = dirname(modelPath);
  const modelFiles = [...byPath.keys()].filter(path => !modelDirectory || path.startsWith(modelDirectory));
  for (const path of modelFiles.filter(item => item.toLowerCase().endsWith('.exp3.json'))) {
    const file = modelRelativePath(modelPath, path);
    addExpression(basename(file).replace(/\.exp3\.json$/i, ''), file, 'discovered');
  }
  for (const path of modelFiles.filter(item => item.toLowerCase().endsWith('.motion3.json'))) {
    const file = modelRelativePath(modelPath, path);
    const name = basename(file).replace(/\.motion3\.json$/i, '');
    const group = /idle|standby|loop|循环|待机/i.test(name) ? 'Idle' : 'Imported';
    addMotion(name, file, group, 'discovered');
  }

  const lipSyncParameterIds = (model.Groups || [])
    .filter(group => group.Name?.toLowerCase() === 'lipsync')
    .flatMap(group => group.Ids || [])
    .filter(Boolean);

  await Promise.all(actions.map(async action => {
    const parameters = await discoverActionParameters(action, byPath, modelPath);
    if (parameters.ids.length) action.parameterIds = parameters.ids;
    if (parameters.values.length) action.parameterValues = parameters.values;
  }));

  return {
    modelPath,
    modelName: basename(modelPath).replace(/\.model3\.json$/i, ''),
    actions,
    lipSyncParameterIds: lipSyncParameterIds.length ? [...new Set(lipSyncParameterIds)] : ['ParamMouthOpenY'],
    texturePaths: [...new Set(refs.Textures.map(texture => resolveModelReference(modelPath, texture)))],
    ...(vtube?.SavedModelPosition ? {
      framing: {
        scale: clamp(finiteOr(vtube.SavedModelPosition.Scale?.x, 1), 0.5, 6),
        offsetX: clamp(finiteOr(vtube.SavedModelPosition.Position?.x, 0) / 200, -1.4, 1.4),
        offsetY: clamp(-finiteOr(vtube.SavedModelPosition.Position?.y, 0) / 200, -3.2, 3.2),
      },
    } : {}),
  };
};

/** Pure inspection hook used by import UI and regression tests. */
export const inspectLive2DPackage = (entries: Array<{ path: string; blob: Blob }>) => parsePackage(entries);

const makeAssetId = (): string => {
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `video-avatar-live2d-${id}`;
};

const createConfig = async (
  blob: Blob,
  sourceEntries: PackageEntry[],
  fileName: string,
  parsed?: ParsedPackage,
  runtimeEntries: PackageEntry[] = sourceEntries,
  persistRuntimeCache = false,
  runtimePackageEncoding: NonNullable<Live2DAvatarConfig['runtimePackageEncoding']> = 'store-v1',
): Promise<Live2DAvatarConfig> => {
  const inspected = parsed || await parsePackage(sourceEntries);
  const assetId = makeAssetId();
  await DB.putBlobAsset(assetId, blob);
  if (persistRuntimeCache) {
    try {
      const runtimeBlob = await buildStoredLive2DPackage(runtimeEntries);
      await DB.putBlobAsset(live2DRuntimeCacheAssetId(assetId, 'balanced'), runtimeBlob);
    } catch (error) {
      console.warn('[live2d] 2K import cache write skipped:', error);
    }
  }
  seedLive2DRuntimePackage(assetId, runtimeEntries, 'balanced');
  return {
    version: 1,
    format: 'live2d',
    assetId,
    fileName: fileName || inspected.modelName,
    modelPath: inspected.modelPath,
    byteLength: blob.size,
    fileCount: sourceEntries.length,
    importedAt: Date.now(),
    runtimePackageEncoding,
    textureQuality: 'balanced',
    actionPolicyVersion: 2,
    framing: inspected.framing || { scale: 1, offsetX: 0, offsetY: 0 },
    lipSyncParameterIds: inspected.lipSyncParameterIds,
    actions: inspected.actions,
  };
};

const fileRelativePath = (file: File): string => (
  (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
);

export const saveLive2DModelFromFiles = async (
  files: File[],
  onProgress?: Live2DImportProgress,
): Promise<Live2DAvatarConfig> => {
  const sourceFiles = files.filter(file => file.size > 0 && !/(^|\/)\.DS_Store$/i.test(fileRelativePath(file)));
  if (!sourceFiles.length) throw new Error('选择的文件夹是空的。');
  const entries = sourceFiles.map(file => ({ path: normalizePath(fileRelativePath(file)), blob: file }));
  onProgress?.(`正在扫描 ${entries.length} 个文件和 VTube Studio 热键…`);
  const parsed = await parsePackage(entries);
  const sourceOptimized = await downscaleOversizedLive2DTextures(entries, parsed.texturePaths, onProgress, LIVE2D_MAX_TEXTURE_DIMENSION);
  const runtimeOptimized = await downscaleOversizedLive2DTextures(
    sourceOptimized.entries,
    parsed.texturePaths,
    onProgress,
    LIVE2D_BALANCED_TEXTURE_DIMENSION,
  );
  onProgress?.(sourceOptimized.resizedTextures.length || runtimeOptimized.resizedTextures.length
    ? `已建立默认 2K 纹理（保留最多 4K 源图供切换），正在整理本地模型包…`
    : `已找到 ${parsed.actions.length} 个表情/动作，正在整理本地模型包…`);
  // PNG/JPEG/moc are already compressed. Re-deflating a large 8K texture can
  // freeze the UI for tens of seconds without meaningfully reducing its size.
  const packageBlob = await buildStoredLive2DPackage(sourceOptimized.entries);
  const rootName = parsed.modelPath.includes('/') ? parsed.modelPath.split('/')[0] : parsed.modelName;
  onProgress?.('正在写入本地模型库，请保持页面打开…');
  return createConfig(
    packageBlob,
    sourceOptimized.entries,
    rootName,
    parsed,
    runtimeOptimized.entries,
    runtimeOptimized.resizedTextures.length > 0,
  );
};

export const saveLive2DModelFromZip = async (
  file: File,
  onProgress?: Live2DImportProgress,
): Promise<Live2DAvatarConfig> => {
  let opened: OpenStreamingZip;
  try {
    onProgress?.(`正在流式读取 ${file.name}，不会把整个压缩包复制进内存…`);
    opened = await openStreamingLive2DZip(file);
  } catch {
    throw new Error('ZIP 无法读取；请确认它没有加密且内容没有损坏。');
  }
  try {
    onProgress?.('正在读取 model3、动作配置与 VTube Studio 热键…');
    const inspectionEntries = await buildStreamingInspectionEntries(opened.entries, onProgress);
    const parsed = await parsePackage(inspectionEntries);
    const reusableBodies = new Map(
      inspectionEntries
        .filter(entry => entry.blob.size > 0)
        .map(entry => [normalizePath(entry.path), entry.blob]),
    );
    const runtimeOptimized = await extractStreamingRuntimeEntries(
      opened.entries,
      parsed.texturePaths,
      onProgress,
      LIVE2D_BALANCED_TEXTURE_DIMENSION,
      reusableBodies,
    );
    onProgress?.(runtimeOptimized.resizedTextures.length
      ? '已逐张生成默认 2K 纹理，正在写入低内存运行缓存…'
      : `已找到 ${parsed.actions.length} 个表情/动作，正在写入低内存运行缓存…`);

    // Keep the original compressed ZIP as the portable source. 4K is derived
    // on demand, while the default 2K runtime cache is written immediately.
    // This avoids holding original 8K + 4K + 2K textures at the same time.
    return await createConfig(
      file,
      inspectionEntries,
      file.name.replace(/\.zip$/i, ''),
      parsed,
      runtimeOptimized.entries,
      true,
      'zip-v1',
    );
  } finally {
    await opened.reader.close().catch(() => {});
  }
};

/** Restores the stored package into browser Files with the original relative paths. */
export const loadLive2DModelFiles = async (config: Live2DAvatarConfig): Promise<File[]> => {
  const packageBlob = await DB.getBlobAsset(config.assetId);
  if (!packageBlob) throw new Error('Live2D 模型文件已丢失，请重新导入。');
  const opened = await openStreamingLive2DZip(packageBlob);
  try {
    const files: File[] = [];
    for (const entry of opened.entries) {
      const path = normalizePath(entry.filename);
      const file = new File([await extractStreamingZipEntry(entry)], basename(path), { type: mimeForPath(path) });
      Object.defineProperty(file, 'webkitRelativePath', { configurable: true, value: path });
      files.push(file);
    }
    return files;
  } finally {
    await opened.reader.close().catch(() => {});
  }
};

const blobToDataUrl = (blob: Blob, mimeType: string): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(reader.error || new Error('贴图读取失败'));
  // blob.type 缺失或是 octet-stream 时强制换上推断出的 MIME——Pixi 靠 data URL
  // 的 MIME 挑解析器，octet-stream 会直接 [Loader.load] Failed to load。
  const needsRetype = !blob.type || blob.type === 'application/octet-stream';
  reader.readAsDataURL(needsRetype ? blob.slice(0, blob.size, mimeType) : blob);
});

/** 按文件头魔数嗅探真实图片类型；扩展名千奇百怪的模型包全靠它兜底。 */
export const sniffImageMime = async (blob: Blob): Promise<string | null> => {
  try {
    const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    return null;
  } catch {
    return null;
  }
};

interface Live2DRuntimePackage {
  entries: Map<string, Blob>;
  textureUrls: Map<string, Promise<string>>;
  source: 'stored-package' | 'persistent-cache' | 'source-zip' | 'legacy-zip';
  unpackMs: number;
}

interface BuiltinLive2DSettingsResult {
  settings: Record<string, any>;
  modelUrl: string;
  memoryHit: boolean;
  waitMs: number;
}

// Built-in variants are ordinary static files. Keep only the tiny parsed
// model3 manifest in JS memory; textures remain in the browser HTTP cache and
// are decoded by Pixi only when a visible canvas is mounted.
const builtinLive2DSettingsCache = new Map<string, Promise<Record<string, any>>>();

const builtinDocumentBase = (): string => {
  if (typeof document !== 'undefined' && document.baseURI) return document.baseURI;
  if (typeof location !== 'undefined' && location.href) return location.href;
  return 'http://localhost/';
};

const getBuiltinLive2DSettings = async (
  config: Live2DAvatarConfig,
  onProgress?: Live2DLoadProgress,
): Promise<BuiltinLive2DSettingsResult> => {
  if (!isBuiltinSullyLive2D(config)) throw new Error('内置 Live2D 配置缺少静态模型地址。');
  const startedAt = nowMs();
  const modelUrl = new URL(config.builtinModelUrl, builtinDocumentBase()).href;
  const cached = builtinLive2DSettingsCache.get(modelUrl);
  if (cached) {
    onProgress?.('正在从内置缓存恢复 Sully…');
    return { settings: await cached, modelUrl, memoryHit: true, waitMs: nowMs() - startedAt };
  }
  onProgress?.(`正在读取 Sully 内置${config.builtinQuality === 'hd' ? '高清' : '轻量'}模型…`);
  const pending = fetch(modelUrl, { cache: 'force-cache' })
    .then(async response => {
      if (!response.ok) throw new Error(`Sully 内置模型读取失败（HTTP ${response.status}）。`);
      return response.json() as Promise<Record<string, any>>;
    })
    .catch(error => {
      builtinLive2DSettingsCache.delete(modelUrl);
      throw error;
    });
  builtinLive2DSettingsCache.set(modelUrl, pending);
  while (builtinLive2DSettingsCache.size > 2) {
    const oldest = builtinLive2DSettingsCache.keys().next().value as string | undefined;
    if (!oldest || oldest === modelUrl) break;
    builtinLive2DSettingsCache.delete(oldest);
  }
  return { settings: await pending, modelUrl, memoryHit: false, waitMs: nowMs() - startedAt };
};

const cloneBuiltinSettings = (settings: Record<string, any>): Record<string, any> => (
  JSON.parse(JSON.stringify(settings)) as Record<string, any>
);

const hydrateBuiltinSettings = (
  rawSettings: Record<string, any>,
  modelUrl: string,
): { settings: Record<string, any>; textureUrls: string[] } => {
  const settings = cloneBuiltinSettings(rawSettings);
  const refs = settings.FileReferences;
  if (!refs?.Moc || !Array.isArray(refs.Textures) || !refs.Textures.length) {
    throw new Error('Sully 内置 model3.json 缺少 Moc 或 Textures。');
  }
  const absolute = (reference?: string): string | undefined => (
    reference ? new URL(reference, modelUrl).href : undefined
  );
  refs.Moc = absolute(refs.Moc);
  refs.Textures = refs.Textures.map((reference: string) => absolute(reference));
  refs.Physics = absolute(refs.Physics);
  refs.Pose = absolute(refs.Pose);
  refs.DisplayInfo = absolute(refs.DisplayInfo);
  refs.UserData = absolute(refs.UserData);
  for (const motions of Object.values(refs.Motions || {}) as Array<Array<{ File?: string; Sound?: string }>>) {
    for (const motion of motions) {
      motion.File = absolute(motion.File);
      motion.Sound = absolute(motion.Sound);
    }
  }
  for (const expression of refs.Expressions || []) expression.File = absolute(expression.File);
  settings.url = modelUrl;
  return { settings, textureUrls: refs.Textures.filter(Boolean) };
};

// Settings preview and the call stage normally open the same asset back to
// back. Keep one decompressed package in memory so the 8K texture and moc are
// not inflated from ZIP twice. A single-entry LRU bounds the extra memory when
// the user switches characters.
const live2DRuntimePackageCache = new Map<string, Promise<Live2DRuntimePackage>>();

const live2DRuntimeMemoryCacheKey = (assetId: string, quality: Live2DTextureQuality): string => `${assetId}:${quality}`;

const revokeRuntimeTextureUrls = async (pending: Promise<Live2DRuntimePackage>): Promise<void> => {
  try {
    const runtimePackage = await pending;
    const urls = await Promise.allSettled(runtimePackage.textureUrls.values());
    for (const result of urls) {
      if (result.status !== 'fulfilled' || !result.value.startsWith('blob:')) continue;
      URL.revokeObjectURL(result.value.split('#', 1)[0]);
    }
    runtimePackage.textureUrls.clear();
  } catch {
    // A failed package has no usable texture URLs to release.
  }
};

const removeLive2DRuntimeMemoryCache = (cacheKey: string): void => {
  const pending = live2DRuntimePackageCache.get(cacheKey);
  live2DRuntimePackageCache.delete(cacheKey);
  if (pending) void revokeRuntimeTextureUrls(pending);
};

const seedLive2DRuntimePackage = (
  assetId: string,
  entries: PackageEntry[],
  quality: Live2DTextureQuality = 'balanced',
): void => {
  const cacheKey = live2DRuntimeMemoryCacheKey(assetId, quality);
  const runtimePackage: Live2DRuntimePackage = {
    entries: new Map(entries.map(entry => [normalizePath(entry.path), entry.blob])),
    textureUrls: new Map<string, Promise<string>>(),
    source: 'stored-package',
    unpackMs: 0,
  };
  removeLive2DRuntimeMemoryCache(cacheKey);
  live2DRuntimePackageCache.set(cacheKey, Promise.resolve(runtimePackage));
  for (const cachedKey of live2DRuntimePackageCache.keys()) {
    if (cachedKey !== cacheKey) removeLive2DRuntimeMemoryCache(cachedKey);
  }
};

export type Live2DLoadProgress = (stage: string) => void;

const nowMs = (): number => globalThis.performance?.now?.() ?? Date.now();
const prettyMs = (value: number): string => value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`;

const getLive2DRuntimePackage = async (
  config: Live2DAvatarConfig,
  onProgress?: Live2DLoadProgress,
): Promise<{ runtimePackage: Live2DRuntimePackage; memoryHit: boolean; waitMs: number }> => {
  const startedAt = nowMs();
  const assetId = config.assetId;
  const quality = getLive2DTextureQuality(config);
  const cacheKey = live2DRuntimeMemoryCacheKey(assetId, quality);
  const cached = live2DRuntimePackageCache.get(cacheKey);
  if (cached) {
    live2DRuntimePackageCache.delete(cacheKey);
    live2DRuntimePackageCache.set(cacheKey, cached);
    onProgress?.(`正在从内存缓存恢复${quality === 'hd' ? '高清 4K' : '轻量 2K'}模型…`);
    return {
      runtimePackage: await cached,
      memoryHit: true,
      waitMs: nowMs() - startedAt,
    };
  }

  const pending = (async () => {
    let packageBlob: Blob | null = null;
    let source: Live2DRuntimePackage['source'];
    const persistentCacheId = live2DRuntimeCacheAssetId(assetId, quality);
    if (config.runtimePackageEncoding === 'store-v1') {
      packageBlob = await DB.getBlobAsset(persistentCacheId);
      if (packageBlob) {
        onProgress?.(`正在读取已优化的${quality === 'hd' ? '高清 4K' : '轻量 2K'}运行缓存…`);
        source = 'persistent-cache';
      } else {
        onProgress?.('正在读取免解压模型包…');
        packageBlob = await DB.getBlobAsset(assetId);
        source = 'stored-package';
      }
    } else {
      packageBlob = await DB.getBlobAsset(persistentCacheId);
      if (packageBlob) {
        onProgress?.(`正在读取${quality === 'hd' ? '高清 4K' : '轻量 2K'}运行缓存…`);
        source = 'persistent-cache';
      } else {
        onProgress?.(config.runtimePackageEncoding === 'zip-v1'
          ? `正在从源包逐张生成${quality === 'hd' ? '高清 4K' : '轻量 2K'}运行纹理…`
          : '首次优化旧模型：正在低内存解包并建立运行缓存…');
        packageBlob = await DB.getBlobAsset(assetId);
        source = config.runtimePackageEncoding === 'zip-v1' ? 'source-zip' : 'legacy-zip';
      }
    }
    if (!packageBlob) throw new Error('Live2D 模型文件已丢失，请重新导入。');
    const unpackStartedAt = nowMs();
    const optimized = await extractStreamingLive2DRuntimeArchive(
      packageBlob,
      config.modelPath,
      getLive2DTextureMaxDimension(config),
      stage => onProgress?.(source === 'persistent-cache' || source === 'stored-package'
        ? stage
        : `首次优化模型：${stage}`),
    );
    const pairs = optimized.entries.map(entry => [normalizePath(entry.path), entry.blob] as const);
    const runtimePackage: Live2DRuntimePackage = {
      entries: new Map(pairs),
      textureUrls: new Map<string, Promise<string>>(),
      source,
      unpackMs: nowMs() - unpackStartedAt,
    };

    // Existing users keep the original portable ZIP, while a derived STORE archive
    // is written once beside it. It is a disposable cache, so backup/restore can
    // omit it and rebuild naturally.
    if (source === 'legacy-zip' || source === 'source-zip' || optimized.resizedTextures.length > 0) {
      const cacheEntries = pairs.map(([path, blob]) => ({ path, blob }));
      void buildStoredLive2DPackage(cacheEntries)
        .then(blob => DB.putBlobAsset(persistentCacheId, blob))
        .then(() => console.info('[live2d] persistent STORE cache created', {
          assetId,
          files: pairs.length,
          resizedTextures: optimized.resizedTextures.length,
        }))
        .catch(error => console.warn('[live2d] persistent cache write skipped:', error));
    }
    return runtimePackage;
  })().catch(error => {
    removeLive2DRuntimeMemoryCache(cacheKey);
    throw error;
  });

  live2DRuntimePackageCache.set(cacheKey, pending);
  while (live2DRuntimePackageCache.size > 1) {
    const oldest = live2DRuntimePackageCache.keys().next().value as string | undefined;
    if (!oldest || oldest === cacheKey) break;
    removeLive2DRuntimeMemoryCache(oldest);
  }
  return {
    runtimePackage: await pending,
    memoryHit: false,
    waitMs: nowMs() - startedAt,
  };
};

export const createLive2DRuntimeTextureUrl = async (blob: Blob, path: string): Promise<string> => {
  // Magic sniffing beats extensions: VTube Studio packages sometimes use
  // texture.bin or extensionless images.
  const mimeType = await sniffImageMime(blob) || mimeForPath(path);
  const typedBlob = !blob.type || blob.type === 'application/octet-stream'
    ? blob.slice(0, blob.size, mimeType)
    : blob;
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    // Keep the Blob URL untouched. Pixi strips URL fragments before checking
    // extensions, so appending `#texture.png` still leaves it with no parser
    // and makes Assets.load resolve to null. The canvas selects the texture
    // parser explicitly before handing the settings to the Live2D engine.
    return URL.createObjectURL(typedBlob);
  }
  return blobToDataUrl(typedBlob, mimeType);
};

const getRuntimeTextureUrl = (
  runtimePackage: Live2DRuntimePackage,
  path: string,
  blob: Blob,
): Promise<string> => {
  let urlPromise = runtimePackage.textureUrls.get(path);
  if (!urlPromise) {
    urlPromise = createLive2DRuntimeTextureUrl(blob, path);
    runtimePackage.textureUrls.set(path, urlPromise);
  }
  return urlPromise;
};

export interface Live2DLoadTimings {
  cache: 'memory' | 'builtin' | Live2DRuntimePackage['source'];
  packageMs: number;
  manifestMs: number;
  textureMs: number;
  totalMs: number;
}

/**
 * Warm the expensive persistent package read and texture Blob URL creation
 * while the user is still on the role picker. Cubism/Pixi model construction is
 * intentionally left to the visible canvas.
 */
export const prewarmLive2DModelSource = async (
  config: Live2DAvatarConfig,
  onProgress?: Live2DLoadProgress,
): Promise<Live2DLoadTimings> => {
  const totalStartedAt = nowMs();
  if (isBuiltinSullyLive2D(config)) {
    const builtIn = await getBuiltinLive2DSettings(config, onProgress);
    const manifestStartedAt = nowMs();
    const { textureUrls } = hydrateBuiltinSettings(builtIn.settings, builtIn.modelUrl);
    const manifestMs = nowMs() - manifestStartedAt;
    const textureStartedAt = nowMs();
    await Promise.all(textureUrls.map(async url => {
      const response = await fetch(url, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`Sully 内置贴图预热失败（HTTP ${response.status}）。`);
      await response.blob();
    }));
    const textureMs = nowMs() - textureStartedAt;
    const timings: Live2DLoadTimings = {
      cache: builtIn.memoryHit ? 'memory' : 'builtin',
      packageMs: builtIn.waitMs,
      manifestMs,
      textureMs,
      totalMs: nowMs() - totalStartedAt,
    };
    onProgress?.(`Sully 预热完成：清单 ${prettyMs(timings.packageMs)}，贴图 ${prettyMs(textureMs)}`);
    console.info('[live2d] builtin prewarm complete', { assetId: config.assetId, ...timings });
    return timings;
  }
  const packageResult = await getLive2DRuntimePackage(config, onProgress);
  const { runtimePackage } = packageResult;
  const manifestStartedAt = nowMs();
  const settingsBlob = runtimePackage.entries.get(config.modelPath);
  if (!settingsBlob) throw new Error('模型包内找不到 model3.json，请重新导入。');
  const settings = JSON.parse(await settingsBlob.text()) as Model3Json & Record<string, any>;
  const textureRefs = settings.FileReferences?.Textures || [];
  const manifestMs = nowMs() - manifestStartedAt;
  const textureStartedAt = nowMs();
  await Promise.all(textureRefs.map((reference: string) => {
    const path = resolveModelReference(config.modelPath, reference);
    const blob = runtimePackage.entries.get(path);
    if (!blob) throw new Error(`模型包缺少 ${reference}`);
    return getRuntimeTextureUrl(runtimePackage, path, blob);
  }));
  const textureMs = nowMs() - textureStartedAt;
  const timings: Live2DLoadTimings = {
    cache: packageResult.memoryHit ? 'memory' : runtimePackage.source,
    packageMs: packageResult.waitMs,
    manifestMs,
    textureMs,
    totalMs: nowMs() - totalStartedAt,
  };
  onProgress?.(`模型预热完成：包 ${prettyMs(timings.packageMs)}，贴图 ${prettyMs(textureMs)}`);
  console.info('[live2d] prewarm complete', { assetId: config.assetId, ...timings });
  return timings;
};

/**
 * Pixi's texture parser cannot infer an image extension from a bare `blob:` URL.
 * The canvas explicitly selects Pixi's texture parser for these URLs, avoiding
 * the extra 33% Base64 copy that previously doubled mobile WebView pressure.
 */
export const loadLive2DModelSource = async (
  config: Live2DAvatarConfig,
  onProgress?: Live2DLoadProgress,
): Promise<{
  settings: Record<string, any>;
  textureUrls: string[];
  actionParameterIds: Record<string, string[]>;
  actionParameterValues: Record<string, Live2DActionParameterValue[]>;
  timings: Live2DLoadTimings;
  cleanup: () => void;
}> => {
  const totalStartedAt = nowMs();
  if (isBuiltinSullyLive2D(config)) {
    const builtIn = await getBuiltinLive2DSettings(config, onProgress);
    const manifestStartedAt = nowMs();
    const { settings, textureUrls } = hydrateBuiltinSettings(builtIn.settings, builtIn.modelUrl);
    const actionParameterIds = Object.fromEntries(config.actions
      .filter(action => action.parameterIds?.length)
      .map(action => [action.id, [...action.parameterIds!]]));
    const actionParameterValues = Object.fromEntries(config.actions
      .filter(action => action.parameterValues?.length)
      .map(action => [action.id, action.parameterValues!.map(parameter => ({ ...parameter }))]));
    const manifestMs = nowMs() - manifestStartedAt;
    const timings: Live2DLoadTimings = {
      cache: builtIn.memoryHit ? 'memory' : 'builtin',
      packageMs: builtIn.waitMs,
      manifestMs,
      textureMs: 0,
      totalMs: nowMs() - totalStartedAt,
    };
    onProgress?.(`Sully 内置${config.builtinQuality === 'hd' ? '高清' : '轻量'}模型就绪`);
    console.info('[live2d] builtin model source ready', { assetId: config.assetId, ...timings });
    return {
      settings,
      textureUrls,
      actionParameterIds,
      actionParameterValues,
      timings,
      cleanup: () => {},
    };
  }
  const packageResult = await getLive2DRuntimePackage(config, onProgress);
  const runtimePackage = packageResult.runtimePackage;
  const entries = runtimePackage.entries;
  const manifestStartedAt = nowMs();
  const settingsBlob = entries.get(config.modelPath);
  if (!settingsBlob) throw new Error('模型包内找不到 model3.json，请重新导入。');
  const settings = JSON.parse(await settingsBlob.text()) as Model3Json & Record<string, any>;
  const refs = settings.FileReferences;
  if (!refs) throw new Error('model3.json 缺少 FileReferences。');
  const prunedReferenceCount = pruneUnavailableLive2DReferences(settings, config.modelPath, entries.keys());
  if (prunedReferenceCount > 0) {
    console.warn(`[live2d] 运行时已跳过 ${prunedReferenceCount} 个缺失的可选文件引用。`);
  }
  const parameterEntries = await Promise.all(config.actions.map(async action => (
    [action.id, await discoverActionParameters(action, entries, config.modelPath)] as const
  )));
  const actionParameterIds = Object.fromEntries(parameterEntries
    .filter(([, parameters]) => parameters.ids.length)
    .map(([id, parameters]) => [id, parameters.ids]));
  const actionParameterValues = Object.fromEntries(parameterEntries
    .filter(([, parameters]) => parameters.values.length)
    .map(([id, parameters]) => [id, parameters.values]));
  const manifestMs = nowMs() - manifestStartedAt;

  // model3.json often omits VTube Studio hotkey expressions and idle motions.
  // Rehydrate every discovered/approved definition into the runtime settings so
  // the Cubism managers can actually play what the importer found.
  refs.Expressions ||= [];
  refs.Motions ||= {};
  for (const action of config.actions) {
    if (action.kind === 'expression' && action.file && !action.resetExpression) {
      const actionPath = resolveModelReference(config.modelPath, action.file);
      if (!entries.has(actionPath)) continue;
      const existing = refs.Expressions.find(item => item.File && resolveModelReference(config.modelPath, item.File) === actionPath);
      if (existing) existing.Name = action.expressionId || action.name;
      else refs.Expressions.push({ Name: action.expressionId || action.name, File: action.file });
    }
    if (action.kind === 'motion' && action.file) {
      const group = action.group || 'Imported';
      const actionPath = resolveModelReference(config.modelPath, action.file);
      if (!entries.has(actionPath)) continue;
      const motions = refs.Motions[group] ||= [];
      if (!motions.some(item => item.File && resolveModelReference(config.modelPath, item.File) === actionPath)) {
        motions.push({ Name: action.name, File: action.file });
      }
    }
  }

  const objectUrls: string[] = [];
  const objectUrlCache = new Map<string, string>();
  const textureUrlCache = new Map<string, string>();
  const resolveBlob = (reference: string): { path: string; blob: Blob } => {
    const path = resolveModelReference(config.modelPath, reference);
    const blob = entries.get(path);
    if (!blob) throw new Error(`模型包缺少 ${reference}`);
    return { path, blob };
  };
  const toObjectUrl = (reference?: string): string | undefined => {
    if (!reference) return undefined;
    const { path, blob } = resolveBlob(reference);
    const cached = objectUrlCache.get(path);
    if (cached) return cached;
    const url = URL.createObjectURL(blob);
    objectUrlCache.set(path, url);
    objectUrls.push(url);
    return url;
  };
  const toTextureUrl = async (reference: string): Promise<string> => {
    const { path, blob } = resolveBlob(reference);
    const cached = textureUrlCache.get(path);
    if (cached) return cached;
    const url = await getRuntimeTextureUrl(runtimePackage, path, blob);
    if (!url) throw new Error(`贴图 ${reference} 读取为空，文件可能已损坏。`);
    textureUrlCache.set(path, url);
    return url;
  };

  try {
    refs.Moc = toObjectUrl(refs.Moc);
    const textureStartedAt = nowMs();
    refs.Textures = await Promise.all((refs.Textures || []).map(texture => toTextureUrl(texture)));
    const textureMs = nowMs() - textureStartedAt;
    refs.Physics = toObjectUrl(refs.Physics);
    refs.Pose = toObjectUrl(refs.Pose);
    refs.DisplayInfo = toObjectUrl(refs.DisplayInfo);
    refs.UserData = toObjectUrl(refs.UserData);
    for (const motions of Object.values(refs.Motions || {})) {
      for (const motion of motions) {
        motion.File = toObjectUrl(motion.File);
        motion.Sound = toObjectUrl(motion.Sound);
      }
    }
    for (const expression of refs.Expressions || []) expression.File = toObjectUrl(expression.File);
    settings.url = 'live2d-package/model.model3.json';
    const timings: Live2DLoadTimings = {
      cache: packageResult.memoryHit ? 'memory' : runtimePackage.source,
      packageMs: packageResult.waitMs,
      manifestMs,
      textureMs,
      totalMs: nowMs() - totalStartedAt,
    };
    onProgress?.(`缓存就绪：模型包 ${prettyMs(timings.packageMs)}，贴图 ${prettyMs(textureMs)}`);
    console.info('[live2d] model source ready', {
      assetId: config.assetId,
      ...timings,
      archiveUnpackMs: runtimePackage.unpackMs,
    });
    return {
      settings,
      textureUrls: [...textureUrlCache.values()],
      actionParameterIds,
      actionParameterValues,
      timings,
      cleanup: () => objectUrls.splice(0).forEach(url => URL.revokeObjectURL(url)),
    };
  } catch (error) {
    objectUrls.forEach(url => URL.revokeObjectURL(url));
    throw error;
  }
};

export const findLive2DActionsForPerformance = (
  config: Live2DAvatarConfig,
  performance: { emotion?: string; gesture?: string; modelAction?: string },
): Live2DAction[] => {
  const allowed = getLive2DAIActions(config);
  if (performance.modelAction) {
    const explicit = allowed.find(action => action.id === performance.modelAction);
    if (explicit) return [explicit];
  }
  const wanted = new Set([performance.emotion, performance.gesture].filter(Boolean));
  const matches = allowed.filter(action => action.tags.some(tag => wanted.has(tag)));
  const expression = matches.find(action => action.kind === 'expression');
  const motion = matches.find(action => action.kind === 'motion');
  return [expression, motion].filter((action): action is Live2DAction => Boolean(action));
};

/** Build an uncompressed runtime archive so future loads only read entries. */
export const buildStoredLive2DPackage = async (entries: PackageEntry[]): Promise<Blob> => {
  const { BlobReader, BlobWriter, ZipWriter } = await import('@zip.js/zip.js');
  const output = new BlobWriter('application/zip');
  const writer = new ZipWriter(output, { useWebWorkers: false });
  try {
    for (const entry of entries) {
      await writer.add(normalizePath(entry.path), new BlobReader(entry.blob), {
        level: 0,
        useWebWorkers: false,
      });
    }
    return await writer.close();
  } catch (error) {
    await writer.close().catch(() => {});
    throw error;
  }
};

export interface Live2DPerformanceMix {
  expression?: Live2DAction;
  motions: Live2DAction[];
  params: Live2DAction[];
}

/**
 * Builds the conservative multi-layer plan used only by high-quality calls.
 * Expressions use Cubism's single expression manager, parameter presets are
 * composited by our envelope, and motion files run together only when their
 * declared parameter curves prove they do not compete with each other.
 */
export const buildLive2DPerformanceMix = (
  config: Live2DAvatarConfig,
  performance: {
    emotion?: string;
    gesture?: string;
    modelAction?: string;
    modelActions?: string[];
  },
  runtimeParameterIds: Record<string, string[]> = {},
): Live2DPerformanceMix => {
  const allowed = getLive2DAIActions(config);
  const allowedById = new Map(allowed.map(action => [action.id, action]));
  const requestedIds = [...new Set([
    ...(performance.modelActions || []),
    performance.modelAction,
  ].filter((id): id is string => Boolean(id)))].slice(0, 3);
  const explicit = requestedIds
    .map(id => allowedById.get(id))
    .filter((action): action is Live2DAction => Boolean(action));
  const wanted = new Set([performance.emotion, performance.gesture].filter(Boolean));
  const matches = allowed.filter(action => action.tags.some(tag => wanted.has(tag)));
  const unique = (actions: Live2DAction[]): Live2DAction[] => (
    [...new Map(actions.map(action => [action.id, action])).values()]
  );

  const expression = explicit.find(action => action.kind === 'expression')
    || matches.find(action => action.kind === 'expression' && action.tags.includes(performance.emotion || ''))
    || matches.find(action => action.kind === 'expression');

  const params = unique([
    ...explicit.filter(action => action.kind === 'params'),
    ...matches.filter(action => action.kind === 'params' && action.tags.includes(performance.emotion || '')),
    ...matches.filter(action => action.kind === 'params' && action.tags.includes(performance.gesture || '')),
  ]).slice(0, 2);

  const motionCandidates = unique([
    ...explicit.filter(action => action.kind === 'motion'),
    ...matches.filter(action => action.kind === 'motion' && action.tags.includes(performance.gesture || '')),
    ...matches.filter(action => action.kind === 'motion' && action.tags.includes(performance.emotion || '')),
    ...matches.filter(action => action.kind === 'motion'),
  ]);
  const motions: Live2DAction[] = [];
  for (const candidate of motionCandidates) {
    if (motions.length >= 2) break;
    if (!motions.length) {
      motions.push(candidate);
      continue;
    }
    const candidateIds = new Set(candidate.parameterIds || runtimeParameterIds[candidate.id] || []);
    if (!candidateIds.size) continue;
    const disjoint = motions.every(active => {
      if (active.group && candidate.group && active.group === candidate.group) return false;
      const activeIds = active.parameterIds || runtimeParameterIds[active.id] || [];
      return activeIds.length > 0 && activeIds.every(id => !candidateIds.has(id));
    });
    if (disjoint) motions.push(candidate);
  }

  return { expression, motions, params };
};
