import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 角色的聊天背景（characters.chatBackground）存的是 `blobref:` 令牌（见 utils/blobRef.ts），
// 二进制在 IndexedDB 里。令牌直接塞进裸 <img src> / CSS url() 就是一张裂图，所以：
//   · 设置弹窗里的缩略图走 TokenImg；
//   · 聊天页根容器的背景先用 useBlobRefUrl 解析成可用地址再拼进 url()；
//   · 上传时用 processImageToBlob + putImageBlob 产出令牌，别再写回 base64
//     （写端漏改的话，用户新设的背景又变成几 MB 的 data URL 塞在角色行里）。
const chatSource = readFileSync(path.resolve(__dirname, '../apps/Chat.tsx'), 'utf8');
const modalsSource = readFileSync(path.resolve(__dirname, '../components/chat/ChatModals.tsx'), 'utf8');

describe('聊天背景的 blobref 读写路径', () => {
  it('上传后存的是令牌，不是 base64', () => {
    expect(chatSource).toContain('const blob = await processImageToBlob(file, { skipCompression: true });');
    expect(chatSource).toContain('updateCharacter(char.id, { chatBackground: ref });');
    expect(chatSource).not.toContain('updateCharacter(char.id, { chatBackground: dataUrl });');
  });

  it('聊天页背景先用 useBlobRefUrl 解析再拼进 CSS url()', () => {
    expect(chatSource).toContain('const resolvedChatBackground = useBlobRefUrl(char?.chatBackground);');
    expect(chatSource).toContain('url("${resolvedChatBackground}")');
    expect(chatSource).not.toContain('url(${char.chatBackground})');
  });

  it('解析 hook 在「角色为空」的早退之前调用（hook 顺序不能随空态变化）', () => {
    const hookAt = chatSource.indexOf('useBlobRefUrl(char?.chatBackground)');
    const guardAt = chatSource.indexOf('if (!char) {');
    expect(hookAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(-1);
    expect(hookAt).toBeLessThan(guardAt);
  });

  it('设置弹窗里的背景缩略图走 TokenImg，不是裸 <img>', () => {
    expect(modalsSource).toContain('<TokenImg value={activeCharacter.chatBackground}');
    expect(modalsSource).not.toContain('<img src={activeCharacter.chatBackground}');
  });
});
