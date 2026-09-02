// utils/activeMsgClient.clientStateDelete.test.ts
//
// 回归守卫（云端 client_state 的删行）：
//   1. worker 认 `value: null` 之后，取回旁路内容后的「清掉」要真删而不是写空串——
//      即时对话每轮的旁路键都是新的，写空串留下的空壳只涨不跌，worker 每次生成都要把
//      整个角色命名空间读一遍。老 worker 收到 null 是逐条拒，所以不认就还得走写空串。
//   2. 删角色同一套：认删行时连已有的空壳一起删干净；不认时空壳跳过（原行为）。
//   3. 存量空壳清理：只在认删行时做、每个角色只读一次、只删三个旁路前缀且值为空的行、
//      超过单批上限切批、哪一步失败都不记进已扫列表。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reiClient } = vi.hoisted(() => ({
  reiClient: {
    init: vi.fn(),
    putClientState: vi.fn(),
    getClientState: vi.fn(),
    getCapabilities: vi.fn(),
    putLlmCredentials: vi.fn(),
    deleteLlmCredentials: vi.fn(),
    _encrypt: vi.fn(),
  },
}));
vi.mock('@rei-standard/amsg-client', () => ({ ReiClient: vi.fn(() => reiClient) }));
vi.mock('./keepAlive', () => ({
  KeepAlive: { init: vi.fn().mockResolvedValue(undefined), reregister: vi.fn().mockResolvedValue(undefined) },
}));

const TEST_USER_ID = '3f2b1c8a-9d4e-4a1b-8c2d-000000000044';
const globalConfig: Record<string, unknown> = {
  userId: TEST_USER_ID,
  workerUrl: 'https://amsg.example.workers.dev',
  serverToken: '',
  llmCredentialsSupported: true,
};
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    ensureUserId: async () => TEST_USER_ID,
    getGlobalConfig: async () => ({ ...globalConfig }),
    saveGlobalConfig: vi.fn().mockResolvedValue(undefined),
  },
}));

import { ActiveMsgClient, clearNamespaceValuesOrThrow } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { amsgStateNamespace } from './amsgFirePack';
import { forgetAllCredIds } from './amsgLlmCredentials';
import { resetStateClock } from './amsgStateClock';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';

const CHAR_ID = 'char-state-delete';
const CHAR = {
  id: CHAR_ID,
  name: '小满',
  memories: [],
  activeMsg2Config: { enabled: true, tasks: [] },
} as any;
const NAMESPACE = amsgStateNamespace(CHAR_ID);

const OTHER_CHAR_ID = 'char-state-delete-2';
const OTHER_CHAR = { ...CHAR, id: OTHER_CHAR_ID, name: '小雨' };
const OTHER_NAMESPACE = amsgStateNamespace(OTHER_CHAR_ID);

/** 云端读回来的一份典型命名空间：三种旁路空壳 + 还有内容的旁路行 + 各种长期状态。 */
const MIXED_ENTRIES = [
  { namespace: NAMESPACE, key: 'reasoning:a', value: '', updatedAt: 1 },
  { namespace: NAMESPACE, key: 'emotion_update:b', value: '', updatedAt: 1 },
  { namespace: NAMESPACE, key: 'xhs_session:c', value: '', updatedAt: 1 },
  { namespace: NAMESPACE, key: 'xhs_session:d', value: '{"notes":[]}', updatedAt: 1 },
  { namespace: NAMESPACE, key: 'reasoning:e', value: 'gz1:...', updatedAt: 1 },
  { namespace: NAMESPACE, key: 'fire_pack', value: '', updatedAt: 1 },
  { namespace: NAMESPACE, key: 'self_log', value: '', updatedAt: 1 },
  { namespace: NAMESPACE, key: 'chat_presence', value: '', updatedAt: 1 },
  { namespace: NAMESPACE, key: 'tool_pack', value: '{}', updatedAt: 1 },
];
const SHELL_KEYS = ['reasoning:a', 'emotion_update:b', 'xhs_session:c'];

const shellEntries = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ namespace: NAMESPACE, key: `reasoning:${i}`, value: '', updatedAt: 1 }));

