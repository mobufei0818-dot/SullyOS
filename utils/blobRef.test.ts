import { describe, it, expect } from 'vitest';
import {
    isBlobRef, BLOBREF_PREFIX,
    putImageBlob, getBlobForRef, deleteBlobRef, deleteBlobRefIfUnreferenced,
    dataUrlToBlob, blobToDataUrl,
    migrateDataUrlToRef, migrateAppearancePresetBlobRefs, resolveBlobRefsDeep,
} from './blobRef';
import { DB, openDB } from './db';

// fake-indexeddb 已由 test-setup.ts 注入；本组用例锁住 base64 ⇄ Blob 迁移层的核心不变量：
// 令牌识别、Blob 存取、data URL 互转无损、深度解析（备份导出前把令牌变回 data:image）。

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function seedStore(name: string, records: any[]): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        const store = tx.objectStore(name);
        for (const r of records) store.put(r);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function clearStore(name: string): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        tx.objectStore(name).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

describe('isBlobRef', () => {
    it('只认 blobref: 前缀，data:/http/空 都不是', () => {
        expect(isBlobRef(BLOBREF_PREFIX + 'x')).toBe(true);
        expect(isBlobRef('data:image/png;base64,AAAA')).toBe(false);
        expect(isBlobRef('https://a.com/b.png')).toBe(false);
        expect(isBlobRef('')).toBe(false);
        expect(isBlobRef(undefined)).toBe(false);
        expect(isBlobRef(null)).toBe(false);
    });
});

describe('dataUrl ⇄ Blob 无损互转', () => {
    it('dataUrlToBlob 保留 mime 与字节', async () => {
        const blob = dataUrlToBlob(TINY_PNG);
        expect(blob.type).toBe('image/png');
        expect(blob.size).toBeGreaterThan(0);
        // 再转回 data URL 应与原串一致
        const back = await blobToDataUrl(blob);
        expect(back).toBe(TINY_PNG);
    });
});

describe('putImageBlob / getBlobForRef / deleteBlobRef', () => {
    it('存进去能按令牌取回同样字节，删除后取不到', async () => {
        const blob = dataUrlToBlob(TINY_PNG);
        const ref = await putImageBlob(blob);
        expect(isBlobRef(ref)).toBe(true);

        const got = await getBlobForRef(ref);
        expect(got).not.toBeNull();
        expect(await blobToDataUrl(got!)).toBe(TINY_PNG);

        await deleteBlobRef(ref);
        expect(await getBlobForRef(ref)).toBeNull();
    });

    it('非令牌一律返回 null', async () => {
        expect(await getBlobForRef('data:image/png;base64,AAAA')).toBeNull();
        expect(await getBlobForRef('https://x/y.png')).toBeNull();
    });
});

describe('deleteBlobRefIfUnreferenced', () => {
    it('外观预设仍引用时保留，引用移除后才删除', async () => {
        const ref = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await DB.saveAsset('appearance_preset_blobref_test', JSON.stringify({ wallpaper: ref }));

        expect(await deleteBlobRefIfUnreferenced(ref)).toBe(false);
        expect(await getBlobForRef(ref)).not.toBeNull();

        await DB.deleteAsset('appearance_preset_blobref_test');
        expect(await deleteBlobRefIfUnreferenced(ref)).toBe(true);
        expect(await getBlobForRef(ref)).toBeNull();
    });

    it('localStorage 皮肤备份仍引用时不会删除', async () => {
        const ref = await putImageBlob(dataUrlToBlob(TINY_PNG));
        localStorage.setItem('acnh_wallpaper_backup_test', ref);

        expect(await deleteBlobRefIfUnreferenced(ref)).toBe(false);
        expect(await getBlobForRef(ref)).not.toBeNull();

        localStorage.removeItem('acnh_wallpaper_backup_test');
        expect(await deleteBlobRefIfUnreferenced(ref)).toBe(true);
    });

    // 内容去重（utils/blobDedupe.ts）会把同一张图在十几个引用面上收敛成同一个令牌，
    // 于是「壁纸」和「发过的聊天图 / 相册 / 角色头像」很可能是同一个令牌。
    // 只查 assets + localStorage 的话，换壁纸就会把还被别处用着的图删掉。
    it.each([
        ['聊天记录', 'messages', { id: 9001, type: 'image', content: '<REF>' }],
        ['相册', 'gallery', { id: 'g_blobref_test', url: '<REF>' }],
        ['角色头像', 'characters', { id: 'c_blobref_test', name: '小明', avatar: '<REF>' }],
        ['角色小屋家具', 'characters', {
            id: 'c_blobref_room_test', name: '小明',
            roomConfig: { items: [{ id: 'i1', image: '<REF>' }] },
        }],
    ])('令牌只被%s引用时不删，那一面清掉后才删', async (_面, storeName, row) => {
        const ref = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await seedStore(storeName, [JSON.parse(JSON.stringify(row).replaceAll('<REF>', ref))]);

        try {
            expect(await deleteBlobRefIfUnreferenced(ref)).toBe(false);
            expect(await getBlobForRef(ref)).not.toBeNull();
        } finally {
            await clearStore(storeName);
        }

        expect(await deleteBlobRefIfUnreferenced(ref)).toBe(true);
        expect(await getBlobForRef(ref)).toBeNull();
    });
});

