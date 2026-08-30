import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat image bottom anchoring wiring', () => {
  it('eagerly decodes the latest image and reports its final layout', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/chat/MessageItem.tsx'), 'utf8');

    expect(source).toContain("loading={isLatestMessage ? 'eager' : 'lazy'}");
    expect(source).toContain('onLoad={() => onMediaLoad?.(m.id)}');
    expect(source).toContain('prev.isLatestMessage === next.isLatestMessage');
  });

  it('re-anchors only while the user is still following the newest message', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/Chat.tsx'), 'utf8');

    expect(source).toContain('pendingMediaAutoScrollIdRef.current = currentLastId');
    expect(source).toContain('if (distanceFromBottom > 96) pendingMediaAutoScrollIdRef.current = null');
    expect(source).toContain('pendingMediaAutoScrollIdRef.current !== messageId');
    expect(source).toContain('onScroll={handleChatScroll}');
    expect(source).toContain('onMediaLoad={handleMessageMediaLoad}');
  });
});
