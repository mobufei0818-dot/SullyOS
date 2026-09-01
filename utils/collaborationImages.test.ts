import { describe, expect, it } from 'vitest';
import { attachCollaborationImageInputs } from '../features/collaboration/engine';
import type { CollaborationMessage } from '../features/collaboration/types';

describe('collaboration image inputs', () => {
  it('attaches an uploaded reference image to the latest user task', async () => {
    const sessionMessages: CollaborationMessage[] = [{
      id: 'upload',
      sessionId: 'session-a',
      role: 'user',
      content: '照这张参考图美化白框',
      createdAt: 1,
      attachments: [{
        id: 'att', assetId: 'asset-image', kind: 'source', name: '参考.png', mimeType: 'image/png', size: 3, createdAt: 1,
      }],
    }];
    const result = await attachCollaborationImageInputs(
      [{ role: 'system', content: '规则' }, { role: 'user', content: '照这张参考图美化白框' }],
      sessionMessages,
      async () => new Blob(['img'], { type: 'image/png' }),
      async () => 'data:image/png;base64,aW1n',
    );
    expect(Array.isArray(result[1].content)).toBe(true);
    expect(result[1].content).toEqual([
      { type: 'text', text: '照这张参考图美化白框' },
      { type: 'text', text: expect.stringContaining('参考.png') },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1n' } },
    ]);
  });

  it('uses a cached vision description without resending the bitmap', async () => {
    const messages: CollaborationMessage[] = [{
      id: 'upload', sessionId: 'session-a', role: 'user', content: '分析配色', createdAt: 1,
      attachments: [{ id: 'att', assetId: 'asset-image', kind: 'source', name: '参考.png', mimeType: 'image/png', size: 3, createdAt: 1, extractedText: '[参考图片视觉描述]\n蓝白气泡' }],
    }];
    const result = await attachCollaborationImageInputs(
      [{ role: 'system', content: '规则' }, { role: 'user', content: '分析配色\n\n[参考图片视觉描述]\n蓝白气泡' }],
      messages,
      async () => { throw new Error('不应读取图片'); },
      async () => { throw new Error('不应转码图片'); },
    );
    expect(result[1].content).toBe('分析配色\n\n[参考图片视觉描述]\n蓝白气泡');
  });
});
