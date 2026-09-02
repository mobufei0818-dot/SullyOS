import { beforeEach, describe, expect, it, vi } from 'vitest';

const { putLlmCredentials, listLlmCredentials } = vi.hoisted(() => ({
  putLlmCredentials: vi.fn(),
  listLlmCredentials: vi.fn(),
}));

vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    getGlobalConfig: vi.fn().mockResolvedValue({
      workerUrl: 'https://amsg.example.workers.dev',
      userId: 'user-1',
      serverToken: 'token-1',
    }),
  },
}));

vi.mock('./activeMsgClient', () => ({ ActiveMsgClient: { putLlmCredentials, listLlmCredentials } }));
vi.mock('./db', () => ({ DB: { getMomentsSettings: vi.fn().mockResolvedValue(null) } }));
vi.mock('./scheduleFeature', () => ({ isScheduleFeatureOn: vi.fn().mockReturnValue(false) }));

import { syncRelationshipBackend } from './relationshipBackend';

const character = {
  id: 'char-new',
  name: '新角色',
  memories: [],
  activeMsg2Config: { enabled: true, tasks: [] },
} as any;
const characterWithId = (id: string) => ({ ...character, id });
const apiConfig = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'test-model' } as any;
const pulse = {
  version: 1,
  affection: 50,
  jealousy: 0,
  baselineLonging: 64,
  nextThreshold: 30,
  dailySent: 0,
  updatedAt: Date.now(),
  innerVoice: '',
} as any;

describe('relationship backend credential initialization', () => {
  beforeEach(() => {
    putLlmCredentials.mockReset().mockResolvedValue(1);
    listLlmCredentials.mockReset().mockResolvedValue([{ credId: 'char:char-new/chat', updatedAt: Date.now() }]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: pulse }),
    }));
  });

  it('registers a new character chat credential before syncing relationship state', async () => {
    await syncRelationshipBackend(character, [], pulse, [character], apiConfig);

    expect(putLlmCredentials).toHaveBeenCalledWith([{
      credId: 'char:char-new/chat',
      value: {
        apiUrl: 'https://api.example.com/v1/chat/completions',
        apiKey: 'sk-test',
        primaryModel: 'test-model',
      },
    }], {});
    expect(putLlmCredentials.mock.invocationCallOrder[0])
      .toBeLessThan(listLlmCredentials.mock.invocationCallOrder[0]);
    expect(listLlmCredentials.mock.invocationCallOrder[0])
      .toBeLessThan((fetch as any).mock.invocationCallOrder[0]);
  });

  it('does not trust a stale local fingerprint when the Worker list is missing the row', async () => {
    const staleCharacter = characterWithId('char-stale-ledger');
    listLlmCredentials
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ credId: 'char:char-stale-ledger/chat', updatedAt: Date.now() }]);

    await syncRelationshipBackend(staleCharacter, [], pulse, [staleCharacter], apiConfig);

    expect(putLlmCredentials).toHaveBeenCalledTimes(2);
    expect(putLlmCredentials.mock.calls[1][1]).toEqual({ force: true });
    expect(listLlmCredentials).toHaveBeenCalledTimes(2);
  });

  it('force-repairs the credential once when Worker reports a missing credRef', async () => {
    const repairCharacter = characterWithId('char-repair');
    listLlmCredentials.mockResolvedValue([{ credId: 'char:char-repair/chat', updatedAt: Date.now() }]);
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          ...pulse,
          diagnostics: {
            lastScheduleError: 'credRefs 引用的凭据不存在：char:char-repair/chat',
            lastScheduleErrorAt: 1788324960000,
          },
        },
      }),
    });

    await syncRelationshipBackend(repairCharacter, [], pulse, [repairCharacter], apiConfig);

    expect(putLlmCredentials).toHaveBeenCalledTimes(2);
    expect(putLlmCredentials.mock.calls[1][1]).toEqual({ force: true });
    expect(listLlmCredentials).toHaveBeenCalledTimes(2);
  });
});
