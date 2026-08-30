import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 见面（DateApp）的立绘和背景，字段里存的可能是 `blobref:` 令牌（见 utils/blobRef.ts）。
// 令牌塞进裸 <img src> / CSS url() 就是一张裂图，所以这两处必须走认令牌的渲染路径：
// 立绘用 TokenImg，背景用 useBlobRefUrl 解析后再拼。
//
// 这份守卫还钉住另一条：认令牌之前，这里靠「看到令牌就躲开、退回 char.avatar」硬撑；
// char.avatar 本身也会是令牌（一键优化会把它转成令牌），于是躲开等于换一张同样裂的图。
// 挑选逻辑里不该再出现任何 `!isBlobRef(...)` 的过滤。
const source = readFileSync(path.resolve(__dirname, '../components/date/DateSession.tsx'), 'utf8');

describe('见面立绘 / 背景的 blobref 渲染路径', () => {
  it('立绘走 TokenImg，不是裸 <img>', () => {
    expect(source).toContain('<TokenImg value={currentSprite}');
    expect(source).not.toContain('<img src={currentSprite}');
  });

  it('背景先用 useBlobRefUrl 解析再拼进 CSS url()', () => {
    expect(source).toContain('const bgImageUrl = useBlobRefUrl(bgImage)');
    expect(source).toContain('backgroundImage: bgImageUrl ?');
    expect(source).not.toContain('backgroundImage: bgImage ?');
  });

  it('挑立绘时不再跳过令牌，也不把令牌换成 char.avatar', () => {
    expect(source).not.toMatch(/!isBlobRef\s*\(/);
    expect(source).not.toContain('isBlobRef(restoredSprite.src)');
  });

  it('currentSprite state 里存的是原始字段值，解析只发生在渲染那一刻', () => {
    // inferSpriteKey 靠「立绘值 === sprites 表里的值」反查情绪 key。
    // 一旦把解析后的 objectURL 存进 state，这个比对就永远查不到键。
    expect(source).toContain('Object.entries(sprites).find(([, value]) => value === src)');
    expect(source).not.toMatch(/setCurrentSprite\([^)]*Url[)\s]/);
  });
});
