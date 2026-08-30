// Cubism 5.3 exports moc3 file version 6. The legacy hosting URL currently
// serves Core 5.1 (latest moc3 version 5), which rejects those models.
const OFFICIAL_CUBISM_CORE = 'https://cubism.live2d.com/sdk-web/core/06/live2dcubismcore.min.js';
const REQUIRED_MOC_VERSION = 6;
const CUBISM_5_MOC_VERSION = 5;

type CubismCoreGlobal = {
  Version?: {
    csmGetLatestMocVersion?: () => number;
  };
};

let corePromise: Promise<void> | null = null;
let runtimePromise: Promise<typeof import('untitled-pixi-live2d-engine/cubism')> | null = null;

const getCore = (): CubismCoreGlobal | undefined =>
  (window as Window & { Live2DCubismCore?: CubismCoreGlobal }).Live2DCubismCore;

const getLatestMocVersion = (): number | null => {
  try {
    const version = getCore()?.Version?.csmGetLatestMocVersion?.();
    return typeof version === 'number' && Number.isFinite(version) ? version : null;
  } catch {
    return null;
  }
};

const hasCompatibleCore = (): boolean => (getLatestMocVersion() ?? 0) >= REQUIRED_MOC_VERSION;
// Keep existing loader call sites strict: an older Core is not considered loaded.
const hasCore = hasCompatibleCore;

const loadScript = (src: string): Promise<void> => new Promise((resolve, reject) => {
  const existing = document.querySelector<HTMLScriptElement>(`script[data-live2d-core="${src}"]`);
  if (existing) {
    if (hasCore()) resolve();
    else existing.addEventListener('load', () => hasCore() ? resolve() : reject(new Error('Cubism Core 未注册')), { once: true });
    return;
  }
  const script = document.createElement('script');
  script.src = src;
  script.async = true;
  script.dataset.live2dCore = src;
  script.onload = () => hasCore() ? resolve() : reject(new Error('Cubism Core 脚本已加载，但没有注册运行时。'));
  script.onerror = () => {
    script.remove();
    reject(new Error(`无法加载 ${src}`));
  };
  document.head.appendChild(script);
});

const findLocalCore = async (): Promise<string | null> => {
  const local = new URL('vendor/live2dcubismcore.min.js', document.baseURI).toString();
  try {
    const response = await fetch(local, { method: 'HEAD', cache: 'no-store' });
    const contentType = response.headers.get('content-type') || '';
    return response.ok && /javascript|ecmascript|octet-stream/i.test(contentType) ? local : null;
  } catch {
    return null;
  }
};

/** Load the proprietary Cubism Core without bundling or redistributing it. */
export const ensureLive2DCubismCore = (): Promise<void> => {
  if (typeof window === 'undefined') return Promise.reject(new Error('Live2D 只能在浏览器中运行。'));
  if (hasCore()) return Promise.resolve();
  if (corePromise) return corePromise;
  corePromise = (async () => {
    const local = await findLocalCore();
    if (local) {
      try {
        await loadScript(local);
        return;
      } catch {
        // A stale/corrupt local file should not prevent the official fallback.
      }
    }
    try {
      await loadScript(OFFICIAL_CUBISM_CORE);
    } catch {
      throw new Error('Cubism Core 加载失败。请联网重试，或将官方 live2dcubismcore.min.js 放进 public/vendor/。');
    }
  })().catch(error => {
    corePromise = null;
    throw error;
  });
  return corePromise;
};

/** Start the heavy Cubism framework chunk early while the user is choosing/importing a model. */
export const preloadLive2DRuntime = (): Promise<typeof import('untitled-pixi-live2d-engine/cubism')> => {
  if (runtimePromise) return runtimePromise;
  runtimePromise = ensureLive2DCubismCore()
    .then(() => import('untitled-pixi-live2d-engine/cubism'))
    .catch(error => {
      runtimePromise = null;
      throw error;
    });
  return runtimePromise;
};

/**
 * Core 6 moved the combined drawable/offscreen render order to Model.
 * The current Pixi adapter still reads the pre-5.3 drawables.renderOrders field.
 * Bridge that field for v6 models that do not use the new offscreen feature.
 */
export const bridgeCubism6RenderOrders = (model: unknown): { offscreenCount: number } => {
  const internal = (model as any)?.internalModel;
  const rawModel = internal?.coreModel?._model;
  const drawables = rawModel?.drawables;
  const offscreenCount = Number(rawModel?.offscreens?.count ?? 0);
  const renderOrders = rawModel?.getRenderOrders?.() ?? rawModel?.renderOrders;

  if (!drawables || drawables.renderOrders || !renderOrders) {
    return { offscreenCount };
  }

  if (offscreenCount > 0) {
    throw new Error(
      `This Cubism 5.3 model uses ${offscreenCount} offscreen object(s), which require the Cubism 5.3 renderer.`,
    );
  }

  const drawableCount = Number(drawables.count ?? renderOrders.length);
  drawables.renderOrders = typeof renderOrders.subarray === 'function'
    ? renderOrders.subarray(0, drawableCount)
    : renderOrders;

  return { offscreenCount };
};

type CubismMaskCompatibility = {
  highPrecisionMaskEnabled: boolean;
  mocVersion: number | null;
};

/**
 * Cubism 5 models can use small facial clipping regions that the adapter's
 * complexity heuristic leaves in the shared low-resolution mask atlas. Force
 * those models onto the per-drawable mask path so eye and mouth masks retain
 * their alpha edges. Older Cubism models keep the adapter's existing policy.
 */
export const enableCubism5HighPrecisionMasks = (model: unknown): CubismMaskCompatibility => {
  const internal = (model as any)?.internalModel;
  const renderer = internal?.renderer;
  let mocVersion: number | null = null;

  try {
    const version = internal?.coreModel?.__moc?.getMocVersion?.();
    if (typeof version === 'number' && Number.isFinite(version)) mocVersion = version;
  } catch {
    // A third-party adapter may not expose the moc wrapper. Keep its default.
  }

  if (mocVersion === null || mocVersion < CUBISM_5_MOC_VERSION) {
    return {
      highPrecisionMaskEnabled: Boolean(renderer?.isUsingHighPrecisionMask?.()),
      mocVersion,
    };
  }

  const canEnable = typeof renderer?.useHighPrecisionMask === 'function';
  if (canEnable) renderer.useHighPrecisionMask(true);
  return {
    highPrecisionMaskEnabled: Boolean(renderer?.isUsingHighPrecisionMask?.() ?? canEnable),
    mocVersion,
  };
};
