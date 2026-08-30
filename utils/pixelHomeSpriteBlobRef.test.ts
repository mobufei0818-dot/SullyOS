import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 像素小屋（apps/pixelHome）里走来走去的那两个小人，图从哪来是分层的：
//   1. 用户捏过像素形象 → 捏人器生成的 data URL；
//   2. 没捏过 → 退回 char.avatar 当立绘。
// 第 2 条是问题所在：char.avatar 存的是 `blobref:` 令牌（二进制在 IndexedDB，
// 见 utils/blobRef.ts），令牌塞进裸 <img src> 就是一张裂图。所以小人的渲染端
// 一律走 TokenImg（认令牌，非令牌原样透传）。
//
// 这份守卫扫源码：只要有人把 charSprite / playerSprite / sprite 直接接回
// 裸 <img src={...}> 或 CSS url()，这条就红。

const PIXEL_HOME_DIR = path.resolve(__dirname, '../apps/pixelHome');

/** 裸 <img src={charSprite}> / <img src={sprite}>：立绘值直接当地址用。 */
const BARE_SPRITE_IMG = /<img\b[^>]*\bsrc=\{\s*(?:charSprite|playerSprite|sprite)\b/;
/** CSS url() 里插立绘值。 */
const BARE_SPRITE_CSS = /url\(\$\{\s*(?:charSprite|playerSprite|sprite)\b/;

function collectTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectTsxFiles(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const files = collectTsxFiles(PIXEL_HOME_DIR);
const scan = (pattern: RegExp): string[] => files
  .filter(file => pattern.test(readFileSync(file, 'utf8')))
  .map(file => path.basename(file));

const read = (name: string) => readFileSync(path.join(PIXEL_HOME_DIR, name), 'utf8');

describe('像素小屋小人立绘的 blobref 渲染路径', () => {
  it('扫到了源码文件（别让路径写错导致这份守卫空跑）', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('没有任何小人立绘被塞进裸 <img src>', () => {
    expect(scan(BARE_SPRITE_IMG)).toEqual([]);
  });

  it('没有任何小人立绘被拼进 CSS url()', () => {
    expect(scan(BARE_SPRITE_CSS)).toEqual([]);
  });

  it('全景地图里的角色小人走 TokenImg', () => {
    expect(read('PixelHomeMap.tsx')).toContain('<TokenImg value={charSprite}');
  });

  it('房间编辑器里的角色小人走 TokenImg', () => {
    expect(read('PixelRoomEditor.tsx')).toContain('<TokenImg value={charSprite}');
  });

  it('记忆潜行房间里的角色 / 用户小人走 TokenImg', () => {
    // SpritePerson 一个组件同时渲染 charSprite 和 playerSprite，改一处覆盖两个小人。
    const source = read('MemoryDiveRoom.tsx');
    expect(source).toContain('<TokenImg value={sprite}');
    expect(source).toContain('sprite={playerSprite}');
    expect(source).toContain('sprite={charSprite}');
  });
});

describe('小人立绘的取值链路', () => {
  it('没捏过像素形象时确实会退回 char.avatar（这就是令牌进来的口子）', () => {
    // 这条链路一旦改掉，上面那几条守卫就失去了存在理由；留着它把因果钉在一起。
    const view = read('PixelHomeView.tsx');
    expect(view).toContain('charSprite={pixelCharSprite || charAvatar}');
    const roomApp = readFileSync(path.resolve(__dirname, '../apps/RoomApp.tsx'), 'utf8');
    expect(roomApp).toContain('charAvatar={char.avatar}');
  });
});
