import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { assembleV2Backup, createV2ArrayFieldWriter, writeV2Backup } from './backupFormat';
import {
    BUILTIN_ROOM_ASSET_PREFIX,
    normalizeBuiltInRoomTemplateAssetsInPlace,
    normalizeCharacterRoomAssetsInPlace,
    resolveBuiltinRoomAssetUrl,
    toPortableBuiltinRoomAsset,
} from './roomTemplateAssets';

describe('built-in room template asset portability', () => {
    it('stores fetched template-relative assets without the current origin', () => {
        const template: any = {
            room: { wallImage: 'assets/wall.png', floorImage: 'linear-gradient(#fff,#eee)' },
            items: [{ image: 'assets/item-01.png' }],
        };

        normalizeBuiltInRoomTemplateAssetsInPlace(template, 'forest-cottage');

        expect(template.room.wallImage).toBe(`${BUILTIN_ROOM_ASSET_PREFIX}forest-cottage/assets/wall.png`);
        expect(template.room.floorImage).toBe('linear-gradient(#fff,#eee)');
        expect(template.items[0].image).toBe(`${BUILTIN_ROOM_ASSET_PREFIX}forest-cottage/assets/item-01.png`);
    });

    it('repairs legacy absolute URLs from another origin or deployment prefix', () => {
        expect(toPortableBuiltinRoomAsset(
            'http://localhost:5173/room-templates/blue-minimal/assets/item-07.png',
        )).toBe(`${BUILTIN_ROOM_ASSET_PREFIX}blue-minimal/assets/item-07.png`);

        expect(toPortableBuiltinRoomAsset(
            'https://old.example/SullyOS/room-templates/forest-cottage/assets/floor.png',
        )).toBe(`${BUILTIN_ROOM_ASSET_PREFIX}forest-cottage/assets/floor.png`);
    });

    it('resolves the same backup reference against the new deployment base', () => {
        const stored = `${BUILTIN_ROOM_ASSET_PREFIX}forest-cottage/assets/item-03.png`;

        expect(resolveBuiltinRoomAssetUrl(stored, {
            baseUrl: '/SullyOS/',
            pageHref: 'https://new.example/SullyOS/index.html',
        })).toBe('https://new.example/SullyOS/room-templates/forest-cottage/assets/item-03.png');

        expect(resolveBuiltinRoomAssetUrl(stored, {
            baseUrl: './',
            pageHref: 'https://pages.example/SullyOS/',
        })).toBe('https://pages.example/SullyOS/room-templates/forest-cottage/assets/item-03.png');
    });

    it('normalizes legacy character room URLs before full-backup serialization', () => {
        const character: any = {
            roomConfig: {
                wallImage: 'https://source.example/app/room-templates/blue-minimal/assets/wall.png',
                floorImage: 'https://images.example/custom-floor.png',
                items: [
                    { image: 'https://source.example/app/room-templates/blue-minimal/assets/item-02.png' },
                    { image: 'blobref:user-upload' },
                ],
            },
        };

        normalizeCharacterRoomAssetsInPlace(character);

        expect(character.roomConfig.wallImage).toBe(`${BUILTIN_ROOM_ASSET_PREFIX}blue-minimal/assets/wall.png`);
        expect(character.roomConfig.floorImage).toBe('https://images.example/custom-floor.png');
        expect(character.roomConfig.items[0].image).toBe(`${BUILTIN_ROOM_ASSET_PREFIX}blue-minimal/assets/item-02.png`);
        expect(character.roomConfig.items[1].image).toBe('blobref:user-upload');
    });

    it('survives the text-only v2 streaming-shard roundtrip and resolves on a new host', async () => {
        const source: any = {
            id: 'room-backup-char',
            roomConfig: {
                wallImage: 'https://old.example/SullyOS/room-templates/forest-cottage/assets/wall.png',
                floorImage: 'https://old.example/SullyOS/room-templates/forest-cottage/assets/floor.png',
                items: [{
                    id: 'chair',
                    image: 'https://old.example/SullyOS/room-templates/forest-cottage/assets/item-03.png',
                }],
            },
        };
        const zip = new JSZip();
        const writer = createV2ArrayFieldWriter(zip as any, 'characters');

        // Mirrors OSContext's text_only stream callback: normalize each IDB row before
        // it is serialized directly into a prewritten shard.
        normalizeCharacterRoomAssetsInPlace(source);
        writer.appendSync([source]);
        const characters = await writer.finish();
        const manifest = await writeV2Backup(zip as any, {}, {
            mode: 'text_only',
            prewrittenStores: { characters },
        });
        const archive = await zip.generateAsync({ type: 'uint8array' });
        const loaded = await JSZip.loadAsync(archive);
        const restored: any = await assembleV2Backup(loaded as any, manifest);

        expect(restored.characters).toHaveLength(1);
        expect(restored.characters[0].roomConfig.items[0].image)
            .toBe(`${BUILTIN_ROOM_ASSET_PREFIX}forest-cottage/assets/item-03.png`);
        expect(resolveBuiltinRoomAssetUrl(restored.characters[0].roomConfig.items[0].image, {
            baseUrl: '/NewDeploy/',
            pageHref: 'https://new.example/NewDeploy/',
        })).toBe('https://new.example/NewDeploy/room-templates/forest-cottage/assets/item-03.png');
    });

    it('leaves external images and unknown template-like URLs untouched', () => {
        expect(toPortableBuiltinRoomAsset('https://images.example/furniture.png')).toBe('https://images.example/furniture.png');
        expect(toPortableBuiltinRoomAsset('https://old.example/room-templates/custom-room/assets/chair.png'))
            .toBe('https://old.example/room-templates/custom-room/assets/chair.png');
    });
});
