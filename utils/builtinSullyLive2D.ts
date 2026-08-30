import type { CharacterProfile } from '../types';

export type BuiltinSullyLive2DQuality = 'balanced' | 'hd';
export type SullyLive2DConfig = Extract<NonNullable<CharacterProfile['videoAvatar']>, { format: 'live2d' }>;

export const BUILTIN_SULLY_DEFAULT_FRAMING = {
  scale: 1.1,
  offsetX: 0,
  offsetY: 0.04,
} as const;

const newDefaultFraming = () => ({ ...BUILTIN_SULLY_DEFAULT_FRAMING });
const framingMatches = (
  framing: SullyLive2DConfig['framing'],
  expected: NonNullable<SullyLive2DConfig['framing']>,
): boolean => Boolean(framing)
  && Math.abs(framing.scale - expected.scale) <= 0.03
  && Math.abs(framing.offsetX - expected.offsetX) <= 0.015
  && Math.abs(framing.offsetY - expected.offsetY) <= 0.015;

const VARIANTS: Record<BuiltinSullyLive2DQuality, {
  assetId: string;
  fileName: string;
  modelUrl: string;
  byteLength: number;
}> = {
  balanced: {
    assetId: 'builtin-sully-live2d-2k-v1',
    fileName: 'Sully · 内置 2K',
    modelUrl: 'sully/live2d-2k/Sully.model3.json',
    byteLength: 3_325_567,
  },
  hd: {
    assetId: 'builtin-sully-live2d-4k-v1',
    fileName: 'Sully · 高清 4K',
    modelUrl: 'sully/live2d-4k/Sully.model3.json',
    byteLength: 7_803_888,
  },
};

const BUILTIN_ACTIONS: SullyLive2DConfig['actions'] = [
  {
    id: 'expression-0',
    kind: 'expression',
    name: '失去高光',
    expressionId: '失去高光',
    file: '1.exp3.json',
    source: 'model3',
    parameterIds: ['Param12'],
    tags: ['sad'],
    permission: 'ai',
  },
  {
    id: 'expression-1',
    kind: 'expression',
    name: '抬手',
    expressionId: '抬手',
    file: '2.exp3.json',
    source: 'model3',
    parameterIds: ['Param6'],
    tags: ['wave'],
    permission: 'ai',
  },
  {
    id: 'expression-2',
    kind: 'expression',
    name: '戴上墨镜',
    expressionId: '戴上墨镜',
    file: '3.exp3.json',
    source: 'model3',
    parameterIds: ['Param7'],
    tags: ['happy'],
    permission: 'ai',
  },
  {
    id: 'expression-3',
    kind: 'expression',
    name: '生气',
    expressionId: '生气',
    file: '4.exp3.json',
    source: 'model3',
    parameterIds: ['ParamBrowLX', 'ParamBrowRX', 'ParamBrowLForm', 'ParamBrowRForm', 'ParamBrowRY', 'ParamBrowLY', 'ParamBrowLAngle', 'ParamEyeLSmile', 'ParamEyeRSmile'],
    tags: ['angry'],
    permission: 'ai',
  },
  {
    id: 'expression-4',
    kind: 'expression',
    name: '开心',
    expressionId: '开心',
    file: '5.exp3.json',
    source: 'model3',
    parameterIds: ['ParamEyeLSmile', 'ParamEyeRSmile', 'ParamEyeROpen', 'ParamEyeLOpen', 'ParamMouthForm', 'ParamBrowLAngle', 'ParamBrowLForm', 'ParamBrowRAngle', 'ParamBrowRForm'],
    tags: ['happy'],
    permission: 'ai',
  },
  {
    id: 'expression-5',
    kind: 'expression',
    name: '幸福',
    expressionId: '幸福',
    file: '6.exp3.json',
    source: 'model3',
    parameterIds: ['ParamEyeRSmile', 'ParamEyeLSmile', 'ParamMouthForm', 'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLAngle', 'ParamBrowRAngle', 'ParamBrowRForm', 'ParamBrowLForm'],
    tags: ['happy', 'shy'],
    permission: 'ai',
  },
  {
    id: 'expression-6',
    kind: 'expression',
    name: '难过',
    expressionId: '难过',
    file: '7.exp3.json',
    source: 'model3',
    parameterIds: ['ParamEyeLOpen', 'ParamEyeROpen', 'ParamBrowLAngle', 'ParamBrowRAngle', 'ParamMouthForm'],
    tags: ['sad'],
    permission: 'ai',
  },
];

const cloneActions = (): SullyLive2DConfig['actions'] => BUILTIN_ACTIONS.map(action => ({
  ...action,
  tags: [...action.tags],
  parameterIds: action.parameterIds ? [...action.parameterIds] : undefined,
}));

export const createBuiltinSullyLive2DConfig = (
  quality: BuiltinSullyLive2DQuality = 'balanced',
): SullyLive2DConfig => {
  const variant = VARIANTS[quality];
  return {
    version: 1,
    format: 'live2d',
    assetId: variant.assetId,
    fileName: variant.fileName,
    builtIn: true,
    builtinQuality: quality,
    builtinModelUrl: variant.modelUrl,
    builtinFramingVersion: 2,
    modelPath: 'Sully.model3.json',
    byteLength: variant.byteLength,
    fileCount: 12,
    importedAt: 0,
    actionPolicyVersion: 2,
    framing: newDefaultFraming(),
    companionFraming: newDefaultFraming(),
    lipSyncParameterIds: ['ParamMouthOpenY'],
    actions: cloneActions(),
  };
};

export const upgradeBuiltinSullyLive2DDefaults = (
  config: SullyLive2DConfig,
): SullyLive2DConfig => {
  if (!isBuiltinSullyLive2D(config) || config.builtinFramingVersion === 2) return config;
  const framingWasPreviousDefault = !config.framing
    || framingMatches(config.framing, { scale: 1.5, offsetX: 0, offsetY: 0 });
  const companionWasPreviousDefault = !config.companionFraming
    || framingMatches(config.companionFraming, { scale: 0.75, offsetX: 0, offsetY: 0 });
  return {
    ...config,
    builtinFramingVersion: 2,
    framing: framingWasPreviousDefault ? newDefaultFraming() : config.framing,
    companionFraming: companionWasPreviousDefault ? newDefaultFraming() : config.companionFraming,
  };
};

export const isBuiltinSullyLive2D = (
  config?: CharacterProfile['videoAvatar'] | null,
): config is SullyLive2DConfig & { builtIn: true; builtinModelUrl: string } => (
  config?.format === 'live2d'
  && config.builtIn === true
  && typeof config.builtinModelUrl === 'string'
  && config.builtinModelUrl.length > 0
);

export const setBuiltinSullyLive2DQuality = (
  config: SullyLive2DConfig,
  quality: BuiltinSullyLive2DQuality,
): SullyLive2DConfig => {
  if (!isBuiltinSullyLive2D(config)) return config;
  const variant = VARIANTS[quality];
  return {
    ...config,
    assetId: variant.assetId,
    fileName: variant.fileName,
    builtinQuality: quality,
    builtinModelUrl: variant.modelUrl,
    byteLength: variant.byteLength,
    fileCount: 12,
  };
};
