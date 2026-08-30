import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 桌面小组件图（OSTheme.launcherWidgets，槽位 tl / tr / wide / dsq）存的是 `blobref:` 令牌
// （见 utils/blobRef.ts），二进制在 IndexedDB 里。令牌塞进裸 <img src> 就是一张裂图，所以：
//   · 桌面（Launcher）和外观设置页（Appearance）的每一处缩略图都走 TokenImg；
//   · 上传时用 processImageToBlob + putImageBlob 产出令牌，且必须原样带上各槽位的
//     maxWidth（wide 800 / dsq 600 / 其余 500）与 quality 0.9——换成 skipCompression
//     等于把用户的图从压缩过的变成原图直存，体积翻几倍；
//   · OSContext 往 assets 表写 widget_<slot> 时不能按 `data:` 前缀挑着存：令牌不带这个
//     前缀，挑的结果是图只剩 localStorage 一份，下次启动小组件直接没了。
const launcherSource = readFileSync(path.resolve(__dirname, '../apps/Launcher.tsx'), 'utf8');
const appearanceSource = readFileSync(path.resolve(__dirname, '../apps/Appearance.tsx'), 'utf8');
const osContextSource = readFileSync(path.resolve(__dirname, '../context/OSContext.tsx'), 'utf8');

describe('桌面小组件图的 blobref 读写路径', () => {
  it('上传后存的是令牌，不是 base64', () => {
    expect(appearanceSource).toContain('const blob = await processImageToBlob(file, { maxWidth: maxW, quality: 0.9 });');
    expect(appearanceSource).toContain('const ref = await putImageBlob(blob);');
    expect(appearanceSource).toContain('updateTheme({ launcherWidgets: { ...current, [activeWidgetSlot]: ref } });');
    expect(appearanceSource).not.toContain('const dataUrl = await processImage(file, { maxWidth: maxW, quality: 0.9 });');
  });

  it('压缩口径没变：各槽位的 maxWidth 原样保留，也没顺手加 skipCompression', () => {
    expect(appearanceSource).toContain(
      "const maxW = activeWidgetSlot === 'wide' ? 800 : activeWidgetSlot === 'dsq' ? 600 : 500;",
    );
    const upload = appearanceSource.slice(
      appearanceSource.indexOf('const handleWidgetUpload'),
      appearanceSource.indexOf('const removeWidget'),
    );
    expect(upload).not.toContain('skipCompression');
  });

  it('桌面（Launcher）的三个槽位都走 TokenImg，不是裸 <img>', () => {
    // 首页方图（DesktopSquareImage）
    expect(launcherSource).toContain('<TokenImg value={image} alt="" className="w-full h-full object-cover" loading="lazy" />');
    expect(launcherSource).not.toContain('<img src={image} alt="" className="w-full h-full object-cover" loading="lazy" />');
    // 第三页的 tl / tr 与 wide
    expect(launcherSource).toContain('<TokenImg value={w[key]}');
    expect(launcherSource).toContain("<TokenImg value={w['wide']}");
    expect(launcherSource).not.toContain('<img src={w[key]}');
    expect(launcherSource).not.toContain("<img src={w['wide']}");
  });

  it('外观设置页的槽位缩略图与 DIY 预览都走 TokenImg', () => {
    // dsq / tl / tr / wide 四个槽位共用同一段缩略图 JSX
    expect(appearanceSource).toContain('<TokenImg value={img} className="w-full h-full object-cover" />');
    expect(appearanceSource).not.toContain('<img src={img} className="w-full h-full object-cover" />');
    // 桌面装饰 DIY 的实时预览
    expect(appearanceSource).toContain('<TokenImg value={w[k]} className="w-full h-full object-cover" />');
    expect(appearanceSource).toContain('<TokenImg value={w[\'wide\']} className="w-full h-full object-cover" />');
    expect(appearanceSource).not.toContain('<img src={w[k]}');
  });

  it('assets 表的 widget_<slot> 一律原样落库，不按 data: 前缀挑', () => {
    expect(osContextSource).toContain('DB.saveAsset(`widget_${slot}`, val)');
    // 旧写法：令牌不带 data: 前缀，会被这道判断整个跳过，assets 里一行都不落
    expect(osContextSource).not.toContain("if (val && val.startsWith('data:'))");
    const block = osContextSource.slice(
      osContextSource.indexOf('// Save widget images to IndexedDB'),
      osContextSource.indexOf("await DB.deleteAsset('widget_bl');"),
    );
    expect(block).toContain('if (val) {');
    expect(block).not.toContain("startsWith('data:')");
  });

  it('应用外观预设时把小组件图写进 assets（不写的话下次启动会被上一套主题盖回去）', () => {
    expect(osContextSource).toContain('await DB.saveAsset(`widget_${slot}`, stored);');
  });

  it('localStorage 镜像不剥令牌（os_theme 是孤儿清理的引用面之一）', () => {
    // 剥 data: 是防 base64 撑爆 quota 的运行时兜底，令牌必须原样留在 os_theme 里，
    // 否则这一面就没人引用了。
    expect(osContextSource).toContain("cleanWidgets[k] = (v && v.startsWith('data:')) ? '' : v;");
  });
});
