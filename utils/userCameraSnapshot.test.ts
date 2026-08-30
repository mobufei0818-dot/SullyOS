import { describe, expect, it } from 'vitest';
import {
  attachSnapshotToLatestUserMessage,
  fitUserCameraSnapshot,
  isVisionInputUnsupportedError,
} from './userCameraSnapshot';

describe('user camera snapshot', () => {
  it('fits a frame without enlarging it', () => {
    expect(fitUserCameraSnapshot(1920, 1080, 640)).toEqual({ width: 640, height: 360 });
    expect(fitUserCameraSnapshot(320, 480, 640)).toEqual({ width: 320, height: 480 });
    expect(fitUserCameraSnapshot(0, 480, 640)).toBeNull();
  });

  it('attaches the image only to the latest user message', () => {
    const messages = [
      { role: 'user', content: '旧消息' },
      { role: 'assistant', content: '旧回复' },
      { role: 'user', content: '现在看我' },
    ];
    const result = attachSnapshotToLatestUserMessage(messages, 'data:image/jpeg;base64,AAAA');
    expect(result[0].content).toBe('旧消息');
    expect(result[2].content).toEqual([
      { type: 'text', text: '现在看我' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
    ]);
    expect(messages[2].content).toBe('现在看我');
  });

  it('only identifies explicit vision incompatibility errors', () => {
    expect(isVisionInputUnsupportedError(new Error('unknown variant `image_url`'))).toBe(true);
    expect(isVisionInputUnsupportedError(new Error('model does not support image input'))).toBe(true);
    expect(isVisionInputUnsupportedError(new Error('network timeout'))).toBe(false);
  });
});
