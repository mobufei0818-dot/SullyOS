import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addUploadedCompanionOutfit } from './companionWardrobe';

// 外观设置里换 / 移除「桌面陪伴形象」时，会把旧令牌对应的 Blob 删掉。
//
// 可这个令牌通常不止顶层 imageRef 一处在用：衣柜（companionAvatar.imageWardrobe）会把
// 「现在穿的这套」原样固化成一条条目，令牌同时占着条目的 id 和 imageRef 两个值位
// （utils/companionWardrobe.ts）。「优化资源存储」的迁移也刻意让顶层与衣柜条目转成同一个令牌。
//
// 所以无条件删旧令牌 = 换一次形象，衣柜里那套旧衣服就永久裂图，再也切不回去穿。

const source = readFileSync(path.resolve(__dirname, '../apps/Appearance.tsx'), 'utf8');

const outfit = (ref: string, fileName: string, importedAt: number) => ({
    id: ref, imageRef: ref, fileName, mimeType: 'image/png', importedAt,
});

describe('衣柜确实跟顶层 imageRef 共用令牌', () => {
    it('导入一套，衣柜里就留下一条同令牌的条目', () => {
        const ref = 'blobref:b_outfit_a';
        const config = addUploadedCompanionOutfit(undefined, outfit(ref, '连衣裙.png', 1));

        expect(config.imageRef).toBe(ref);
        expect(config.imageWardrobe?.map(item => item.imageRef)).toEqual([ref]);
        expect(config.imageWardrobe?.map(item => item.id)).toEqual([ref]);
    });

    it('换穿新的一套之后，上一套仍留在衣柜里等着切回去', () => {
        const first = 'blobref:b_outfit_a';
        const second = 'blobref:b_outfit_b';
        const afterFirst = addUploadedCompanionOutfit(undefined, outfit(first, '连衣裙.png', 1));
        const afterSecond = addUploadedCompanionOutfit(afterFirst, outfit(second, '毛衣.png', 2));

        expect(afterSecond.imageRef).toBe(second);
        // 顶层已经不指着 first 了，但衣柜还指着 —— 这时候删 first 的 Blob 就是破图
        expect(afterSecond.imageWardrobe?.map(item => item.imageRef)).toEqual([first, second]);
    });
});

describe('换 / 移除桌面静态形象前先问一句衣柜', () => {
    it('守卫认 imageRef 与 id 两个值位，非数组的老数据也顶得住', () => {
        expect(source).toContain('const isCompanionOutfitKeptInWardrobe');
        expect(source).toContain('if (!Array.isArray(wardrobe)) return false;');
        expect(source).toContain('outfit?.imageRef === ref || outfit?.id === ref');
    });

    it('两处 deleteBlobRef(previousRef) 都被守卫拦着', () => {
        const calls = [...source.matchAll(/deleteBlobRef\(previousRef\)/g)];
        // 换图（handleCompanionPortraitUpload）与移除（removeCompanionUpload）各一处
        expect(calls).toHaveLength(2);
        for (const call of calls) {
            const before = source.slice(Math.max(0, call.index - 300), call.index);
            expect(before).toContain('!isCompanionOutfitKeptInWardrobe(');
        }
    });

    it('旧的无条件裸删写法不再存在', () => {
        expect(source).not.toMatch(/if \(previousRef && previousRef !== imageRef\) await deleteBlobRef\(previousRef\);/);
        expect(source).not.toMatch(/\n\s*await deleteBlobRef\(previousRef\);\s*\n\s*trackEvent/);
    });
});
