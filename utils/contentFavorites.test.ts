import { beforeEach, describe, expect, it } from 'vitest';
import type { GalleryImage, Message } from '../types';
import { DB } from './db';
import {
    CONTENT_FAVORITES_INDEX_ASSET_ID,
    contentFavoriteIdForMessage,
    favoriteImageAssetId,
    listContentFavorites,
    removeContentFavoriteById,
    resolveContentFavorite,
    saveGalleryImageContentFavorite,
    saveMessageContentFavorite,
} from './contentFavorites';

const CHAR_ID = 'content-favorite-test-char';

const message = (overrides: Partial<Message> = {}): Message => ({
    id: 701,
    charId: CHAR_ID,
    role: 'assistant',
    type: 'text',
    content: '只存在于原消息里的正文',
    timestamp: 100,
    ...overrides,
});

beforeEach(async () => {
    await DB.deleteAsset(CONTENT_FAVORITES_INDEX_ASSET_ID).catch(() => undefined);
    await DB.clearMessages(CHAR_ID).catch(() => undefined);
    const images = await DB.getGalleryImages(CHAR_ID).catch(() => []);
    await Promise.all(images.map(image => DB.deleteGalleryImage(image.id)));
});

describe('content favorites reference index', () => {
    it('keeps a lightweight chat snapshot readable after the original is deleted', async () => {
        const sourceId = await DB.saveMessage({
            charId: CHAR_ID,
            role: 'assistant',
            type: 'text',
            content: '只存在于原消息里的正文',
        });
        const source = message({ id: sourceId });
        await saveMessageContentFavorite(source, 'Sully');

        const items = await listContentFavorites();
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            kind: 'chat',
            messageId: source.id,
            charId: CHAR_ID,
        });
        expect(items[0].kind === 'chat' && items[0].snapshot?.content).toBe(source.content);

        await DB.deleteMessage(source.id);
        const resolved = await resolveContentFavorite((await listContentFavorites())[0]);
        expect('message' in resolved && resolved.message?.content).toBe(source.content);
        expect('sourceAvailable' in resolved && resolved.sourceAvailable).toBe(false);
    });

    it('deduplicates the same image across chat and gallery without storing media', async () => {
        const url = 'data:image/png;base64,QUJDREVGRw==';
        const sourceMessageId = await DB.saveMessage({
            charId: CHAR_ID,
            role: 'assistant',
            type: 'image',
            content: url,
        });
        const sourceMessage = message({ id: sourceMessageId, type: 'image', content: url });
        const galleryImage: GalleryImage = {
            id: 'favorite-gallery-702',
            charId: CHAR_ID,
            url,
            timestamp: 101,
        };

        await DB.saveGalleryImage(galleryImage);
        await saveMessageContentFavorite(sourceMessage, 'Sully');
        const linkedFromChat = (await listContentFavorites())[0];
        expect(linkedFromChat.kind === 'image' ? linkedFromChat.references : []).toHaveLength(2);
        await saveGalleryImageContentFavorite(galleryImage, 'Sully');

        const items = await listContentFavorites();
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ kind: 'image', id: contentFavoriteIdForMessage(sourceMessage) });
        expect(items[0].kind === 'image' && items[0].references).toHaveLength(2);
        const retainedAssetId = favoriteImageAssetId(items[0].kind === 'image' ? items[0].fingerprint : '');
        const rawIndex = JSON.stringify(await DB.getAssetRaw(CONTENT_FAVORITES_INDEX_ASSET_ID));
        expect(rawIndex).not.toContain(url);
        expect(rawIndex).not.toContain('base64');
        expect(await DB.getAssetRaw(retainedAssetId)).toBeNull();

        await DB.deleteMessage(sourceMessage.id);
        expect(await DB.getAssetRaw(retainedAssetId)).toBeNull();
        await DB.deleteGalleryImage(galleryImage.id);

        const retained = (await listContentFavorites())[0];
        const resolved = await resolveContentFavorite(retained);
        expect(resolved.favorite.kind).toBe('image');
        expect('imageUrl' in resolved && resolved.imageUrl).toBe(url);
        expect('reference' in resolved && resolved.reference?.source).toBe('favorite_asset');
        expect(await DB.getAssetRaw(retainedAssetId)).toMatchObject({ imageUrl: url });

        // If the same live image returns later, ownership moves back to that source and
        // the temporary favorite-owned media row is removed instead of duplicating it.
        await DB.saveGalleryImage(galleryImage);
        await saveGalleryImageContentFavorite(galleryImage, 'Sully');
        expect(await DB.getAssetRaw(retainedAssetId)).toBeNull();
        await DB.deleteGalleryImage(galleryImage.id);
        expect(await DB.getAssetRaw(retainedAssetId)).toMatchObject({ imageUrl: url });

        await removeContentFavoriteById(retained.id);
        expect(await DB.getAssetRaw(retainedAssetId)).toBeNull();
    });
});
