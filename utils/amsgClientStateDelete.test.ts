// utils/amsgClientStateDelete.test.ts
//
// 云端 client_state 删行那份不联网的判断：特性位、旁路空壳的挑法、切批。
import { describe, expect, it } from 'vitest';

import {
  AMSG_SIDECHANNEL_KEY_PREFIXES,
  CLIENT_STATE_PUT_BATCH_MAX,
  chunkClientStateEntries,
  isSidechannelKey,
  pickSidechannelShellKeys,
  supportsClientStateDelete,
} from './amsgClientStateDelete';

describe('supportsClientStateDelete', () => {
  it('features 里有 client-state-delete 才算', () => {
    expect(supportsClientStateDelete(['client-state', 'client-state-delete'])).toBe(true);
    expect(supportsClientStateDelete(['client-state', 'llm-credentials'])).toBe(false);
  });

  it('探不到（null / undefined / 不是数组）一律 false', () => {
    expect(supportsClientStateDelete(null)).toBe(false);
    expect(supportsClientStateDelete(undefined)).toBe(false);
    expect(supportsClientStateDelete('client-state-delete' as any)).toBe(false);
  });
});

describe('pickSidechannelShellKeys', () => {
  it('三个旁路前缀 + 值为空串 → 是空壳', () => {
    const entries = AMSG_SIDECHANNEL_KEY_PREFIXES.map((prefix) => ({ key: `${prefix}uuid`, value: '' }));
    expect(pickSidechannelShellKeys(entries)).toEqual(['reasoning:uuid', 'emotion_update:uuid', 'xhs_session:uuid']);
  });

  it('旁路键还有内容 → 不是空壳（客户端还没取走）', () => {
    expect(pickSidechannelShellKeys([
      { key: 'reasoning:a', value: 'gz1:...' },
      { key: 'xhs_session:b', value: '{"notes":[]}' },
    ])).toEqual([]);
  });

  it('长期状态就算是空的也不碰', () => {
    expect(pickSidechannelShellKeys([
      { key: 'fire_pack', value: '' },
      { key: 'tool_pack', value: '' },
      { key: 'self_log', value: '' },
      { key: 'chat_presence', value: '' },
      { key: 'last_skip', value: '' },
    ])).toEqual([]);
  });

  it('前缀只认开头，不认包含', () => {
    expect(isSidechannelKey('my_reasoning:a')).toBe(false);
    expect(pickSidechannelShellKeys([{ key: 'my_reasoning:a', value: '' }])).toEqual([]);
  });

  it('条目缺 key / 值不是字符串 / 没有条目 → 都不算', () => {
    expect(pickSidechannelShellKeys([{ value: '' }, { key: 'reasoning:a', value: null }, { key: 'reasoning:b' }])).toEqual([]);
    expect(pickSidechannelShellKeys(null)).toEqual([]);
    expect(pickSidechannelShellKeys(undefined)).toEqual([]);
  });
});

describe('chunkClientStateEntries', () => {
  it('按上游单批上限切，最后一批装余数', () => {
    const items = Array.from({ length: CLIENT_STATE_PUT_BATCH_MAX * 2 + 1 }, (_, i) => i);
    const batches = chunkClientStateEntries(items);
    expect(batches.map((b) => b.length)).toEqual([CLIENT_STATE_PUT_BATCH_MAX, CLIENT_STATE_PUT_BATCH_MAX, 1]);
    expect(batches.flat()).toEqual(items);
  });

  it('不超上限 → 就一批；空数组 → 零批', () => {
    expect(chunkClientStateEntries([1, 2, 3])).toEqual([[1, 2, 3]]);
    expect(chunkClientStateEntries([])).toEqual([]);
  });
});
