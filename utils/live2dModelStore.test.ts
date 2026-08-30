import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import {
  buildStoredLive2DPackage,
  buildLive2DPerformanceMix,
  createLive2DRuntimeTextureUrl,
  downscaleOversizedLive2DTextures,
  extractStreamingLive2DRuntimeArchive,
  findLive2DActionsForPerformance,
  getLive2DTextureResizeTarget,
  getLive2DTextureMaxDimension,
  getLive2DTextureQuality,
  getLive2DAIActions,
  getActiveLive2DWardrobeParameters,
  getLive2DWardrobeActions,
  inferLive2DActionTags,
  inspectLive2DPackage,
  Live2DMissingFilesError,
  pruneUnavailableLive2DReferences,
  readLive2DTextureDimensions,
  removeLive2DWardrobeAction,
  sniffImageMime,
  upgradeLive2DAutoPermissions,
  type Live2DAvatarConfig,
} from './live2dModelStore';

const blob = (value = '') => new Blob([value], { type: 'application/octet-stream' });

const pngHeader = (width: number, height: number): Blob => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return new Blob([bytes], { type: 'image/png' });
};

afterEach(() => vi.unstubAllGlobals());

const modelJson = JSON.stringify({
  Version: 3,
  FileReferences: {
    Moc: 'model.moc3',
    Textures: ['textures/texture_00.png'],
    Motions: {
      Idle: [{ File: 'motions/idle.motion3.json' }],
      TapBody: [{ File: 'motions/hello_wave.motion3.json' }],
    },
    Expressions: [
      { Name: 'smile', File: 'expressions/happy.exp3.json' },
      { Name: 'anger', File: 'expressions/angry.exp3.json' },
    ],
  },
  Groups: [{ Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY', 'ParamMouthForm'] }],
});

const packageEntries = [
  { path: 'Skylar/Skylar.model3.json', blob: blob(modelJson) },
  { path: 'Skylar/model.moc3', blob: blob('moc') },
  { path: 'Skylar/textures/texture_00.png', blob: blob('png') },
  { path: 'Skylar/motions/idle.motion3.json', blob: blob('{}') },
  { path: 'Skylar/motions/hello_wave.motion3.json', blob: blob(JSON.stringify({
    Curves: [{ Target: 'Parameter', Id: 'ParamArmLA' }, { Target: 'Model', Id: 'EyeBlink' }],
  })) },
  { path: 'Skylar/expressions/happy.exp3.json', blob: blob(JSON.stringify({
    Parameters: [{ Id: 'ParamMouthForm', Value: 1, Blend: 'Overwrite' }],
  })) },
  { path: 'Skylar/expressions/angry.exp3.json', blob: blob('{}') },
];

describe('Live2D 模型导入解析', () => {
  it('把运行包写成 STORE 存档并保持路径与内容可读取', async () => {
    const repeated = 'x'.repeat(64 * 1024);
    const stored = await buildStoredLive2DPackage([
      { path: 'Model/model3.json', blob: new Blob([repeated]) },
    ]);
    const zip = await JSZip.loadAsync(await stored.arrayBuffer());
    expect(await zip.file('Model/model3.json')?.async('string')).toBe(repeated);
    expect(stored.size).toBeGreaterThan(64 * 1024);
  });

  it('从压缩 ZIP 逐项读取，并把 8K 纹理直接生成 2K 运行图', async () => {
    const close = vi.fn();
    const createBitmap = vi.fn(async () => ({ width: 2048, height: 1024, close }));
    class MockOffscreenCanvas {
      constructor(public width: number, public height: number) {}
      getContext() { return { drawImage: vi.fn() }; }
      async convertToBlob(options: { type: string }) {
        return new Blob(['streamed-2k'], { type: options.type });
      }
    }
    vi.stubGlobal('createImageBitmap', createBitmap);
    vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);

    const zip = new JSZip();
    zip.file('Model/Model.model3.json', JSON.stringify({
      Version: 3,
      FileReferences: { Moc: 'Model.moc3', Textures: ['texture.png'] },
    }));
    zip.file('Model/Model.moc3', 'moc');
    zip.file('Model/texture.png', await pngHeader(8192, 4096).arrayBuffer());
    const archive = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const progress = vi.fn();

    const result = await extractStreamingLive2DRuntimeArchive(
      archive,
      'Model/Model.model3.json',
      2048,
      progress,
    );

    expect(result.entries.map(entry => entry.path)).toEqual([
      'Model/Model.model3.json',
      'Model/Model.moc3',
      'Model/texture.png',
    ]);
    expect(await result.entries[2].blob.text()).toBe('streamed-2k');
    expect(result.resizedTextures).toEqual([expect.objectContaining({
      path: 'Model/texture.png',
      fromWidth: 8192,
      toWidth: 2048,
      toHeight: 1024,
    })]);
    expect(createBitmap).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({
      resizeWidth: 2048,
      resizeHeight: 1024,
    }));
    expect(close).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('低内存解包'));
  });

  it('运行纹理使用原始 Blob URL，不再复制为 Base64 或伪造扩展名', async () => {
    const createObjectURL = vi.fn(() => 'blob:live2d-texture');
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });

    const url = await createLive2DRuntimeTextureUrl(pngHeader(2048, 2048), 'Model/texture.bin');

    expect(url).toBe('blob:live2d-texture');
    expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/png' }));
    expect(url).not.toContain('base64');
    expect(url).not.toContain('#');
  });

  it('从 model3.json 解析动作、表情、标签与口型参数，自动开放安全动作', async () => {
    const result = await inspectLive2DPackage(packageEntries);
    expect(result.modelPath).toBe('Skylar/Skylar.model3.json');
    expect(result.texturePaths).toEqual(['Skylar/textures/texture_00.png']);
    expect(result.lipSyncParameterIds).toEqual(['ParamMouthOpenY', 'ParamMouthForm']);
    expect(result.actions).toHaveLength(4);
    expect(result.actions.filter(action => action.group !== 'Idle').every(action => action.permission === 'ai')).toBe(true);
    expect(result.actions.find(action => action.group === 'Idle')?.permission).toBe('manual');
    expect(result.actions.find(action => action.name === 'smile')).toMatchObject({
      kind: 'expression', tags: ['happy'], permission: 'ai', parameterIds: ['ParamMouthForm'],
      parameterValues: [{ id: 'ParamMouthForm', value: 1, blend: 'Overwrite' }],
    });
    expect(result.actions.find(action => action.group === 'TapBody')).toMatchObject({
      tags: expect.arrayContaining(['wave']),
      parameterIds: ['ParamArmLA'],
    });
  });

  it('模型引用缺文件时保留短提示，并向控制台返回完整路径诊断', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const entries = packageEntries.filter(entry => !entry.path.endsWith('texture_00.png'));
    try {
      await inspectLive2DPackage(entries);
      throw new Error('expected missing-file rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(Live2DMissingFilesError);
      expect((error as Live2DMissingFilesError).message).toContain('模型引用的文件不完整');
      expect((error as Live2DMissingFilesError).missingFiles).toEqual([
        expect.objectContaining({
          reference: 'textures/texture_00.png',
          resolvedPath: 'Skylar/textures/texture_00.png',
          referencedBy: 'Skylar/Skylar.model3.json',
        }),
      ]);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('完整缺失引用诊断'));
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Skylar/textures/texture_00.png'));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('缺失 exp3 等可选引用时像 VTube Studio 一样跳过，核心模型仍可导入', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const staleModel = JSON.parse(modelJson);
    staleModel.FileReferences.Physics = 'missing.physics3.json';
    staleModel.FileReferences.Expressions.push({ Name: '旧表情', File: '2旧表情.exp3.json' });
    staleModel.FileReferences.Motions.TapBody.push({ File: 'missing.motion3.json' });
    const entries = packageEntries.map(entry => entry.path.endsWith('.model3.json')
      ? { ...entry, blob: blob(JSON.stringify(staleModel)) }
      : entry);

    try {
      const result = await inspectLive2DPackage(entries);
      expect(result.modelPath).toBe('Skylar/Skylar.model3.json');
      expect(result.actions.some(action => action.file === '2旧表情.exp3.json')).toBe(false);
      expect(result.actions.some(action => action.file === 'missing.motion3.json')).toBe(false);
      expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('已忽略 3 个缺失的可选'));
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('运行前清理失效的可选引用，不让 Blob URL 转换阶段再次报错', () => {
    const settings: any = {
      FileReferences: {
        Moc: 'model.moc3',
        Textures: ['texture.png'],
        Physics: 'missing.physics3.json',
        Motions: {
          Tap: [
            { File: 'ok.motion3.json', Sound: 'missing.wav' },
            { File: 'missing.motion3.json' },
          ],
        },
        Expressions: [
          { Name: 'ok', File: 'ok.exp3.json' },
          { Name: 'missing', File: 'missing.exp3.json' },
        ],
      },
    };

    expect(pruneUnavailableLive2DReferences(settings, 'Model/model.model3.json', [
      'Model/model.moc3',
      'Model/texture.png',
      'Model/ok.motion3.json',
      'Model/ok.exp3.json',
    ])).toBe(4);
    expect(settings.FileReferences.Physics).toBeUndefined();
    expect(settings.FileReferences.Motions.Tap).toEqual([{ File: 'ok.motion3.json' }]);
    expect(settings.FileReferences.Expressions).toEqual([{ Name: 'ok', File: 'ok.exp3.json' }]);
    // 核心引用绝不由这个兼容清理器删除，缺失时应交给导入校验明确报错。
    expect(settings.FileReferences.Moc).toBe('model.moc3');
    expect(settings.FileReferences.Textures).toEqual(['texture.png']);
  });

  it('iOS/macOS ZIP 的 Unicode 分解文件名能与 model3 引用对应', async () => {
    const composed = 'café.exp3.json';
    const decomposed = composed.normalize('NFD');
    const unicodeModel = JSON.stringify({
      Version: 3,
      FileReferences: {
        Moc: 'model.moc3',
        Textures: ['texture.png'],
        Expressions: [{ Name: 'accent', File: composed }],
      },
    });
    const result = await inspectLive2DPackage([
      { path: 'Model/model.model3.json', blob: blob(unicodeModel) },
      { path: 'Model/model.moc3', blob: blob('moc') },
      { path: 'Model/texture.png', blob: blob('png') },
      { path: `Model/${decomposed}`, blob: blob('{}') },
    ]);

    expect(result.actions.find(action => action.name === 'accent')?.file).toBe(composed);
  });

  it('缺失诊断指出大小写错误和同名文件所在位置', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const entries = packageEntries
      .filter(entry => !entry.path.endsWith('texture_00.png'))
      .concat({ path: 'Skylar/Textures/TEXTURE_00.PNG', blob: blob('png') });
    try {
      await inspectLive2DPackage(entries);
      throw new Error('expected missing-file rejection');
    } catch (error) {
      const detail = (error as Live2DMissingFilesError).missingFiles[0];
      expect(detail.caseInsensitiveMatch).toBe('Skylar/Textures/TEXTURE_00.PNG');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('解析 VTube Studio 热键、未登记表情、待机动画和保存的构图', async () => {
    const bareModel = JSON.stringify({
      Version: 3,
      FileReferences: { Moc: 'model.moc3', Textures: ['texture.png'] },
    });
    const vtube = JSON.stringify({
      FileReferences: { Model: 'Skylar.model3.json', IdleAnimation: '循环动画.motion3.json' },
      SavedModelPosition: { Position: { x: 40, y: -30 }, Scale: { x: 1.25, y: 1.25 } },
      Hotkeys: [
        { Name: 'A爱心眼', Action: 'ToggleExpression', File: 'A爱心眼.exp3.json', IsActive: true, Triggers: { Trigger1: 'F3' } },
        { Name: '', Action: 'RemoveAllExpressions', File: '', IsActive: true, Triggers: { Trigger1: 'Alt', Trigger2: 'Q' } },
      ],
    });
    const result = await inspectLive2DPackage([
      { path: 'Skylar/Skylar.model3.json', blob: blob(bareModel) },
      { path: 'Skylar/Skylar.vtube.json', blob: blob(vtube) },
      { path: 'Skylar/model.moc3', blob: blob('moc') },
      { path: 'Skylar/texture.png', blob: blob('png') },
      { path: 'Skylar/A爱心眼.exp3.json', blob: blob('{}') },
      { path: 'Skylar/B猫耳.exp3.json', blob: blob('{}') },
      { path: 'Skylar/Mystery.exp3.json', blob: blob('{}') },
      { path: 'Skylar/循环动画.motion3.json', blob: blob('{}') },
    ]);

    expect(result.actions).toHaveLength(5);
    expect(result.actions.find(action => action.name === 'A爱心眼')).toMatchObject({
      kind: 'expression', hotkey: 'F3', source: 'vtube', tags: ['shy'], permission: 'ai',
    });
    expect(result.actions.find(action => action.resetExpression)).toMatchObject({ hotkey: 'Alt+Q', permission: 'manual' });
    expect(result.actions.find(action => action.name === 'B猫耳')?.source).toBe('discovered');
    expect(result.actions.find(action => action.name === 'Mystery')?.permission).toBe('ai');
    expect(result.actions.find(action => action.kind === 'motion')).toMatchObject({ group: 'Idle', source: 'vtube', permission: 'manual' });
    expect(result.framing).toEqual({ scale: 1.25, offsetX: 0.2, offsetY: 0.15 });
  });

  it('AI 调度只能命中白名单，显式请求被禁动作也会被忽略', () => {
    const config = {
      format: 'live2d',
      actions: [
        { id: 'expression-0', kind: 'expression', name: 'smile', file: 'smile.exp3.json', tags: ['happy'], permission: 'ai' },
        { id: 'motion-0', kind: 'motion', name: 'wave', file: 'wave.motion3.json', group: 'Tap', index: 0, tags: ['wave'], permission: 'manual' },
        { id: 'motion-1', kind: 'motion', name: 'secret', file: 'secret.motion3.json', group: 'Tap', index: 1, tags: ['wave'], permission: 'blocked' },
      ],
    } as Live2DAvatarConfig;
    expect(findLive2DActionsForPerformance(config, { emotion: 'happy', gesture: 'wave' }).map(action => action.id))
      .toEqual(['expression-0']);
    expect(findLive2DActionsForPerformance(config, { modelAction: 'motion-1' })).toEqual([]);
  });

  it('keeps wardrobe actions user-only even if stale data marks them as AI actions', () => {
    const config = {
      format: 'live2d',
      actions: [
        { id: 'expression-smile', kind: 'expression', name: 'smile', file: 'smile.exp3.json', tags: ['happy'], permission: 'ai' },
        { id: 'outfit-night', kind: 'expression', name: 'night outfit', file: 'night.exp3.json', tags: ['happy'], permission: 'ai', wardrobe: true },
      ],
    } as Live2DAvatarConfig;

    expect(getLive2DAIActions(config).map(action => action.id)).toEqual(['expression-smile']);
    expect(getLive2DWardrobeActions(config).map(action => action.id)).toEqual(['outfit-night']);
    expect(findLive2DActionsForPerformance(config, { modelAction: 'outfit-night', emotion: 'happy' }).map(action => action.id))
      .toEqual(['expression-smile']);
    expect(buildLive2DPerformanceMix(config, { modelActions: ['outfit-night'] }).expression).toBeUndefined();
  });

  it('removes a clothing choice without making its underlying action AI-callable', () => {
    const config = {
      format: 'live2d',
      actionPolicyVersion: 2,
      activeWardrobeActionId: 'outfit-night',
      actions: [
        { id: 'outfit-night', kind: 'expression', name: 'night', file: 'night.exp3.json', tags: [], permission: 'manual', wardrobe: true },
        { id: 'outfit-day', kind: 'expression', name: 'day', file: 'day.exp3.json', tags: [], permission: 'manual', wardrobe: true },
      ],
    } as unknown as Live2DAvatarConfig;
    const next = removeLive2DWardrobeAction(config, 'outfit-night');
    expect(next.activeWardrobeActionId).toBe('outfit-day');
    expect(next.actions.find(action => action.id === 'outfit-night')).toMatchObject({
      wardrobe: false,
      permission: 'manual',
    });
    expect(getLive2DAIActions(next)).toEqual([]);
  });

  it('旧模型一次性自动开放未分类原生动作，同时保留用户覆盖和待机动作', () => {
    const legacy = {
      format: 'live2d',
      actions: [
        { id: 'unknown-expression', kind: 'expression', name: 'Mystery', file: 'Mystery.exp3.json', source: 'discovered', tags: [], permission: 'manual' },
        { id: 'user-manual', kind: 'motion', name: '挥手', file: 'wave.motion3.json', group: 'Tap', index: 0, source: 'model3', tags: ['wave'], permission: 'manual' },
        { id: 'idle', kind: 'motion', name: '待机', file: 'idle.motion3.json', group: 'Idle', index: 0, source: 'model3', tags: ['idle'], permission: 'manual' },
        { id: 'custom', kind: 'params', name: '自建', file: '', source: 'custom', params: [{ id: 'ParamCheek', value: 1 }], tags: [], permission: 'manual' },
        { id: 'blocked', kind: 'expression', name: '禁用', file: 'blocked.exp3.json', source: 'discovered', tags: [], permission: 'blocked' },
      ],
    } as Live2DAvatarConfig;

    const upgraded = upgradeLive2DAutoPermissions(legacy);
    expect(upgraded.actionPolicyVersion).toBe(2);
    expect(upgraded.actions.map(action => [action.id, action.permission])).toEqual([
      ['unknown-expression', 'ai'],
      ['user-manual', 'manual'],
      ['idle', 'manual'],
      ['custom', 'manual'],
      ['blocked', 'blocked'],
    ]);
    expect(upgradeLive2DAutoPermissions(upgraded)).toBe(upgraded);
  });

  it('高质量混合保留专属表情、身体手势和参数层，只有参数不冲突的动作才并行', () => {
    const config = {
      format: 'live2d',
      lipSyncParameterIds: ['ParamMouthOpenY'],
      actions: [
        { id: 'expression-star', kind: 'expression', name: '星星眼', file: 'star.exp3.json', tags: ['happy'], permission: 'ai' },
        { id: 'motion-wave', kind: 'motion', name: '挥手', file: 'wave.motion3.json', group: 'Arm', index: 0, tags: ['wave'], permission: 'ai' },
        { id: 'motion-lean', kind: 'motion', name: '前倾', file: 'lean.motion3.json', group: 'Body', index: 0, tags: ['happy'], permission: 'ai' },
        { id: 'motion-clash', kind: 'motion', name: '另一种挥手', file: 'clash.motion3.json', group: 'Other', index: 0, tags: ['wave'], permission: 'ai' },
        { id: 'params-blush', kind: 'params', name: '脸红', file: '', params: [{ id: 'ParamCheek', value: 1 }], tags: ['shy'], permission: 'ai' },
      ],
    } as Live2DAvatarConfig;

    const mix = buildLive2DPerformanceMix(
      config,
      {
        emotion: 'happy',
        gesture: 'wave',
        modelActions: ['expression-star', 'motion-wave', 'params-blush'],
      },
      {
        'motion-wave': ['ParamArmLA'],
        'motion-lean': ['ParamBodyAngleX'],
        'motion-clash': ['ParamArmLA'],
      },
    );

    expect(mix.expression?.id).toBe('expression-star');
    expect(mix.motions.map(action => action.id)).toEqual(['motion-wave', 'motion-lean']);
    expect(mix.motions.map(action => action.id)).not.toContain('motion-clash');
    expect(mix.params.map(action => action.id)).toEqual(['params-blush']);
  });

  it('动作名称支持中英文标签推断', () => {
    expect(inferLive2DActionTags('你好挥手', 'hello.motion3.json')).toContain('wave');
    expect(inferLive2DActionTags('脸红 love')).toContain('shy');
    expect(inferLive2DActionTags('A星星眼')).toContain('happy');
    expect(inferLive2DActionTags('B麦克风')).toContain('explain');
  });

  it('贴图魔数嗅探：扩展名不可靠时按文件头识别 PNG/JPEG/WebP', async () => {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])]);
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
    const webp = new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0])]);
    const junk = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])]);
    expect(await sniffImageMime(png)).toBe('image/png');
    expect(await sniffImageMime(jpeg)).toBe('image/jpeg');
    expect(await sniffImageMime(webp)).toBe('image/webp');
    expect(await sniffImageMime(junk)).toBeNull();
  });

  it('resolves the selected wardrobe as a persistent parameter layer', () => {
    const config = {
      format: 'live2d',
      activeWardrobeActionId: 'outfit-night',
      actions: [
        {
          id: 'outfit-night', kind: 'expression', name: 'night', file: 'night.exp3.json',
          tags: [], permission: 'manual', wardrobe: true,
          parameterValues: [{ id: 'ParamWatermark', value: 0, blend: 'Overwrite' }],
        },
      ],
    } as unknown as Live2DAvatarConfig;

    expect(getActiveLive2DWardrobeParameters(config)).toEqual([
      { id: 'ParamWatermark', value: 0, blend: 'Overwrite' },
    ]);
    expect(getActiveLive2DWardrobeParameters({ ...config, activeWardrobeActionId: undefined })).toEqual([]);
  });

  it('只读文件头即可识别超大贴图，并按最长边 4096 等比计算降档尺寸', async () => {
    expect(await readLive2DTextureDimensions(pngHeader(8192, 4096))).toEqual({
      width: 8192,
      height: 4096,
      mimeType: 'image/png',
    });
    expect(getLive2DTextureResizeTarget(8192, 4096)).toEqual({ width: 4096, height: 2048 });
    expect(getLive2DTextureResizeTarget(2048, 4096)).toBeNull();
  });

  it('导入模型默认使用 2K 运行纹理，并允许显式切到 4K', () => {
    const base = { format: 'live2d', textureQuality: undefined } as Live2DAvatarConfig;
    expect(getLive2DTextureQuality(base)).toBe('balanced');
    expect(getLive2DTextureMaxDimension(base)).toBe(2048);
    expect(getLive2DTextureQuality({ ...base, textureQuality: 'hd' })).toBe('hd');
    expect(getLive2DTextureMaxDimension({ ...base, textureQuality: 'hd' })).toBe(4096);
  });

  it('导入时自动降档模型引用的超大贴图，并关闭临时位图释放解码内存', async () => {
    const close = vi.fn();
    const createBitmap = vi.fn(async () => ({ width: 4096, height: 2048, close }));
    const drawImage = vi.fn();
    class MockOffscreenCanvas {
      constructor(public width: number, public height: number) {}
      getContext() { return { drawImage }; }
      async convertToBlob(options: { type: string }) {
        return new Blob(['resized'], { type: options.type });
      }
    }
    vi.stubGlobal('createImageBitmap', createBitmap);
    vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);

    const original = pngHeader(8192, 4096);
    const progress = vi.fn();
    const result = await downscaleOversizedLive2DTextures(
      [{ path: 'Model/texture.png', blob: original }],
      ['Model/texture.png'],
      progress,
    );

    expect(createBitmap).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({
      resizeWidth: 4096,
      resizeHeight: 2048,
      resizeQuality: 'high',
    }));
    expect(drawImage).toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(result.entries[0].blob).not.toBe(original);
    expect(result.entries[0].blob.type).toBe('image/png');
    expect(result.resizedTextures).toEqual([expect.objectContaining({
      path: 'Model/texture.png',
      fromWidth: 8192,
      toWidth: 4096,
      toHeight: 2048,
    })]);
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('8192×4096'));
  });

  it('手机支持 WebCodecs 时按 2K 目标流式解码，不先展开 8K 位图', async () => {
    const frameClose = vi.fn();
    const decoderClose = vi.fn();
    const decoderInit = vi.fn();
    class MockImageDecoder {
      constructor(init: ImageDecoderInit) { decoderInit(init); }
      async decode() { return { complete: true, image: { close: frameClose } }; }
      close() { decoderClose(); }
    }
    class MockOffscreenCanvas {
      constructor(public width: number, public height: number) {}
      getContext() { return { drawImage: vi.fn() }; }
      async convertToBlob(options: { type: string }) {
        return new Blob(['webcodecs-2k'], { type: options.type });
      }
    }
    const createBitmap = vi.fn();
    vi.stubGlobal('ImageDecoder', MockImageDecoder);
    vi.stubGlobal('createImageBitmap', createBitmap);
    vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);

    const result = await downscaleOversizedLive2DTextures(
      [{ path: 'Model/texture.png', blob: pngHeader(8192, 4096) }],
      ['Model/texture.png'],
      undefined,
      2048,
    );

    expect(decoderInit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'image/png',
      desiredWidth: 2048,
      desiredHeight: 1024,
    }));
    expect(createBitmap).not.toHaveBeenCalled();
    expect(frameClose).toHaveBeenCalledOnce();
    expect(decoderClose).toHaveBeenCalledOnce();
    expect(await result.entries[0].blob.text()).toBe('webcodecs-2k');
  });

});
