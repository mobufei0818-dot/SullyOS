import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  saveAssetRaw: vi.fn(),
  getAssetRaw: vi.fn(),
  deleteAsset: vi.fn(),
  getBlobAsset: vi.fn(),
  deleteBlobAsset: vi.fn(),
}));

vi.mock('./db', () => ({ DB: dbMock }));

import {
  getCompanionVoiceBlob,
  makeCompanionVoiceAssetId,
  saveCompanionVoiceBlob,
} from './companionVoiceAssets';

describe('companion voice Blob storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.saveAssetRaw.mockResolvedValue(undefined);
    dbMock.getAssetRaw.mockResolvedValue(null);
    dbMock.getBlobAsset.mockResolvedValue(null);
    dbMock.deleteBlobAsset.mockResolvedValue(undefined);
  });

  it('stores the complete Blob in the generic assets store used by ZIP backup', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mpeg' });
    const id = makeCompanionVoiceAssetId('startup', 'char/1');

    await saveCompanionVoiceBlob(id, blob);

    expect(id).toMatch(/^companion-startup-voice:char%2F1:/);
    expect(dbMock.saveAssetRaw).toHaveBeenCalledOnce();
    const stored = dbMock.saveAssetRaw.mock.calls[0][1];
    expect(stored.blob).toBe(blob);
    expect(stored.blob.size).toBe(4);
    expect(stored.mimeType).toBe('audio/mpeg');
  });

  it('migrates a legacy blob_assets voice on first read without losing bytes', async () => {
    const id = 'companion-touch-voice:char:old-pack:head:0';
    const legacy = new Blob(['legacy voice'], { type: 'audio/wav' });
    dbMock.getBlobAsset.mockResolvedValue(legacy);

    const restored = await getCompanionVoiceBlob(id);

    expect(restored).toBe(legacy);
    expect(await restored?.text()).toBe('legacy voice');
    expect(dbMock.saveAssetRaw).toHaveBeenCalledWith(id, expect.objectContaining({ blob: legacy, mimeType: 'audio/wav' }));
    expect(dbMock.deleteBlobAsset).toHaveBeenCalledWith(id);
  });

  it('never reuses an asset id across newly generated presets', () => {
    expect(makeCompanionVoiceAssetId('touch', 'char')).not.toBe(makeCompanionVoiceAssetId('touch', 'char'));
  });
});