describe('migrateDataUrlToRef', () => {
    it('data: 迁移成令牌，且能取回原图', async () => {
        const ref = await migrateDataUrlToRef(TINY_PNG);
        expect(isBlobRef(ref)).toBe(true);
        const blob = await getBlobForRef(ref);
        expect(await blobToDataUrl(blob!)).toBe(TINY_PNG);
    });

    it('非法 data URL 迁移失败时原样返回，不抛错、不丢值', async () => {
        const bad = 'not-a-data-url';
        expect(await migrateDataUrlToRef(bad)).toBe(bad);
    });
});

describe('migrateAppearancePresetBlobRefs', () => {
    it('导入时立即迁移壁纸、锁屏和自定义图标，并复用相同图片 Blob', async () => {
        const source: any = {
            id: 'preset_import_test',
            name: '导入测试',
            createdAt: 1,
            theme: {
                hue: 88,
                saturation: 14,
                lightness: 46,
                wallpaper: TINY_PNG,
                lockWallpaper: TINY_PNG,
                darkMode: false,
            },
            customIcons: { chat: TINY_PNG },
        };

        const migrated = await migrateAppearancePresetBlobRefs(source);
        expect(isBlobRef(migrated.theme.wallpaper)).toBe(true);
        expect(migrated.theme.lockWallpaper).toBe(migrated.theme.wallpaper);
        expect(migrated.customIcons?.chat).toBe(migrated.theme.wallpaper);
        expect(await blobToDataUrl((await getBlobForRef(migrated.theme.wallpaper))!)).toBe(TINY_PNG);
        expect(source.theme.wallpaper).toBe(TINY_PNG);
    });
});

describe('resolveBlobRefsDeep（备份导出前令牌 → data:image）', () => {
    it('深度遍历把令牌就地换回 data URL，非令牌不动', async () => {
        const refA = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const refB = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const tree: any = {
            wallImage: refA,
            keep: 'https://x/y.png',
            gradient: 'linear-gradient(#fff,#000)',
            nested: { items: [{ image: refB }, { image: 'data:image/png;base64,AAAA' }] },
        };
        await resolveBlobRefsDeep(tree);
        expect(tree.wallImage).toBe(TINY_PNG);
        expect(tree.nested.items[0].image).toBe(TINY_PNG);
        // 非令牌保持原样
        expect(tree.keep).toBe('https://x/y.png');
        expect(tree.gradient).toBe('linear-gradient(#fff,#000)');
        expect(tree.nested.items[1].image).toBe('data:image/png;base64,AAAA');
    });

    it('令牌对应的 Blob 已不存在时置空串（图已丢，避免导出死令牌）', async () => {
        const ref = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await deleteBlobRef(ref);
        const tree: any = { a: ref };
        await resolveBlobRefsDeep(tree);
        expect(tree.a).toBe('');
    });
});
