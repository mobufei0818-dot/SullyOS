import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveInboxMessage: vi.fn().mockResolvedValue(undefined),
  flushInboxToChat: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: { saveInboxMessage: mocks.saveInboxMessage },
}));
vi.mock('./activeMsgRuntime', () => ({
  flushInboxToChat: mocks.flushInboxToChat,
}));

import { ingestNativeAmsgPayload, parseNativeAmsgPayload } from './nativeAmsgInbox';

describe('UnifiedPush payload 入库桥', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.saveInboxMessage.mockClear();
    mocks.flushInboxToChat.mockClear();
  });

  it('接受对象或 JSON 字符串，拒绝无效内容', () => {
    expect(parseNativeAmsgPayload({ message: 'hi' })).toEqual({ message: 'hi' });
    expect(parseNativeAmsgPayload('{"message":"hi"}')).toEqual({ message: 'hi' });
    expect(parseNativeAmsgPayload('not-json')).toBeNull();
  });

  it('把标准 AMSG payload 交给现有 inbox 管线并按 messageId 去重', async () => {
    const payload = {
      messageId: 'msg-up-1',
      message: '该醒啦',
      contactName: '小明',
      timestamp: '2026-08-09T08:00:00.000Z',
      metadata: { charId: 'char-1', charName: '小明' },
    };

    await ingestNativeAmsgPayload(payload);
    await ingestNativeAmsgPayload(payload);

    expect(mocks.saveInboxMessage).toHaveBeenCalledTimes(1);
    expect(mocks.saveInboxMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'msg-up-1',
      charId: 'char-1',
      body: '该醒啦',
      sentAt: Date.parse('2026-08-09T08:00:00.000Z'),
    }));
    expect(mocks.flushInboxToChat).toHaveBeenCalledTimes(1);
  });
});
