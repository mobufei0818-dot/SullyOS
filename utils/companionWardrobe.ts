import type { CharacterProfile, CompanionAvatarConfig } from '../types';

export type VideoAvatarConfig = NonNullable<CharacterProfile['videoAvatar']>;
export type UploadedCompanionOutfit = NonNullable<CompanionAvatarConfig['imageWardrobe']>[number];

const uniqueModels = (models: Array<VideoAvatarConfig | undefined>): VideoAvatarConfig[] => {
  const seen = new Set<string>();
  return models.filter((model): model is VideoAvatarConfig => {
    if (!model?.assetId || seen.has(model.assetId)) return false;
    seen.add(model.assetId);
    return true;
  });
};

export const listCompanionModelOutfits = (character?: CharacterProfile | null): VideoAvatarConfig[] => {
  const active = character?.videoAvatar;
  if (!active) return [];
  return uniqueModels([active, ...(character?.videoAvatarWardrobe || [])])
    .filter(model => model.format === active.format);
};

export const addCompanionModelOutfit = (
  character: CharacterProfile,
  model: VideoAvatarConfig,
): Pick<CharacterProfile, 'videoAvatar' | 'videoAvatarWardrobe'> => {
  const active = character.videoAvatar;
  if (active && active.format !== model.format) {
    throw new Error(`衣橱只能加入同类型模型：当前是 ${active.format.toUpperCase()}。`);
  }
  const pool = uniqueModels([active, ...(character.videoAvatarWardrobe || []), model]);
  return {
    videoAvatar: model,
    videoAvatarWardrobe: pool.filter(item => item.assetId !== model.assetId),
  };
};

/**
 * Put a same-format model into the wardrobe without changing the model that is
 * currently on stage. Wardrobe imports use this path so merely choosing a file
 * can never turn a large/untested package into the next desktop boot model.
 */
export const storeCompanionModelOutfit = (
  character: CharacterProfile,
  model: VideoAvatarConfig,
): Pick<CharacterProfile, 'videoAvatar' | 'videoAvatarWardrobe'> => {
  const active = character.videoAvatar;
  if (!active) return { videoAvatar: model, videoAvatarWardrobe: [] };
  if (active.format !== model.format) {
    throw new Error(`衣橱只能加入同类型模型：当前是 ${active.format.toUpperCase()}。`);
  }
  return {
    videoAvatar: active,
    videoAvatarWardrobe: uniqueModels([
      ...(character.videoAvatarWardrobe || []),
      model,
    ]).filter(item => item.assetId !== active.assetId),
  };
};

export const selectCompanionModelOutfit = (
  character: CharacterProfile,
  assetId: string,
): Pick<CharacterProfile, 'videoAvatar' | 'videoAvatarWardrobe'> | null => {
  const active = character.videoAvatar;
  if (!active) return null;
  const pool = listCompanionModelOutfits(character);
  const selected = pool.find(model => model.assetId === assetId && model.format === active.format);
  if (!selected) return null;
  return {
    videoAvatar: selected,
    videoAvatarWardrobe: pool.filter(model => model.assetId !== selected.assetId),
  };
};

/** Remove one whole-model outfit and pick a remaining model only when needed. */
export const removeCompanionModelOutfit = (
  character: CharacterProfile,
  assetId: string,
): Pick<CharacterProfile, 'videoAvatar' | 'videoAvatarWardrobe'> | null => {
  const active = character.videoAvatar;
  if (!active) return null;
  const pool = listCompanionModelOutfits(character);
  if (!pool.some(model => model.assetId === assetId)) return null;
  const remaining = pool.filter(model => model.assetId !== assetId);
  if (active.assetId !== assetId) {
    return {
      videoAvatar: active,
      videoAvatarWardrobe: remaining.filter(model => model.assetId !== active.assetId),
    };
  }
  const [nextActive, ...inactive] = remaining;
  return {
    videoAvatar: nextActive,
    videoAvatarWardrobe: inactive,
  };
};

const activeUploadedOutfit = (config?: CompanionAvatarConfig): UploadedCompanionOutfit | undefined => (
  config?.imageRef ? {
    id: config.imageRef,
    imageRef: config.imageRef,
    fileName: config.fileName,
    mimeType: config.mimeType,
    importedAt: config.importedAt,
  } : undefined
);

export const listUploadedCompanionOutfits = (
  config?: CompanionAvatarConfig,
): UploadedCompanionOutfit[] => {
  const seen = new Set<string>();
  return [activeUploadedOutfit(config), ...(config?.imageWardrobe || [])]
    .filter((item): item is UploadedCompanionOutfit => {
      if (!item?.imageRef || seen.has(item.imageRef)) return false;
      seen.add(item.imageRef);
      return true;
    });
};

export const addUploadedCompanionOutfit = (
  config: CompanionAvatarConfig | undefined,
  outfit: UploadedCompanionOutfit,
): CompanionAvatarConfig => {
  const items = listUploadedCompanionOutfits(config);
  if (!items.some(item => item.imageRef === outfit.imageRef)) items.push(outfit);
  return {
    version: 1,
    ...config,
    source: 'upload',
    imageRef: outfit.imageRef,
    fileName: outfit.fileName,
    mimeType: outfit.mimeType,
    importedAt: outfit.importedAt,
    imageWardrobe: items,
  };
};

export const selectUploadedCompanionOutfit = (
  config: CompanionAvatarConfig | undefined,
  imageRef: string,
): CompanionAvatarConfig | null => {
  const items = listUploadedCompanionOutfits(config);
  const selected = items.find(item => item.imageRef === imageRef);
  if (!selected) return null;
  return {
    version: 1,
    ...config,
    source: 'upload',
    imageRef: selected.imageRef,
    fileName: selected.fileName,
    mimeType: selected.mimeType,
    importedAt: selected.importedAt,
    imageWardrobe: items,
  };
};

/** Remove an uploaded PNG/GIF and keep the top-level active pointer valid. */
export const removeUploadedCompanionOutfit = (
  config: CompanionAvatarConfig | undefined,
  imageRef: string,
): CompanionAvatarConfig | null => {
  const items = listUploadedCompanionOutfits(config);
  if (!items.some(item => item.imageRef === imageRef)) return null;
  const remaining = items.filter(item => item.imageRef !== imageRef);
  const selected = config?.imageRef === imageRef
    ? remaining[0]
    : remaining.find(item => item.imageRef === config?.imageRef) || remaining[0];
  return {
    version: 1,
    ...config,
    source: 'upload',
    imageRef: selected?.imageRef,
    fileName: selected?.fileName,
    mimeType: selected?.mimeType,
    importedAt: selected?.importedAt,
    imageWardrobe: remaining,
  };
};
