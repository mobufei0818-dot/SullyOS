import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../types';
import {
  addCompanionModelOutfit,
  addUploadedCompanionOutfit,
  listCompanionModelOutfits,
  listUploadedCompanionOutfits,
  removeCompanionModelOutfit,
  removeUploadedCompanionOutfit,
  selectCompanionModelOutfit,
  selectUploadedCompanionOutfit,
  storeCompanionModelOutfit,
  type VideoAvatarConfig,
} from './companionWardrobe';

const live2d = (assetId: string): VideoAvatarConfig => ({
  version: 1,
  format: 'live2d',
  assetId,
  fileName: `${assetId}.zip`,
  modelPath: 'model.model3.json',
  byteLength: 10,
  fileCount: 3,
  importedAt: 1,
  lipSyncParameterIds: ['ParamMouthOpenY'],
  actions: [],
});

const vrm = (assetId: string): VideoAvatarConfig => ({
  version: 1,
  format: 'vrm',
  assetId,
  fileName: `${assetId}.vrm`,
  byteLength: 10,
  importedAt: 1,
});

const character = (patch: Partial<CharacterProfile> = {}): CharacterProfile => ({
  id: 'char-1',
  name: '角色',
  avatar: '',
  ...patch,
} as CharacterProfile);

describe('companion wardrobe', () => {
  it('adds and switches whole models without losing the inactive package', () => {
    const original = character({ videoAvatar: live2d('day') });
    const added = addCompanionModelOutfit(original, live2d('night'));
    expect(added.videoAvatar?.assetId).toBe('night');
    expect(added.videoAvatarWardrobe?.map(model => model.assetId)).toEqual(['day']);

    const withWardrobe = character(added);
    expect(listCompanionModelOutfits(withWardrobe).map(model => model.assetId)).toEqual(['night', 'day']);
    expect(selectCompanionModelOutfit(withWardrobe, 'day')).toMatchObject({
      videoAvatar: { assetId: 'day' },
      videoAvatarWardrobe: [{ assetId: 'night' }],
    });
  });

  it('rejects a different model format in the current wardrobe', () => {
    expect(() => addCompanionModelOutfit(character({ videoAvatar: live2d('l2d') }), vrm('vrm')))
      .toThrow('只能加入同类型模型');
  });

  it('stores a newly imported wardrobe model without activating it', () => {
    const original = character({ videoAvatar: live2d('safe') });
    const stored = storeCompanionModelOutfit(original, live2d('large-untested'));
    expect(stored.videoAvatar?.assetId).toBe('safe');
    expect(stored.videoAvatarWardrobe?.map(model => model.assetId)).toEqual(['large-untested']);
  });

  it('removes inactive and active whole-model outfits without leaving a stale pointer', () => {
    const original = character({
      videoAvatar: live2d('active'),
      videoAvatarWardrobe: [live2d('spare'), live2d('old-large')],
    });
    expect(removeCompanionModelOutfit(original, 'old-large')).toMatchObject({
      videoAvatar: { assetId: 'active' },
      videoAvatarWardrobe: [{ assetId: 'spare' }],
    });
    expect(removeCompanionModelOutfit(original, 'active')).toMatchObject({
      videoAvatar: { assetId: 'spare' },
      videoAvatarWardrobe: [{ assetId: 'old-large' }],
    });
    expect(removeCompanionModelOutfit(character({ videoAvatar: live2d('only') }), 'only'))
      .toEqual({ videoAvatar: undefined, videoAvatarWardrobe: [] });
  });

  it('keeps uploaded images and changes only the active pointer', () => {
    const first = addUploadedCompanionOutfit(undefined, {
      id: 'blobref:first', imageRef: 'blobref:first', fileName: 'first.png',
    });
    const second = addUploadedCompanionOutfit(first, {
      id: 'blobref:second', imageRef: 'blobref:second', fileName: 'second.gif',
    });
    expect(listUploadedCompanionOutfits(second).map(item => item.imageRef))
      .toEqual(['blobref:second', 'blobref:first']);
    expect(selectUploadedCompanionOutfit(second, 'blobref:first')).toMatchObject({
      source: 'upload', imageRef: 'blobref:first', fileName: 'first.png',
    });

    expect(removeUploadedCompanionOutfit(second, 'blobref:second')).toMatchObject({
      source: 'upload', imageRef: 'blobref:first', fileName: 'first.png',
      imageWardrobe: [{ imageRef: 'blobref:first' }],
    });
    expect(removeUploadedCompanionOutfit(first, 'blobref:first')).toMatchObject({
      source: 'upload', imageRef: undefined, imageWardrobe: [],
    });
  });
});
