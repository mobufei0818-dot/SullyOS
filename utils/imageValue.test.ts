import { describe, it, expect } from 'vitest';
import { isImageValue, putImageBlob, dataUrlToBlob } from './blobRef';

// 头像、店员、贴纸这类字段是两用的：可以是图，也可以只填一个 emoji。界面上到处都有
// 「是图就 <img>，不是图就当文字画出来」的分叉。判断漏认一种图片形态，那种图就会被当成
// 文字直接印在界面上——不报错也不破图，只是明晃晃地显示出一串内部标识。
// 这组用例钉住四种形态都算图、纯文字都不算。

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('是图还是文字', () => {
    it('blobref 令牌算图（漏认这条，令牌会被当文字画在界面上）', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        expect(isImageValue(token)).toBe(true);
    });

    it('内嵌 data URL、http(s) 外链、站内绝对路径都算图', () => {
        expect(isImageValue(TINY_PNG)).toBe(true);
        expect(isImageValue('https://example.com/a.png')).toBe(true);
        expect(isImageValue('http://example.com/a.png')).toBe(true);
        expect(isImageValue('/assets/room/wall.png')).toBe(true);
    });

    it('emoji 和普通文字不算图', () => {
        expect(isImageValue('🐱')).toBe(false);
        expect(isImageValue('小明')).toBe(false);
        expect(isImageValue('A')).toBe(false);
    });

    it('空值一律不算图', () => {
        expect(isImageValue('')).toBe(false);
        expect(isImageValue(undefined)).toBe(false);
        expect(isImageValue(null)).toBe(false);
        expect(isImageValue(123)).toBe(false);
    });

    it('长得像但不是的：不会把 database / httpd 这类词当成图', () => {
        // 老写法是 startsWith('data') / startsWith('http')，不带冒号和斜杠，这两个会误判
        expect(isImageValue('database')).toBe(false);
        expect(isImageValue('httpd 服务')).toBe(false);
    });
});
