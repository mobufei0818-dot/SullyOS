import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 角色的见面背景（characters.dateBackground）存的是 `blobref:` 令牌（见 utils/blobRef.ts），
// 二进制在 IndexedDB 里。令牌直接塞进裸 <img src> / CSS url() 就是一张裂图，所以：
//   · 场景布置页的预览底图和缩略图分别走 useBlobRefUrl / TokenImg；
//   · 查手机的桌面底图、以 TA 的身份体验（PersonaSim）的外壳底图也各自先解析再拼 url()；
//   · 上传时用 processImageToBlob + putImageBlob 产出令牌，别再写回 base64
//     （写端漏改的话，用户新设的背景又变成几 MB 的 data URL 塞在角色行里）。
const settingsSource = readFileSync(path.resolve(__dirname, '../components/date/DateSettings.tsx'), 'utf8');
const checkPhoneSource = readFileSync(path.resolve(__dirname, '../apps/CheckPhone.tsx'), 'utf8');
const personaSimSource = readFileSync(path.resolve(__dirname, '../apps/PersonaSim.tsx'), 'utf8');

describe('见面背景的 blobref 读写路径', () => {
  it('上传后存的是令牌，不是 base64', () => {
    expect(settingsSource).toContain('const blob = await processImageToBlob(file, { skipCompression: true });');
    expect(settingsSource).toContain('updateCharacter(char.id, { dateBackground: ref });');
    expect(settingsSource).not.toContain('updateCharacter(char.id, { dateBackground: base64 });');
  });

  it('场景布置页的预览底图先用 useBlobRefUrl 解析再拼进 CSS url()', () => {
    expect(settingsSource).toContain('const dateBackgroundUrl = useBlobRefUrl(char.dateBackground);');
    expect(settingsSource).toContain('backgroundImage: dateBackgroundUrl ?');
    expect(settingsSource).not.toContain('url(${char.dateBackground})');
  });

  it('场景布置页的背景缩略图走 TokenImg，不是裸 <img>', () => {
    expect(settingsSource).toContain('<TokenImg value={char.dateBackground}');
    expect(settingsSource).not.toContain('<img src={char.dateBackground}');
  });

  it('查手机的桌面底图先解析再拼，且解析发生在组件顶层（不能塞进 renderDesktop 里）', () => {
    expect(checkPhoneSource).toContain('const dateBackgroundUrl = useBlobRefUrl(targetChar?.dateBackground);');
    expect(checkPhoneSource).toContain('url("${dateBackgroundUrl}")');
    expect(checkPhoneSource).not.toContain('url(${targetChar!.dateBackground})');

    const hookAt = checkPhoneSource.indexOf('useBlobRefUrl(targetChar?.dateBackground)');
    const renderDesktopAt = checkPhoneSource.indexOf('const renderDesktop = () => {');
    expect(hookAt).toBeGreaterThan(-1);
    expect(renderDesktopAt).toBeGreaterThan(-1);
    expect(hookAt).toBeLessThan(renderDesktopAt);
  });

  it('PersonaSim 的外壳底图在 Shell 里解析一次，覆盖全部调用点', () => {
    expect(personaSimSource).toContain('const wallpaperUrl = useBlobRefUrl(wallpaper);');
    expect(personaSimSource).toContain('url("${wallpaperUrl}")');
    expect(personaSimSource).not.toContain('url(${wallpaper})');
  });
});
