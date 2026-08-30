import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REF_SOURCE_STORES } from './blobGc';

// 「瑞一杯 / Spark」自己的两张图（assets 表的 spark_user_bg 与 spark_social_profile.avatar）
// 走 blobref 令牌：二进制在 IndexedDB，行里只留令牌。
//
// 这组用例是源码锚——写端一旦退回 processImage（吐 data URL）、或读端退回裸 <img src=...>，
// 都会在这里挂掉。写端和读端必须同进同退：只改一边就是「存了令牌但渲染不出来」或
// 「界面认令牌但库里还在攒 base64」。
const SOCIAL_APP = readFileSync(path.resolve(__dirname, '../apps/SocialApp.tsx'), 'utf8');

describe('Spark 主页背景与头像存 blobref 令牌', () => {
    it('写端产出令牌，不再往 assets 行里塞 data URL', () => {
        expect(SOCIAL_APP).toContain("import { processImageToBlob } from '../utils/file'");
        expect(SOCIAL_APP).toContain("import { putImageBlob } from '../utils/blobRef'");

        // 背景图：blob → 令牌 → 存 assets 行
        expect(SOCIAL_APP).toContain("const blob = await processImageToBlob(file, { skipCompression: true })");
        expect(SOCIAL_APP).toContain("await DB.saveAsset('spark_user_bg', ref)");

        // 头像：blob → 令牌 → 进 socialProfile（落库在 saveUserProfileChanges）
        expect(SOCIAL_APP).toContain("const blob = await processImageToBlob(file)");
        expect(SOCIAL_APP).toContain('setSocialProfile(prev => ({ ...prev, avatar: ref }))');

        // 吐 data URL 的那个 processImage 不该再出现在这个文件里
        expect(SOCIAL_APP).not.toMatch(/\bprocessImage\s*\(/);
    });

    it('读端认令牌：背景图走 TokenImg，没有裸 <img src={userBgImage}>', () => {
        expect(SOCIAL_APP).toContain('<TokenImg value={userBgImage}');
        expect(SOCIAL_APP).not.toMatch(/<img\s+src=\{userBgImage\}/);
        // 头像及其在帖子里的副本本来就走 TokenImg，一并钉住
        expect(SOCIAL_APP).toContain('<TokenImg value={socialProfile.avatar}');
        expect(SOCIAL_APP).toContain('<TokenImg value={post.authorAvatar}');
    });

    it('spark_* 所在的 assets 表在孤儿 GC 的引用面清单里（否则转出的图会被当垃圾删）', () => {
        expect(REF_SOURCE_STORES).toContain('assets');
    });
});
