import { beforeEach, describe, expect, it } from 'vitest';
import { DB } from './db';
import {
    VOICE_FAVORITES_INDEX_ASSET_ID,
    getVoiceFavoriteBlob,
    listVoiceFavorites,
    makeVoiceFavoriteId,
    removeVoiceFavorite,
    saveVoiceFavorite,
    sortVoiceFavorites,
    voiceFavoriteAudioAssetId,
    type VoiceFavorite,
} from './voiceFavorites';

const base = {
    source: 'chat' as const,
    sourceKey: 'char-1:message-1',
    charId: 'char-1',
    charName: 'Sully',
    sourceTimestamp: 100,
    originalText: '你好',
};

beforeEach(async () => {
    const prior = await listVoiceFavorites();
    await Promise.all(prior.map(item => DB.deleteAsset(voiceFavoriteAudioAssetId(item.id))));
    await DB.deleteAsset(VOICE_FAVORITES_INDEX_ASSET_ID);
});

describe('voice favorites repository', () => {
    it('uses a stable id and keeps metadata newest-first without loading audio', async () => {
        expect(makeVoiceFavoriteId('chat', base.sourceKey)).toBe(makeVoiceFavoriteId('chat', base.sourceKey));
        expect(makeVoiceFavoriteId('chat', base.sourceKey)).not.toBe(makeVoiceFavoriteId('call', base.sourceKey));

        await saveVoiceFavorite({ ...base, favoritedAt: 10, blob: new Blob(['a'], { type: 'audio/mpeg' }) });
        await saveVoiceFavorite({ ...base, source: 'date', sourceKey: 'date-1', favoritedAt: 20, blob: new Blob(['b'], { type: 'audio/ogg' }) });

        const items = await listVoiceFavorites();
        expect(items.map(item => item.source)).toEqual(['date', 'chat']);
        expect(items[0]).not.toHaveProperty('blob');
        expect((await getVoiceFavoriteBlob(items[0].id))?.type).toBe('audio/ogg');
    });

    it('upserts one source item and removes its separate audio asset', async () => {
        await saveVoiceFavorite({ ...base, favoritedAt: 10, blob: new Blob(['old']) });
        const updated = await saveVoiceFavorite({ ...base, originalText: '更新', blob: new Blob(['new']) });

        expect((await listVoiceFavorites())).toHaveLength(1);
        expect((await listVoiceFavorites())[0].originalText).toBe('更新');
        expect(await (await getVoiceFavoriteBlob(updated.id))?.text()).toBe('new');

        expect(await removeVoiceFavorite('chat', base.sourceKey)).toBe(true);
        expect(await listVoiceFavorites()).toEqual([]);
        expect(await getVoiceFavoriteBlob(updated.id)).toBeNull();
    });

    it('sorts by the source message time', () => {
        const favorite = (id: string, sourceTimestamp: number): VoiceFavorite => ({
            ...base,
            id,
            favoritedAt: id === 'old' ? 100 : 1,
            sourceTimestamp,
        });
        expect(sortVoiceFavorites([favorite('old', 1), favorite('new', 2)]).map(item => item.id)).toEqual(['new', 'old']);
    });
});