const remoteHas = (entries: unknown[]) => {
  reiClient.getClientState.mockResolvedValue({ success: true, data: { entries } });
};

/** saveGlobalConfig 里带已扫列表的那几次调用（握手时的能力探测也会存一次配置，得筛掉）。 */
const sweptListSaves = (): string[][] =>
  vi.mocked(ActiveMsgStore.saveGlobalConfig).mock.calls
    .map(([updates]) => (updates as { sidechannelShellsSweptCharIds?: string[] }).sidechannelShellsSweptCharIds)
    .filter((list): list is string[] => list !== undefined);

/** 第 n 次（从 0 数）putClientState 发出去的条目。 */
const putEntries = (n: number): any[] => reiClient.putClientState.mock.calls[n][0];

const sync = (chars = [CHAR]) => ActiveMsgClient.syncCharFirePacks(chars.map((char) => ({
  char,
  config: { enabled: true, tasks: [] } as any,
  userProfile: { name: '小明' } as any,
  groups: [],
  realtimeConfig: {} as any,
})));

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetStateClock();
  forgetAllCredIds();
  delete globalConfig.clientStateDeleteSupported;
  delete globalConfig.sidechannelShellsSweptCharIds;
  vi.mocked(ActiveMsgStore.saveGlobalConfig).mockClear();
  reiClient.init.mockReset().mockResolvedValue(undefined);
  reiClient.putClientState.mockReset().mockResolvedValue({ success: true });
  reiClient.getClientState.mockReset().mockResolvedValue({ success: true, data: { entries: [] } });
  reiClient.putLlmCredentials.mockReset().mockResolvedValue({ success: true, data: { upserted: 1 } });
  reiClient.deleteLlmCredentials.mockReset().mockResolvedValue({ success: true, data: { deleted: 0 } });
  reiClient.getCapabilities.mockReset().mockResolvedValue({ serverVersion: '2.6.0-next.27', features: [] });
  reiClient._encrypt.mockReset().mockResolvedValue({ iv: 'iv', authTag: 'tag', encryptedData: 'enc' });
  vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
  vi.spyOn(DB, 'getEmojis').mockResolvedValue([] as any);
  vi.spyOn(DB, 'getEmojiCategories').mockResolvedValue([] as any);
  vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockResolvedValue('SYS');
  vi.spyOn(ChatPrompts, 'buildMessageHistory').mockReturnValue({ apiMessages: [] } as any);
  vi.spyOn(ChatPrompts, 'filterVisibleEmojis').mockReturnValue({ emojis: [], categories: [] } as any);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // 握手时顺手跑的即时对话探测会打 config-check，别让它真的出网。
  vi.stubGlobal('fetch', vi.fn(async () => ({
    status: 200,
    text: async () => JSON.stringify({ success: true, data: {} }),
    headers: new Headers({ 'content-type': 'application/json' }),
  })));
});

