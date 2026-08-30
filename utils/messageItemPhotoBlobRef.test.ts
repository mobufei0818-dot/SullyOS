import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 520 活动的合照（canvas 生成的 1200×780 PNG，聊天卡片里最大的一张图）要改存
// `blobref:<id>` 令牌（见 utils/blobRef.ts）。令牌塞进裸 <img src> 就是一张裂图，
// 所以气泡里的小图和展开态的大图都必须走认令牌的 TokenImg。
const source = readFileSync(path.resolve(__dirname, '../components/chat/MessageItem.tsx'), 'utf8');

describe('520 合照的 blobref 渲染路径', () => {
    it('两处合照都走 TokenImg', () => {
        const hits = source.match(/<TokenImg value=\{data\.photoDataUrl\}/g) || [];
        // 气泡里的小图 + 点开的大图
        expect(hits).toHaveLength(2);
    });

    it('文件里不再有任何裸 <img> 直接吃 photoDataUrl', () => {
        expect(source).not.toMatch(/<img[^>]*photoDataUrl/);
        expect(source).not.toContain('src={data.photoDataUrl}');
    });

    it('photoDataUrl 也没有被拼进 CSS url()', () => {
        expect(source).not.toMatch(/url\(\$\{[^}]*photoDataUrl/);
    });
});
