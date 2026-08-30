import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 活动留存记录（characters 表的 specialMomentRecords.<活动key>.image）里那张大图要改存
// `blobref:<id>` 令牌（见 utils/blobRef.ts）：白色情人节是 canvas 画出来的明信片（300KB+），
// 520 是捏人器吐出来的带框定妆照（500KB+），两张都直接 base64 躺在角色行里。
//
// 令牌不是能直接用的 URL：塞进裸 <img src> 是一张裂图，塞给 a.download / fetch /
// Filesystem.writeFile 更是直接失败。所以写端要产令牌，读端要么走 TokenImg，
// 要么先 resolveRefToDataUrl 还原成真 base64。
const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');
const whiteDay = read('../components/WhiteDayEvent.tsx');
const like520 = read('../components/Like520Event.tsx');

describe('白色情人节明信片（specialMomentRecords.whiteday_2026.image）', () => {
    it('写端存的是令牌，不是 canvas 吐出来的 base64', () => {
        expect(whiteDay).toMatch(/putImageBlob\(dataUrlToBlob\(base64\)\)/);
        // 老写法：`image: base64,`
        expect(whiteDay).not.toMatch(/\bimage:\s*base64\b/);
    });

    it('回看页的明信片走 TokenImg，没有裸 <img> 吃 savedImage', () => {
        expect(whiteDay).toMatch(/<TokenImg\s+value=\{savedImage\}/);
        expect(whiteDay).not.toMatch(/<img[^>]*\{savedImage\}/);
    });

    it('重新下载前先把令牌还原成真 base64（a.download / fetch / Filesystem 都只认 data:）', () => {
        expect(whiteDay).toMatch(/resolveRefToDataUrl\(savedImage\)/);
        expect(whiteDay).not.toMatch(/downloadOrShare\(\s*savedImage/);
    });

    it('savedImage 没有被拼进 CSS url()', () => {
        expect(whiteDay).not.toMatch(/url\(\$\{[^}]*savedImage/);
    });
});

describe('520 定妆照（specialMomentRecords.like520_2026.image）', () => {
    it('写端存的是令牌，不是捏人器吐的 frameDataUrl', () => {
        expect(like520).toMatch(/putImageBlob\(dataUrlToBlob\(charChibi\.frameDataUrl\)\)/);
        // 老写法：`image: charChibi.frameDataUrl,`
        expect(like520).not.toMatch(/\bimage:\s*charChibi\.frameDataUrl\b/);
    });

    it('隔壁两张手办图仍然是 dataURL（canvas 合成大头贴要能同步开始加载，令牌过不去）', () => {
        expect(like520).toMatch(/charChibi:\s*\{\s*dataUrl:\s*charChibi\.transparentDataUrl/);
        expect(like520).toMatch(/userChibi:\s*\{\s*dataUrl:\s*userChibi\.transparentDataUrl/);
    });
});