afterEach(() => {
  resetStateClock();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('clearClientStateValue（取回旁路内容后的清理）', () => {
  it('worker 认删行 → 发 value: null 真删', async () => {
    globalConfig.clientStateDeleteSupported = true;

    await ActiveMsgClient.clearClientStateValue(NAMESPACE, 'reasoning:abc');

    expect(putEntries(0)).toEqual([
      { namespace: NAMESPACE, key: 'reasoning:abc', value: null, updatedAt: expect.any(Number) },
    ]);
  });

  it('老 worker → 照旧写空串', async () => {
    globalConfig.clientStateDeleteSupported = false;

    await ActiveMsgClient.clearClientStateValue(NAMESPACE, 'reasoning:abc');

    expect(putEntries(0)[0].value).toBe('');
  });

  it('还没探过 → 按老 worker 处理（null 发到老 worker 上是被拒）', async () => {
    await ActiveMsgClient.clearClientStateValue(NAMESPACE, 'reasoning:abc');

    expect(putEntries(0)[0].value).toBe('');
  });
});

describe('clearNamespaceValuesOrThrow（删角色）', () => {
  const fakeClient = (entries: unknown[]) => ({
    getClientState: vi.fn().mockResolvedValue({ success: true, data: { entries } }),
    putClientState: vi.fn().mockResolvedValue({ success: true }),
  });
  const ROWS = [
    { key: 'fire_pack', value: '{"v":2}' },
    { key: 'tool_pack', value: '{}' },
    { key: 'reasoning:x', value: '' },
    { key: 'xhs_session:y', value: '' },
  ];

  it('worker 认删行 → 每一行都发 null，已经是空壳的也在内', async () => {
    globalConfig.clientStateDeleteSupported = true;
    const client = fakeClient(ROWS);

    const cleared = await clearNamespaceValuesOrThrow(client as any, NAMESPACE);

    expect(cleared).toEqual(['fire_pack', 'tool_pack', 'reasoning:x', 'xhs_session:y']);
    expect(client.putClientState).toHaveBeenCalledTimes(1);
    expect(client.putClientState.mock.calls[0][0].map((e: any) => [e.key, e.value])).toEqual([
      ['fire_pack', null], ['tool_pack', null], ['reasoning:x', null], ['xhs_session:y', null],
    ]);
  });

  it('老 worker → 只对有内容的行写空串，空壳跳过', async () => {
    globalConfig.clientStateDeleteSupported = false;
    const client = fakeClient(ROWS);

    const cleared = await clearNamespaceValuesOrThrow(client as any, NAMESPACE);

    expect(cleared).toEqual(['fire_pack', 'tool_pack']);
    expect(client.putClientState.mock.calls[0][0].map((e: any) => [e.key, e.value])).toEqual([
      ['fire_pack', ''], ['tool_pack', ''],
    ]);
  });

  it('行数超过单批上限 → 切批发', async () => {
    globalConfig.clientStateDeleteSupported = true;
    const client = fakeClient(shellEntries(450));

    const cleared = await clearNamespaceValuesOrThrow(client as any, NAMESPACE);

    expect(cleared).toHaveLength(450);
    expect(client.putClientState.mock.calls.map(([entries]: any[]) => entries.length)).toEqual([200, 200, 50]);
  });
});

describe('存量空壳清理（挂在 syncCharFirePacks 末尾）', () => {
  it('认删行且没扫过 → 读一次命名空间，只删三个旁路前缀且为空的行，扫完记进列表', async () => {
    globalConfig.clientStateDeleteSupported = true;
    remoteHas(MIXED_ENTRIES);

    await sync();

    expect(reiClient.getClientState).toHaveBeenCalledTimes(1);
    expect(reiClient.getClientState).toHaveBeenCalledWith(NAMESPACE);
    // 第 0 次是常规同步（fire_pack / tool_pack），第 1 次才是清空壳。
    expect(reiClient.putClientState).toHaveBeenCalledTimes(2);
    const deletes = putEntries(1);
    expect(deletes.map((e: any) => e.key)).toEqual(SHELL_KEYS);
    expect(deletes.every((e: any) => e.value === null && e.namespace === NAMESPACE)).toBe(true);
    expect(sweptListSaves()).toEqual([[CHAR_ID]]);
  });

  it('没有空壳 → 不多发一次 PUT，但照样记进列表（下次不用再读）', async () => {
    globalConfig.clientStateDeleteSupported = true;
    remoteHas([{ namespace: NAMESPACE, key: 'fire_pack', value: 'gz1:...', updatedAt: 1 }]);

    await sync();

    expect(reiClient.getClientState).toHaveBeenCalledTimes(1);
    expect(reiClient.putClientState).toHaveBeenCalledTimes(1);
    expect(sweptListSaves()).toEqual([[CHAR_ID]]);
  });

  it('已在列表里 → 不再读云端', async () => {
    globalConfig.clientStateDeleteSupported = true;
    globalConfig.sidechannelShellsSweptCharIds = [CHAR_ID];
    remoteHas(MIXED_ENTRIES);

    await sync();

    expect(reiClient.getClientState).not.toHaveBeenCalled();
    expect(reiClient.putClientState).toHaveBeenCalledTimes(1);
    expect(sweptListSaves()).toEqual([]);
  });

  it('worker 不认删行 → 不读也不删', async () => {
    globalConfig.clientStateDeleteSupported = false;
    remoteHas(MIXED_ENTRIES);

    await sync();

    expect(reiClient.getClientState).not.toHaveBeenCalled();
    expect(reiClient.putClientState).toHaveBeenCalledTimes(1);
    expect(sweptListSaves()).toEqual([]);
  });

  it('空壳超过单批上限 → 切批发', async () => {
    globalConfig.clientStateDeleteSupported = true;
    remoteHas(shellEntries(450));

    await sync();

    const batches = reiClient.putClientState.mock.calls.slice(1).map(([entries]) => entries as any[]);
    expect(batches.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(batches.flat().every((e) => e.value === null)).toBe(true);
    expect(sweptListSaves()).toEqual([[CHAR_ID]]);
  });

  it('读云端失败 → warn、这一轮不记列表，同步本身照样算成功', async () => {
    globalConfig.clientStateDeleteSupported = true;
    reiClient.getClientState.mockRejectedValue(new Error('网络断了'));

    await expect(sync()).resolves.toBeUndefined();

    expect(reiClient.putClientState).toHaveBeenCalledTimes(1);
    expect(sweptListSaves()).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('旁路存储空壳'), expect.any(Error));
  });

  it('删空壳被 worker 拒了 → 不记列表，下次再试', async () => {
    globalConfig.clientStateDeleteSupported = true;
    remoteHas(MIXED_ENTRIES);
    reiClient.putClientState
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValue({ success: true, data: { rejected: [{ key: 'reasoning:a', message: 'INVALID_STATE_VALUE' }] } });

    await expect(sync()).resolves.toBeUndefined();

    expect(sweptListSaves()).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('旁路存储空壳'), expect.any(Error));
  });

  it('一批里几个角色 → 各读各的，扫成的才记、扫挂的留到下次', async () => {
    globalConfig.clientStateDeleteSupported = true;
    reiClient.getClientState.mockImplementation(async (namespace: string) => {
      if (namespace === OTHER_NAMESPACE) throw new Error('D1 busy');
      return { success: true, data: { entries: MIXED_ENTRIES } };
    });

    await sync([CHAR, OTHER_CHAR]);

    expect(reiClient.getClientState).toHaveBeenCalledTimes(2);
    expect(sweptListSaves()).toEqual([[CHAR_ID]]);
  });

  it('列表里已有别的角色 → 追加而不是覆盖', async () => {
    globalConfig.clientStateDeleteSupported = true;
    globalConfig.sidechannelShellsSweptCharIds = [OTHER_CHAR_ID];
    remoteHas(MIXED_ENTRIES);

    await sync();

    expect(sweptListSaves()).toEqual([[OTHER_CHAR_ID, CHAR_ID]]);
  });
});

describe('probeWorkerFeatures（握手时一次探测存两个能力位）', () => {
  const savedFlags = () =>
    vi.mocked(ActiveMsgStore.saveGlobalConfig).mock.calls
      .map(([updates]) => updates as Record<string, unknown>)
      .filter((updates) => 'clientStateDeleteSupported' in updates);

  it('features 两个都有 → 两个都是 true', async () => {
    reiClient.getCapabilities.mockResolvedValue({
      serverVersion: '2.6.0-next.27', features: ['llm-credentials', 'client-state-delete'],
    });

    await expect(ActiveMsgClient.probeWorkerFeatures())
      .resolves.toEqual({ llmCredentialsSupported: true, clientStateDeleteSupported: true });
    expect(savedFlags().at(-1)).toEqual({ llmCredentialsSupported: true, clientStateDeleteSupported: true });
  });

  it('只认凭据那一位 → 删行是 false（老一档的 worker）', async () => {
    reiClient.getCapabilities.mockResolvedValue({ serverVersion: '2.6.0-next.26', features: ['llm-credentials'] });

    await expect(ActiveMsgClient.probeWorkerFeatures())
      .resolves.toEqual({ llmCredentialsSupported: true, clientStateDeleteSupported: false });
  });

  it('探不到 → 两个都是 false', async () => {
    reiClient.getCapabilities.mockRejectedValue(new Error('offline'));

    await expect(ActiveMsgClient.probeWorkerFeatures())
      .resolves.toEqual({ llmCredentialsSupported: false, clientStateDeleteSupported: false });
    expect(savedFlags().at(-1)).toEqual({ llmCredentialsSupported: false, clientStateDeleteSupported: false });
  });
});
