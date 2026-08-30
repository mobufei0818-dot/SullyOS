// 即时对话（instant chat）客户端这一半的回归守卫。
//
// 钉的都是「坏了也不报错、只表现成体验变差」的那类行为：
//   1. POST 的形状——任务行型 / 任务身份 / fire_pack 带不带 chat 段。错一个字，
//      worker 到点要么拿主动消息模板去答聊天，要么整条硬失败，而用户只看到「一直在输入」。
//   2. 只有 202 才算发出去。别的状态一律「没发出去」，绝不静默退回本地生成。
//   3. 待收记录扛得住重启——它就是「正在输入…」那盏灯的唯一依据。
//   4. 补收对账：已经上过屏的那条不能再放一遍。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_USER_ID = '3f2b1c8a-9d4e-4a1b-8c2d-000000000009';

// _encrypt 换成「原样返回明文」，测里才读得到两个信封里到底装了什么。
const { reiClient } = vi.hoisted(() => ({
  reiClient: {
    init: vi.fn().mockResolvedValue(undefined),
    _encrypt: vi.fn(async (plaintext: string) => ({
      iv: 'iv', authTag: 'tag', encryptedData: plaintext,
    })),
    putClientState: vi.fn(),
    getClientState: vi.fn(),
  },
}));
vi.mock('@rei-standard/amsg-client', () => ({ ReiClient: vi.fn(() => reiClient) }));
vi.mock('./keepAlive', () => ({
  KeepAlive: { init: vi.fn().mockResolvedValue(undefined), reregister: vi.fn().mockResolvedValue(undefined) },
}));

// 后台任务结果的分发口：真的那份会动态 import 记忆宫殿那一整套（IndexedDB），
// 这里只关心「补收有没有把它交出去、销账判断对不对」。
const { resultDispatch } = vi.hoisted(() => ({
  resultDispatch: { calls: [] as unknown[], contexts: [] as unknown[], settle: true },
}));
vi.mock('./amsgResults', () => ({
  dispatchAmsgResult: vi.fn(async (payload: unknown, context?: unknown) => {
    resultDispatch.calls.push(payload);
    resultDispatch.contexts.push(context);
    return resultDispatch.settle;
  }),
}));

const { storeState } = vi.hoisted(() => ({
  storeState: {
    config: {
      userId: '3f2b1c8a-9d4e-4a1b-8c2d-000000000009',
      workerUrl: 'https://amsg.example.workers.dev',
      serverToken: '',
      instantChatEnabled: true,
    } as Record<string, unknown>,
    /** 非空时 getGlobalConfig 直接 reject（模拟 IndexedDB 被别的标签页卡住那类异常）。 */
    configError: null as Error | null,
    inbox: [] as any[],
    saved: [] as any[],
    markedNotices: [] as Array<{ charId: string; ids: string[] }>,
  },
}));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    ensureUserId: async () => TEST_USER_ID,
    getGlobalConfig: async () => {
      if (storeState.configError) throw storeState.configError;
      return storeState.config;
    },
    saveGlobalConfig: vi.fn().mockResolvedValue(undefined),
    listInboxMessages: async () => storeState.inbox,
    saveInboxMessage: async (message: any) => { storeState.saved.push(message); },
    markExpiredNoticesNotified: async (charId: string, ids: string[]) => {
      storeState.markedNotices.push({ charId, ids });
    },
  },
}));

import { ActiveMsgClient } from './activeMsgClient';
import {
  AMSG_INSTANT_CHAT_PENDING_LS_KEY,
  AMSG_INSTANT_CHAT_STAGED_NOTICES_LS_KEY,
  AMSG_OUTBOX_ADOPTED_LS_KEY,
  OUTBOX_BACKFILL_MAX_AGE_MS,
  clearInstantChatPending,
  discardInstantChatExpiredNotices,
  drainOutbox,
  failInstantChatPending,
  getInstantChatPending,
  getStagedInstantChatExpiredNotices,
  isInstantChatReady,
  resetInstantChatReprobeCooldown,
  resolveInstantChatReadiness,
  sendInstantChatTurn,
  setInstantChatPending,
  settleInstantChatApiLog,
  settleInstantChatExpiredNotices,
  stageInstantChatExpiredNotices,
} from './amsgInstantChat';
import { FIRE_PACK_VERSION, unpackStateValue } from './amsgFirePack';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';

const CHAR = { id: 'char-instant-1', name: '小满', memories: [] } as any;
const USER = { name: '小明' } as any;
const API = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'gpt-test' };

const stubFirePackDeps = () => {
  vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
  vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockResolvedValue('SYS_PROMPT_MARKER');
  vi.spyOn(ChatPrompts, 'buildMessageHistory').mockReturnValue({ apiMessages: [] } as any);
  vi.spyOn(ChatPrompts, 'filterVisibleEmojis').mockReturnValue({ emojis: [], categories: [] } as any);
};

/** 装一个只认 /instant-chat 的假 fetch，返回它记下来的请求。 */
const mockInstantChatFetch = (status: number, body: unknown) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => 'application/json' },
    } as any;
  }));
  return calls;
};

beforeEach(() => {
  localStorage.removeItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY);
  localStorage.removeItem(AMSG_INSTANT_CHAT_STAGED_NOTICES_LS_KEY);
  localStorage.removeItem(AMSG_OUTBOX_ADOPTED_LS_KEY);
  storeState.inbox = [];
  storeState.saved = [];
  storeState.markedNotices = [];
  storeState.configError = null;
  storeState.config = {
    userId: TEST_USER_ID,
    workerUrl: 'https://amsg.example.workers.dev',
    serverToken: '',
    instantChatEnabled: true,
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /instant-chat 的形状', () => {
  /** 跑一轮，返回解析好的请求体（两个信封已经是明文）。 */
  const postOnce = async (chatMessages: Array<{ role: string; content: unknown }>, supersedesUuid?: string) => {
    stubFirePackDeps();
    const calls = mockInstantChatFetch(202, { status: 'accepted', uuid: 'uuid-1' });
    const result = await ActiveMsgClient.sendInstantChat({
      char: CHAR, chatMessages, api: API, maxTokens: 8000,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
      ...(supersedesUuid ? { supersedesUuid } : {}),
    });
    // 按地址挑，不按顺序挑：握手时会顺带打一次 /config-check 刷能力位
    // （见 activeMsgClient 的 initializeClient），认 calls[0] 会挑到那一条。
    const call = calls.find((c) => String(c.url).includes('/instant-chat'))!;
    const body = JSON.parse(String(call.init.body));
    return {
      result,
      call,
      state: JSON.parse(body.statePayload.encryptedData),
      task: JSON.parse(body.taskPayload.encryptedData),
      supersedes: body.supersedesUuid,
    };
  };

  it('外壳是明文 JSON：两个信封已经加密好，别再给外壳挂加密头', async () => {
    const { call } = await postOnce([{ role: 'user', content: '在吗' }]);
    expect(call.url).toContain('/instant-chat');
    const headers = new Headers(call.init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-User-Id')).toBe(TEST_USER_ID);
    // 挂了的话包装层会把整个外壳当成一整份密文，statePayload / taskPayload 就解不出来。
    expect(headers.get('X-Payload-Encrypted')).toBeNull();
    expect(headers.get('X-Encryption-Version')).toBeNull();
  });

  it('任务行型是 auto + none，身份标着 instant', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在吗' }]);
    // 'instant' 在上游是「当场跑完」的行型，走不到 fire hooks，chat 段就白传了。
    expect(task.messageType).toBe('auto');
    expect(task.recurrenceType).toBe('none');
    // 标着 instant-chat 而不是 chat：面板对账靠这个标签把「用户正等着的这一轮」
    // 跟定时任务的行分开，不然它会被当成排程补进任务清单。
    expect(task.messageSubtype).toBe('instant-chat');
    expect(task.metadata.amsgMode).toBe('instant');
    expect(task.metadata.amsgInstantChat).toBe(true);
    expect(task.metadata.charId).toBe(CHAR.id);
    expect(typeof task.metadata.amsgClientTaskId).toBe('string');
    // 防穿帮闸问的是「到点还该不该主动开口」——带上它会把用户正等着的回复吞掉。
    expect(task.metadata.amsgExpirePolicy).toBeUndefined();
  });

  it('immediate: true 且不带 firstSendTime（落库即到期，慢机吃提前量的 400 无从发生）', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在吗' }]);
    expect(task.immediate).toBe(true);
    expect(task.firstSendTime).toBeUndefined();
  });

  it('顶替 uuid 只在加密信封里（上游同一事务原子取消），外壳明文不带', async () => {
    const { task, supersedes } = await postOnce([{ role: 'user', content: '在吗' }], 'uuid-prev');
    expect(task.supersedesUuid).toBe('uuid-prev');
    expect(supersedes).toBeUndefined();
  });

  it('没有可顶替的上一条时不带这个键', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在吗' }]);
    expect(task.supersedesUuid).toBeUndefined();
  });

  // 情绪评估要跟这一轮一起上云（worker 跑完随最后一条推送把结果送回来）。它里头有
  // 用户副 API 的 apiKey，落点必须是加密的 taskPayload —— 掉进外壳明文或 statePayload
  // 都等于把凭据摊在网络上。
  it('情绪评估配置进的是加密的任务信封，明文外壳里一个字节都没有', async () => {
    stubFirePackDeps();
    const calls = mockInstantChatFetch(202, { status: 'accepted', uuid: 'uuid-1' });
    const emotionEval = {
      prompt: '你是一个角色情绪分析系统。__EMOTION_EVAL_SYSTEM_PROMPT__\n__EMOTION_EVAL_HISTORY__',
      api: { baseUrl: 'https://eval.example.com/v1', apiKey: 'sk-secondary-KEYLEAK', model: 'eval-mini' },
    };
    await ActiveMsgClient.sendInstantChat({
      char: CHAR, chatMessages: [{ role: 'user', content: '在吗' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
      emotionEval,
    });

    const rawBody = String(calls[0].init.body);
    const body = JSON.parse(rawBody);
    const task = JSON.parse(body.taskPayload.encryptedData);
    expect(task.metadata.amsgEmotionEval).toEqual(emotionEval);
    // 外壳（除去两个信封本身）不许出现副 API 的 key
    const shell = { ...body, statePayload: undefined, taskPayload: undefined };
    expect(JSON.stringify(shell)).not.toContain('sk-secondary-KEYLEAK');
    // 云端状态那份也不该有：它跟任务信封是两码事，评估配置只跟着这一轮的任务走
    expect(body.statePayload.encryptedData).not.toContain('sk-secondary-KEYLEAK');
  });

  it('没配情绪评估就不带这个键（不是塞个空对象上去）', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在吗' }]);
    expect(task.metadata.amsgEmotionEval).toBeUndefined();
  });

  it('凭据带的是调用方给的那份（本地生成会用的同一份）', async () => {
    const { task } = await postOnce([{ role: 'user', content: '在吗' }]);
    expect(task.apiUrl).toBe('https://api.example.com/v1/chat/completions');
    expect(task.apiKey).toBe('sk-test');
    expect(task.primaryModel).toBe('gpt-test');
    expect(task.maxTokens).toBe(8000);
    expect(task.messages).toHaveLength(1);
  });

  it('云端状态是 v7 的 fire_pack，chat.messages 就是本地那串 fullMessages', async () => {
    const fullMessages = [
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: '今天怎么样' },
    ];
    const { state } = await postOnce(fullMessages);
    const firePackEntry = state.entries.find((e: any) => e.key === 'fire_pack');
    expect(firePackEntry).toBeTruthy();
    const pack = JSON.parse(await unpackStateValue(firePackEntry.value));
    expect(pack.v).toBe(FIRE_PACK_VERSION);
    expect(pack.chat.messages).toEqual(fullMessages);
    expect(typeof pack.chat.builtAt).toBe('number');
    // 排程那条路传的那几样一个都不能少（worker 到点全都要读）。
    const keys = state.entries.map((e: any) => e.key);
    expect(keys).toContain('tool_pack');
    expect(keys).toContain('tool_config');
  });

  // ── 轻量包：模板只有定时任务那条路才渲染 ──
  // 角色 2.0 关着（云端 fire 不注入排程工具）且没有任务时，每次发送重建一整份系统
  // 提示词 + 近史转写纯属白付——主线程二次构建 + 上行几十 KB 都发生在拿到 202 之前。
  it('角色 2.0 关着且无任务 → 模板用占位标记，系统提示词一次都不构建', async () => {
    const { state } = await postOnce([{ role: 'user', content: '在吗' }]);
    const entry = state.entries.find((e: any) => e.key === 'fire_pack');
    const pack = JSON.parse(await unpackStateValue(entry.value));
    expect(pack.template).toContain('AMSG2_INSTANT_STUB_TEMPLATE');
    expect(pack.selfScheduleEnabled).toBe(false);
    // chat 段照常带全——即时 fire 吃的是它，不是模板
    expect(pack.chat.messages).toHaveLength(1);
    expect(ChatPrompts.buildSystemPrompt).not.toHaveBeenCalled();
  });

  it('角色 2.0 开着 → 照旧带真模板（云端 fire 可能当场排出会消费它的任务）', async () => {
    stubFirePackDeps();
    const calls = mockInstantChatFetch(202, { status: 'accepted', uuid: 'uuid-real-template' });
    const charOn = { ...CHAR, activeMsg2Config: { enabled: true, tasks: [] } } as any;
    await ActiveMsgClient.sendInstantChat({
      char: charOn, chatMessages: [{ role: 'user', content: '在吗' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
    });
    const body = JSON.parse(String(calls[0].init.body));
    const state = JSON.parse(body.statePayload.encryptedData);
    const entry = state.entries.find((e: any) => e.key === 'fire_pack');
    const pack = JSON.parse(await unpackStateValue(entry.value));
    expect(pack.template).toContain('SYS_PROMPT_MARKER');
    expect(pack.template).not.toContain('AMSG2_INSTANT_STUB_TEMPLATE');
    expect(pack.selfScheduleEnabled).toBe(true);
  });

  // ── 图片：云端这条路必须跟本地跑出来的一模一样 ──
  //
  // 拍平图片曾经是这里的做法，代价是模型看不到用户刚发的那张图，只能对着
  // 「[User sent an image]」硬答——而且答得挺像回事，用户根本看不出是这条路缺了东西。
  // 现在原样带上云，只在体积真的过不去时才从最老的开始丢，且当前这轮永不降级。

  /** 造一张「大图」：分段形状是真的，base64 内容用重复字符凑体积。 */
  const imageMessage = (role: string, kb: number, text = '[User sent an image]') => ({
    role,
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(kb * 1024)}` } },
    ],
  });

  const chatOf = async (state: any) => {
    const entry = state.entries.find((e: any) => e.key === 'fire_pack');
    return JSON.parse(await unpackStateValue(entry.value)).chat;
  };

  it('带图片那条原样上云（结构化分段一个字都不动）', async () => {
    const structured = [
      { role: 'user', content: [
        { type: 'text', text: '[User sent an image]' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ] },
    ];
    const { state } = await postOnce(structured);
    const chat = await chatOf(state);
    // 回归守卫：拍平的话这里会变成字符串 '[User sent an image]'，图片就此消失
    expect(chat.messages).toEqual(structured);
    expect(JSON.stringify(chat.messages)).toContain('base64');
  });

  it('体积超标 → 从最老的消息开始丢图片本体，文字段留下', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 三张 1 MB 的图，预算 2 MiB：最老的那张必然要丢
    const { state } = await postOnce([
      imageMessage('user', 1024, '第一张'),
      imageMessage('assistant', 1024, '第二张'),
      { role: 'user', content: '最后这句没有图' },
    ]);
    const chat = await chatOf(state);
    expect(chat.messages[0].content).toBe('第一张');          // 丢成文字段
    expect(typeof chat.messages[0].content).toBe('string');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('最新那条用户消息的图片永远不丢（这一轮要聊的就是它）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { state } = await postOnce([
      imageMessage('user', 1024, '很久以前那张'),
      imageMessage('assistant', 1024, '角色发的那张'),
      imageMessage('user', 512, '刚发出去的这张'),
    ]);
    const chat = await chatOf(state);
    const newest = chat.messages[2];
    // 回归守卫：从头往后丢的循环要是没跳过它，用户刚发的图就没了，而回复照样有
    expect(Array.isArray(newest.content)).toBe(true);
    expect(newest.content[1].image_url.url).toContain('base64');
    // 老的两条让位
    expect(typeof chat.messages[0].content).toBe('string');
    warn.mockRestore();
  });

  it('只剩最新那条还是超预算 → 抛错，不悄悄把当前这轮截断', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(postOnce([imageMessage('user', 4096, '一张巨图')]))
      .rejects.toThrow(/图片太大/);
    warn.mockRestore();
  });

  // ── 超预算的报错要说真话 ──
  // 拍平循环只压得动图片；纯文本本身就超限（长角色卡 + 世界书 + 近史）时它一条也压
  // 不掉。以前这条路也报「图片太大…删掉图片再发」——用户没有图可删，照着做永远修不好。
  it('纯文本就超预算 → 报「上下文太大」，一个字不提图片', async () => {
    const err = await postOnce([
      { role: 'system', content: 'A'.repeat(3 * 1024 * 1024) },
      { role: 'user', content: '在吗' },
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('上下文太大');
    // 回归守卫：旧文案叫用户删图，纯文本轮里没有图可删
    expect(err.message).not.toContain('图片');
  });

  it('小图 + 巨文本（删图也救不回来）→ 同样报上下文太大，不指错路让用户删图', async () => {
    const err = await postOnce([
      { role: 'system', content: 'A'.repeat(3 * 1024 * 1024) },
      imageMessage('user', 16, '顺手带的小图'),
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('上下文太大');
    expect(err.message).not.toContain('图片');
  });

});

describe('只有 202 才算发出去', () => {
  const send = async (status: number, body: unknown) => {
    stubFirePackDeps();
    mockInstantChatFetch(status, body);
    return sendInstantChatTurn({
      char: CHAR, chatMessages: [{ role: 'user', content: '在吗' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
    });
  };

  it('202 → 记一笔待收记录', async () => {
    const result = await send(202, { status: 'accepted', uuid: 'uuid-ok' });
    expect(result.ok).toBe(true);
    expect(getInstantChatPending(CHAR.id)?.uuid).toBe('uuid-ok');
  });

  it('200 但没有 uuid → 算没发出去（别把「可能发了」当成发了）', async () => {
    const result = await send(200, { success: true });
    expect(result.ok).toBe(false);
    expect(getInstantChatPending(CHAR.id)).toBeNull();
  });

  it('401 → 明确告诉用户密钥对不上，不留待收记录', async () => {
    const result = await send(401, { success: false, error: { code: 'INVALID_CLIENT_TOKEN' } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('共享密钥');
    expect(getInstantChatPending(CHAR.id)).toBeNull();
  });

  it('上游那一步挂了 → 原因带出来，仍然算没发出去', async () => {
    const result = await send(500, {
      success: false,
      error: {
        code: 'INSTANT_CHAT_STATE_FAILED', message: '云端状态没传上去，这条没发出去',
        step: 'client-state', upstream: { error: { message: 'D1 timeout' } },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('INSTANT_CHAT_STATE_FAILED');
    expect(result.error).toContain('D1 timeout');
    expect(getInstantChatPending(CHAR.id)).toBeNull();
  });

  // firstSendTime 是设备的钟加提前量算的，上游按自己的钟校验「必须在未来」——
  // 慢网大包上传或设备时钟偏慢都会把提前量吃光。这种失败要指条路（重试 / 查自动
  // 对时），不能掉进一句没人看得懂的 HTTP 400。
  it('上游打回「时间必须在未来」→ 文案指向网络慢 / 时钟偏慢', async () => {
    const result = await send(400, {
      success: false,
      error: {
        code: 'INSTANT_CHAT_TASK_FAILED', message: '任务没建起来，这条没发出去',
        step: 'schedule-message',
        upstream: {
          success: false,
          error: {
            code: 'INVALID_TIMESTAMP', message: '时间必须在未来',
            details: { field: 'firstSendTime', reason: 'must be in the future' },
          },
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('时钟');
    expect(getInstantChatPending(CHAR.id)).toBeNull();
  });
});

// 「API 调用记录」的记录点挂在全局 fetch 拦截器上，只认 /chat/completions——上云这一轮
// 本地只发一个 POST 给自己的 Worker，那条拦不到。不专门记的话，开了即时对话之后聊天
// 在记录里整个消失，看着像调用凭空没了。
describe('上云的这一轮也进「API 调用记录」', () => {
  /** 收走写库的那几笔（apiCallLog 走动态 import('./db')，按 DB 单例打桩拦得到）。 */
  const captureLog = () => {
    const logged: any[] = [];
    vi.spyOn(DB, 'appendApiCallLog').mockImplementation(async (entry: any) => { logged.push(entry); });
    return logged;
  };

  const sendOnce = async (status: number, body: unknown) => {
    stubFirePackDeps();
    mockInstantChatFetch(status, body);
    const logged = captureLog();
    await sendInstantChatTurn({
      char: CHAR, chatMessages: [{ role: 'user', content: '在吗' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
    });
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    return logged[0];
  };

  it('202 → 落一笔标着云端的「生成中」记录', async () => {
    const entry = await sendOnce(202, { status: 'accepted', uuid: 'uuid-log' });
    expect(entry).toMatchObject({
      id: 'cloud-uuid-log',
      route: 'cloud-instant-chat',
      pending: true,
      ok: true,
      baseUrl: API.baseUrl,
      model: API.model,
      appName: '消息',
      charId: CHAR.id,
      charName: CHAR.name,
      // 跟本地生成那条路同一个词，两条路在列表里对得起来。
      purpose: '聊天回复',
    });
    // 输入构成照算：这一轮到底交上去多大的东西，本地就这一份线索。
    expect(entry.promptBreakdown?.length).toBeGreaterThan(0);
  });

  it('连 202 都没拿到 → 记一笔当场就是终态的失败，不留「生成中」挂着', async () => {
    const entry = await sendOnce(500, { success: false, error: { code: 'X', message: '云端挂了' } });
    expect(entry).toMatchObject({ route: 'cloud-instant-chat', pending: false, ok: false });
    expect(entry.promptBreakdown?.length).toBeGreaterThan(0);
  });

  it('还没等到回复就又发一条 → 上一笔收成「已顶替」，不会一直转圈到被裁掉', async () => {
    stubFirePackDeps();
    mockInstantChatFetch(202, { status: 'accepted', uuid: 'uuid-second' });
    setInstantChatPending(CHAR.id, 'uuid-first', 1_000);
    const logged = captureLog();
    await sendInstantChatTurn({
      char: CHAR, chatMessages: [{ role: 'user', content: '还在吗' }], api: API,
      userProfile: USER, groups: [], realtimeConfig: {} as any,
    });
    await vi.waitFor(() => expect(logged).toHaveLength(2));
    // 顶掉的那一轮不算失败：云端把两句合成一次回，只是它不再单独等回复了。
    expect(logged.find((e) => e.id === 'cloud-uuid-first')).toMatchObject({
      pending: false, superseded: true, ok: true,
    });
    expect(logged.find((e) => e.id === 'cloud-uuid-second')?.pending).toBe(true);
  });

  it('回复回来 → 同一条记录补上用量，时间戳一个字不动（列表顺序不许跟着回复先后跳）', async () => {
    const logged = captureLog();
    settleInstantChatApiLog('uuid-log', { amsgUsage: { promptTokens: 1200, completionTokens: 80 } });
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0]).toMatchObject({
      id: 'cloud-uuid-log', pending: false, ok: true,
      promptTokens: 1200, completionTokens: 80,
      // 云端只报入和出，总数本地自己加——列表顶上的合计读的就是它。
      totalTokens: 1280,
    });
    expect(logged[0].timestamp).toBeUndefined();
    expect(logged[0].tokensPartial).toBeUndefined();
  });

  it('这一轮调过工具 → 用量标成只算末轮（云端只报得回最后一次调用的数）', async () => {
    const logged = captureLog();
    settleInstantChatApiLog('uuid-log', {
      amsgUsage: { promptTokens: 1200, completionTokens: 80 },
      amsgToolTrace: [{ name: 'web_search', count: 1 }],
    });
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0].tokensPartial).toBe(true);
  });

  it('云端没回用量 → 只销「生成中」，不往记录里填 0 冒充真数', async () => {
    const logged = captureLog();
    settleInstantChatApiLog('uuid-log', {});
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0].pending).toBe(false);
    expect(logged[0].promptTokens).toBeUndefined();
    expect(logged[0].totalTokens).toBeUndefined();
  });

  it('云端点名说这一轮没成 → 那笔跟着收尾成失败，不会一直写着「生成中」', async () => {
    setInstantChatPending(CHAR.id, 'uuid-dead', 1_000);
    vi.spyOn(DB, 'saveMessage').mockResolvedValue(undefined as any);
    const logged = captureLog();
    await failInstantChatPending(CHAR.id, 'uuid-dead', '云端生成失败');
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0]).toMatchObject({ id: 'cloud-uuid-dead', pending: false, ok: false });
  });
});

describe('待收记录（「正在输入…」那盏灯的唯一依据）', () => {
  it('落在 localStorage 里，重启后还在', () => {
    setInstantChatPending('char-a', 'uuid-a', 1_000);
    // 模块状态每次都从存储读，等价于重开一次应用。
    expect(getInstantChatPending('char-a')).toEqual({ charId: 'char-a', uuid: 'uuid-a', acceptedAt: 1_000, charName: '' });
    expect(localStorage.getItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY)).toContain('uuid-a');
  });

  it('同角色只留最新一条（顶替之后旧 uuid 没人认领了）', () => {
    setInstantChatPending('char-a', 'uuid-1', 1_000);
    setInstantChatPending('char-a', 'uuid-2', 2_000);
    expect(getInstantChatPending('char-a')?.uuid).toBe('uuid-2');
  });

  it('销账是幂等的', () => {
    setInstantChatPending('char-a', 'uuid-a', 1_000);
    expect(clearInstantChatPending('char-a')).toBe(true);
    expect(clearInstantChatPending('char-a')).toBe(false);
    expect(getInstantChatPending('char-a')).toBeNull();
  });

  it('存储里躺着坏数据时当没有，不能把整条路带崩', () => {
    localStorage.setItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY, '{ 这不是 JSON');
    expect(getInstantChatPending('char-a')).toBeNull();
  });
});

// 这一轮以「没等到回复」收尾时，「情绪更新中」那盏灯也得跟着灭。
//
// 情绪评估的结果是搭最后一条回复的推送回来的（metadata.amsgEmotionDone）。可这一轮
// 要是**一条推送都没有**——模型空输出/纯拒答被 worker 判成 skip-push，或者整条 fire
// 硬失败——那个信号永远不会到，灯只能等 660 秒的安全网熄，期间还会弹一句「worker 可能
// 是旧版」的误导提示。云端已经点名说这一轮没成，就是最确定的熄灯时机。
describe('零推送收尾时也要熄灭情绪徽章', () => {
  // node 环境没有 window，给个最小 stub（这一组只关心派了哪些事件）。
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
  });

  /** 记下这一段派了哪些事件（spy 而不是手工换函数：restore 交给 vitest，漏还原不了）。 */
  const captureEvents = () => {
    const seen: Array<{ type: string; detail: any }> = [];
    const spy = vi.spyOn(window, 'dispatchEvent').mockImplementation((event: any) => {
      seen.push({ type: event?.type, detail: event?.detail });
      return true;
    });
    return { seen, restore: () => spy.mockRestore() };
  };

  it('销账成功 → 发一次 instant-emotion-done（徽章的熄灭信号）', async () => {
    setInstantChatPending('char-emo', 'uuid-emo', 1_000);
    const { seen, restore } = captureEvents();
    try {
      await failInstantChatPending('char-emo', 'uuid-emo', '云端生成失败');
    } finally {
      restore();
    }
    const done = seen.filter((e) => e.type === 'instant-emotion-done');
    expect(done).toHaveLength(1);
    expect(done[0].detail).toEqual({ charId: 'char-emo' });
  });

  // 结论迟到、用户已经又发了一条时，销的是新那一轮的账才叫出事——灯也一样：
  // 新那一轮的评估还在云端跑着，这时候熄灯等于骗人。
  it('结论对不上当前这一轮 → 一个事件都不发（新那一轮的灯不许碰）', async () => {
    setInstantChatPending('char-emo', 'uuid-new', 2_000);
    const { seen, restore } = captureEvents();
    try {
      await failInstantChatPending('char-emo', 'uuid-old', '迟到的结论');
    } finally {
      restore();
    }
    expect(seen.some((e) => e.type === 'instant-emotion-done')).toBe(false);
    expect(getInstantChatPending('char-emo')?.uuid).toBe('uuid-new');
  });
});

describe('开关', () => {
  it('设置页开了 + 地址填着 → 走云端', async () => {
    expect(await isInstantChatReady()).toBe(true);
    expect(await resolveInstantChatReadiness()).toEqual({ ready: true });
  });

  it('开关没开 → 不走（每条消息都读这一份，别处不做第二道门）', async () => {
    storeState.config = { ...storeState.config, instantChatEnabled: false };
    expect(await isInstantChatReady()).toBe(false);
    expect(await resolveInstantChatReadiness()).toEqual({ ready: false, reason: 'disabled' });
  });

  it('地址空着 → 不走', async () => {
    storeState.config = { ...storeState.config, workerUrl: '  ' };
    expect(await isInstantChatReady()).toBe(false);
    expect(await resolveInstantChatReadiness()).toEqual({ ready: false, reason: 'no-worker-url' });
  });

  // ─── Worker 跑不动这条路（instantChatSupported）───
  //
  // 跑不动的 Worker 上即时对话是**发一条挂一条**：老 bundle 被 waitUntil 砍在 30 秒，
  // 新 bundle 少了起跳器直接 503。用户开着开关也得让位给本地生成，否则他对着
  // 「正在输入…」等一条永远不来的回复，而设置页写着「已开启」。

  // 存量是粘的（只有探测成功才翻得回来），所以让位之前一定要先现探一次——下面四条钉的
  // 就是这次现探的四种去向。

  /** 存量说跑不动 + 摆好「这次现探会问到什么」。 */
  const stageOutdatedWithProbe = (outcome: 'supported' | 'unsupported' | 'unknown') => {
    storeState.config = { ...storeState.config, instantChatEnabled: true, instantChatSupported: false };
    // 冷却是模块级状态，会串到别的用例上去。
    resetInstantChatReprobeCooldown();
    return vi.spyOn(ActiveMsgClient, 'probeInstantChatSupportDetailed').mockResolvedValue({
      outcome,
      supported: outcome === 'supported' ? true : outcome === 'unsupported' ? false : undefined,
    });
  };

  it('现探确认跑不动 → 用户开着也不走云端（reason worker-outdated）', async () => {
    stageOutdatedWithProbe('unsupported');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 静音，只数次数 */ });
    const readiness = await resolveInstantChatReadiness();
    expect(readiness).toEqual({ ready: false, reason: 'worker-outdated' });
    // 「用户没开」和「开了但用不了」是两回事：混成 disabled 的话，设置页那句提示、
    // 观察窗那条 trace 都没了着落。
    expect(readiness.reason).not.toBe('disabled');
    // 静默让位正是「静默分流」那个坑，必须留声。
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // ★ 这条是「一次抖动 ≠ 长期降级」的守卫。
  // 从前存量一旦是 false 就直接判死，而写下这个 false 的可能只是一次网络抖动——用户不
  // 碰巧打开设置页就一直卡在本地生成（线上真实故障：Worker 全绿，用户连着几小时全走本地，
  // 而他的本地直连根本不通）。现在发消息路上会现探一次，好了立刻回到云端。
  it('存量说跑不动、现探却发现已经好了 → 这一轮就回到云端（不必等用户去开设置页）', async () => {
    stageOutdatedWithProbe('supported');
    expect(await resolveInstantChatReadiness()).toEqual({ ready: true });
  });

  // 够不着云端时不能指人去「更新 Worker」：他多半点不动，而且问题也不在那儿。
  it('现探够不着云端 → 单独一档 worker-unreachable，不叫人去更新 Worker', async () => {
    stageOutdatedWithProbe('unknown');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 静音，只数次数 */ });
    const readiness = await resolveInstantChatReadiness();
    expect(readiness).toEqual({ ready: false, reason: 'worker-unreachable' });
    expect(readiness.reason).not.toBe('worker-outdated');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // 现探是加在发消息路上的，连发几条消息不能变成一串 /config-check。
  it('冷却期内不重复现探（连发三条只探一次）', async () => {
    const probe = stageOutdatedWithProbe('unsupported');
    vi.spyOn(console, 'warn').mockImplementation(() => { /* 静音 */ });
    await resolveInstantChatReadiness();
    await resolveInstantChatReadiness();
    await resolveInstantChatReadiness();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('没探过（undefined）→ 放行：不知道 ≠ 知道它不行', async () => {
    storeState.config = { ...storeState.config, instantChatEnabled: true, instantChatSupported: undefined };
    expect(await resolveInstantChatReadiness()).toEqual({ ready: true });
  });

  it('探到能跑 → 照常上云', async () => {
    storeState.config = { ...storeState.config, instantChatEnabled: true, instantChatSupported: true };
    expect(await resolveInstantChatReadiness()).toEqual({ ready: true });
  });

  // 用户自己没开的时候，「Worker 行不行」根本不该被问——那一档的原因是 disabled，
  // 报成 worker-outdated 会让设置页对着一个没开的开关喊「去更新 Worker」。
  it('用户自己没开时，先报 disabled，不越到 worker-outdated', async () => {
    storeState.config = { ...storeState.config, instantChatEnabled: false, instantChatSupported: false };
    expect(await resolveInstantChatReadiness()).toEqual({ ready: false, reason: 'disabled' });
  });

  // 能力位是「上一台 Worker」留下的存量。地址都空着还报「Worker 太旧」的话，
  // 设置页会把人指去点一个根本没连上的东西。
  it('地址空着时报 no-worker-url，不越到 worker-outdated', async () => {
    storeState.config = { ...storeState.config, workerUrl: '  ', instantChatSupported: false };
    expect(await resolveInstantChatReadiness()).toEqual({ ready: false, reason: 'no-worker-url' });
  });

  // 读配置失败被当成「没开」的话，这一轮会悄悄退回本地直连生成：用户按完发送随手锁屏，
  // 本地 fetch 被系统掐掉，回来时既没有回复也没有报错，设置页还写着「已开启」，观察窗里
  // 查无此事。所以它必须是单独一档、而且落地一条 warn。
  it('配置根本读不出来 ≠ 没开：单独一档 config-unreadable，而且不许静默', async () => {
    storeState.configError = new Error('IndexedDB blocked by another tab');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 静音，只数次数 */ });
    const readiness = await resolveInstantChatReadiness();
    expect(readiness).toEqual({ ready: false, reason: 'config-unreadable' });
    expect(readiness.reason).not.toBe('disabled');
    expect(warn).toHaveBeenCalledTimes(1);
    // 只关心「走不走得通」的老调用点（设置页互斥门）行为不变：依旧是 false，不抛。
    expect(await isInstantChatReady()).toBe(false);
  });

  // ─── 角色级开关（undefined = 跟随全局默认开，只认显式 false）───

  it('角色自己关了 → 不走云端，reason char-disabled', async () => {
    const char = { activeMsg2Config: { enabled: true, instantChatEnabled: false } } as any;
    expect(await resolveInstantChatReadiness(char)).toEqual({ ready: false, reason: 'char-disabled' });
  });

  it('字段没设 / 显式 true → 照常上云（undefined 就是开，没有兼容舞步）', async () => {
    expect(await resolveInstantChatReadiness({ activeMsg2Config: { enabled: true } } as any))
      .toEqual({ ready: true });
    expect(await resolveInstantChatReadiness({ activeMsg2Config: { enabled: true, instantChatEnabled: true } } as any))
      .toEqual({ ready: true });
    // 连 activeMsg2Config 都没有的角色也一样是开。
    expect(await resolveInstantChatReadiness({} as any)).toEqual({ ready: true });
  });

  it('与排程开关互相独立：enabled=false 不影响即时对话', async () => {
    // 只即时不排程：排程关着、即时字段没设 → 照常上云。
    expect(await resolveInstantChatReadiness({ activeMsg2Config: { enabled: false } } as any))
      .toEqual({ ready: true });
  });

  it('char-disabled 是用户的主动选择，不 warn（跟「全局没开」同一待遇）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 静音，只数次数 */ });
    await resolveInstantChatReadiness({ activeMsg2Config: { enabled: true, instantChatEnabled: false } } as any);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('随这一轮上云的作废回执', () => {
  const NOTICE_CHAR = 'char-notice';

  it('202 之后只记账，不销账（受理 ≠ 角色读到过）', () => {
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1', ['n1', 'n2']);
    expect(getStagedInstantChatExpiredNotices(NOTICE_CHAR)).toEqual({
      charId: NOTICE_CHAR, uuid: 'uuid-1', ids: ['n1', 'n2'],
    });
    expect(storeState.markedNotices).toEqual([]);
  });

  it('回复真的落库了才销账，而且只销一次', async () => {
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1', ['n1', 'n2']);
    expect(await settleInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1')).toEqual(['n1', 'n2']);
    expect(storeState.markedNotices).toEqual([{ charId: NOTICE_CHAR, ids: ['n1', 'n2'] }]);
    // 台账已经取走：同一轮的补收 / 重复冲刷再调一次不会二次销账。
    expect(await settleInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1')).toEqual([]);
    expect(storeState.markedNotices).toHaveLength(1);
  });

  it('销账认 uuid：上一轮迟到的结论碰不到新那一轮的回执', async () => {
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-new', ['n1']);
    expect(await settleInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-old')).toEqual([]);
    expect(storeState.markedNotices).toEqual([]);
    expect(getStagedInstantChatExpiredNotices(NOTICE_CHAR)?.uuid).toBe('uuid-new');
  });

  it('连发时新那一轮顶掉旧记录（旧的还没销账，会跟着新一轮一起重注）', () => {
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1', ['n1']);
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-2', ['n1', 'n2']);
    expect(getStagedInstantChatExpiredNotices(NOTICE_CHAR)).toEqual({
      charId: NOTICE_CHAR, uuid: 'uuid-2', ids: ['n1', 'n2'],
    });
  });

  it('台账扛得住重启（云端那一轮本来就可能横跨一次刷新）', () => {
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1', ['n1']);
    expect(JSON.parse(localStorage.getItem(AMSG_INSTANT_CHAT_STAGED_NOTICES_LS_KEY) || '{}'))
      .toEqual({ [NOTICE_CHAR]: { charId: NOTICE_CHAR, uuid: 'uuid-1', ids: ['n1'] } });
  });

  // 这一条是整个改动的由头：云端整轮失败（空输出被判 skip-push / fire 重试打光）时，
  // 回执要是已经销过账，角色永远不知道那条任务被作废过 —— 聊天里许下的承诺凭空消失。
  it('这一轮判定失败 → 回执退回未告知，绝不销账', async () => {
    setInstantChatPending(NOTICE_CHAR, 'uuid-1', 1_000);
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-1', ['n1']);
    vi.spyOn(DB, 'saveMessage').mockResolvedValue(undefined as any);
    await failInstantChatPending(NOTICE_CHAR, 'uuid-1', '云端生成失败');
    expect(storeState.markedNotices).toEqual([]);
    expect(getStagedInstantChatExpiredNotices(NOTICE_CHAR)).toBeNull();
  });

  it('失败结论对不上当前这一轮 → 新那一轮的回执一根都别动', async () => {
    setInstantChatPending(NOTICE_CHAR, 'uuid-new', 2_000);
    stageInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-new', ['n1']);
    vi.spyOn(DB, 'saveMessage').mockResolvedValue(undefined as any);
    await failInstantChatPending(NOTICE_CHAR, 'uuid-old', '迟到的结论');
    expect(getStagedInstantChatExpiredNotices(NOTICE_CHAR)?.ids).toEqual(['n1']);
    expect(discardInstantChatExpiredNotices(NOTICE_CHAR, 'uuid-new')).toEqual(['n1']);
    expect(storeState.markedNotices).toEqual([]);
  });
});

describe('推送丢了的补收（服务端账本）', () => {
  const outboxPush = (messageId: string, overrides: Record<string, any> = {}) => ({
    messageKind: 'content',
    messageType: 'instant',
    source: 'scheduled',
    message: '我在呢',
    contactName: '小满',
    messageId,
    sessionId: 'sess-1',
    messageIndex: 1,
    totalMessages: 1,
    timestamp: new Date(1_700_000_000_000).toISOString(),
    taskId: 7,
    taskUuid: 'uuid-round-1',
    occurrenceMs: 1_700_000_000_000,
    metadata: { charId: CHAR.id, charName: '小满', amsgInstantChat: true },
    ...overrides,
  });

  const entry = (messageId: string, push: Record<string, any>, createdAt = Date.now()) => ({
    id: 1, messageId, taskUuid: 'uuid-round-1', sessionId: 'sess-1',
    messageIndex: 1, totalMessages: 1, createdAt, deliveredAt: null, push,
  });

  const stubOutbox = (entries: any[]) => {
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue(entries as any);
  };

  // 这一组测的都是「已经接上账本之后」的常规补收。首次接管走的是另一条路（存量整批
  // 销账、不上屏），单独一组在下面。
  beforeEach(() => {
    localStorage.setItem(AMSG_OUTBOX_ADOPTED_LS_KEY, JSON.stringify({ at: Date.now() }));
  });

  it('账本上的那条写进收件箱，字段跟 SW 收真推送时写的一份对得上', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_0';
    stubOutbox([entry(messageId, outboxPush(messageId))]);
    const { written, ackNow } = await drainOutbox();
    expect(written).toBe(1);
    expect(ackNow).toEqual([]);           // 落库之前不许销账
    const saved = storeState.saved[0];
    expect(saved.charId).toBe(CHAR.id);
    expect(saved.body).toBe('我在呢');
    expect(saved.messageType).toBe('instant');
    expect(saved.taskId).toBe(7);
    expect(saved.metadata.sessionId).toBe('sess-1');
    expect(saved.sentAt).toBe(1_700_000_000_000);
  });

  // 账本是这一版才开始销账的，头一次拉会把历史积压一次性倒出来。不掐时效的话，那些
  // 早就落过库的老消息会因为超出近史去重的查询窗口而重新上屏。
  it('超过时效窗口的条目不进聊天流，当场销账', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_0';
    const tooOld = Date.now() - OUTBOX_BACKFILL_MAX_AGE_MS - 1;
    stubOutbox([entry(messageId, outboxPush(messageId), tooOld)]);
    const { written, ackNow } = await drainOutbox();
    expect(written).toBe(0);
    expect(storeState.saved).toHaveLength(0);
    expect(ackNow).toEqual([messageId]);
  });

  // 线上真实事故的第二半：一条回复在账本上躺了 28 小时，用户隔天开 App 时被自动补收
  // 按「太旧了」销掉，一个字都没上屏；他后来去点「找回没收到的消息」，看到的是
  // 「账本上没有漏收的消息——这条链路是通的」。窗口拉到两天能盖住「隔一夜 + 第二天
  // 想起来」这个最常见的节奏，而超窗的那些必须数出来说给用户听。
  it('窗口是两天：47 小时的补回来，49 小时的算作「拿不回来了」', async () => {
    const fresh = 'msg-47h';
    const stale = 'msg-49h';
    stubOutbox([
      entry(fresh, outboxPush(fresh), Date.now() - 47 * 3_600_000),
      entry(stale, outboxPush(stale), Date.now() - 49 * 3_600_000),
    ]);
    const { written, ackNow, staleDropped } = await drainOutbox();
    expect(written, '47 小时还在窗口内').toBe(1);
    expect(ackNow, '49 小时的只销账').toEqual([stale]);
    expect(staleDropped, '超窗的要数出来，界面靠它说话').toBe(1);
  });

  // 账本行躺到超龄，最常见的成因根本不是「消息丢了」，而是**消息早就送达了**：收尾那笔
  // 销账是 fire-and-forget，用户看完随手锁屏就被掐断，账一直挂着。不核对本地就一律按
  // 「永久拿不回来了」报的话，用户会收到一句红字说自己丢了消息——而那条消息就躺在聊天
  // 记录里，他刚刚才看过。
  it('超龄但本地已经有同 id 的消息 → 只补销账，不算「拿不回来了」', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_0';
    const tooOld = Date.now() - OUTBOX_BACKFILL_MAX_AGE_MS - 1;
    stubOutbox([entry(messageId, outboxPush(messageId), tooOld)]);
    // 落库的每条气泡都继承 metadata.activeMsg2.messageId，核对认的就是它。
    vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([
      { role: 'assistant', metadata: { activeMsg2: { messageId } } },
    ] as any);

    const { written, ackNow, staleDropped } = await drainOutbox();

    expect(written).toBe(0);
    expect(ackNow, '账还是要销，不然每趟都把它捞回来').toEqual([messageId]);
    expect(staleDropped, '消息就在聊天记录里，一条都没丢').toBe(0);
  });

  it('超龄且本地确实没有 → 照旧算「拿不回来了」', async () => {
    const messageId = 'msg-really-lost';
    const tooOld = Date.now() - OUTBOX_BACKFILL_MAX_AGE_MS - 1;
    stubOutbox([entry(messageId, outboxPush(messageId), tooOld)]);
    vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);

    const { ackNow, staleDropped } = await drainOutbox();

    expect(ackNow).toEqual([messageId]);
    expect(staleDropped).toBe(1);
  });

  // staleDropped 只数「本该收到、现在永久拿不回来」的那一档。思维链、工具请求这些
  // 本来就不进聊天流，销掉不损失任何东西——混进来的话，界面会把「丢了 1 条」说成
  // 「丢了 3 条」，用户白紧张一场，真出事时也就不信这个数了。
  it('只数超窗的那一档，不进聊天流的那几类不算「丢了」', async () => {
    stubOutbox([
      entry('msg-reasoning', outboxPush('msg-reasoning', { messageKind: 'reasoning' })),
      entry('msg-tool', outboxPush('msg-tool', { messageKind: 'tool_request' })),
    ]);
    const { ackNow, staleDropped } = await drainOutbox();
    expect(ackNow).toHaveLength(2);
    expect(staleDropped).toBe(0);
  });

  // 补收回来已经没有意义的那几类：思维链要挂在正文上、工具请求那头的云端早就收工了、
  // 隔了一阵子的报错弹出来只会让人摸不着头脑。但账还是要销，不然每趟都把它们捞回来。
  it.each(['reasoning', 'tool_request', 'error'])('%s 类不进聊天流，当场销账', async (kind) => {
    const messageId = `msg-${kind}`;
    stubOutbox([entry(messageId, outboxPush(messageId, { messageKind: kind }))]);
    const { written, ackNow } = await drainOutbox();
    expect(written).toBe(0);
    expect(storeState.saved).toHaveLength(0);
    expect(ackNow).toEqual([messageId]);
  });

  // 后台任务（门牌整理这类）跑完送回来的结果**只走这条路**：不弹通知的结果上游只落
  // 账本、不发推送，所以补收是它唯一的入口。跟 reasoning/error 那批一起当场销账丢掉的
  // 话，云端跑完的东西会一声不响地全部蒸发——面板全绿、日志干净、就是东西没了。
  describe('后台任务的结果（messageKind: result）', () => {
    beforeEach(() => {
      resultDispatch.calls = [];
      resultDispatch.contexts = [];
      resultDispatch.settle = true;
    });

    it('交给分发口，不写进聊天流', async () => {
      const messageId = 'msg-result';
      const push = outboxPush(messageId, {
        messageKind: 'result',
        resultKind: 'plate-consolidate',
        message: undefined,
        items: [{ room: 'user_room', text: '小明搬去合租了' }],
      });
      stubOutbox([entry(messageId, push)]);
      const { written, ackNow } = await drainOutbox();

      expect(written).toBe(0);
      expect(storeState.saved).toHaveLength(0);
      expect(resultDispatch.calls).toEqual([push]);
      expect(ackNow).toEqual([messageId]);
    });

    it('消化失败就不销账，下次上线再拉回来', async () => {
      resultDispatch.settle = false;
      const messageId = 'msg-result-retry';
      stubOutbox([entry(messageId, outboxPush(messageId, {
        messageKind: 'result', resultKind: 'plate-consolidate',
      }))]);
      const { ackNow } = await drainOutbox();
      expect(ackNow).toEqual([]);
    });

    // 回归守卫：这条路刻意跳过了聊天那两天的时效窗（结果晚到本来就是常态），可跳过
    // 之后没换上任何上限。账本留 28 天——重装 PWA 的用户第一次接上账本会把一个月前的结果
    // 一次性拉回来。这里不替各种产物定规矩，但账本上记的时间必须原样交出去，认领它的
    // 那一方才判得了「陈到不能用了没有」。
    it('时效窗那道判断不套在结果上，但账本上记的时间要交出去', async () => {
      const messageId = 'msg-result-old';
      const tooOld = Date.now() - OUTBOX_BACKFILL_MAX_AGE_MS - 1;
      stubOutbox([entry(messageId, outboxPush(messageId, {
        messageKind: 'result', resultKind: 'plate-consolidate',
      }), tooOld)]);
      await drainOutbox();
      expect(resultDispatch.calls).toHaveLength(1);
      expect(resultDispatch.contexts[0], '不交时间的话它连「这份躺了多久」都问不出来')
        .toEqual({ createdAt: tooOld });
    });
  });

  it('情绪结果显式标成 emotion_update（冲刷管线靠它分流，认不出会当正文气泡渲染）', async () => {
    const messageId = 'msg-emotion';
    stubOutbox([entry(messageId, outboxPush(messageId, {
      messageKind: 'emotion_update',
      messageType: undefined,
      message: '',
      metadata: { charId: CHAR.id, emotionRaw: '{"joy":1}' },
    }))]);
    const { written } = await drainOutbox();
    expect(written).toBe(1);
    expect(storeState.saved[0].messageType).toBe('emotion_update');
    expect(storeState.saved[0].metadata.emotionRaw).toBe('{"joy":1}');
  });

  it('推送载荷少了 charId → 没有落点，丢掉并销账而不是造一条无主消息', async () => {
    stubOutbox([entry('msg-orphan', { messageKind: 'content', message: '孤儿' })]);
    const { written, ackNow } = await drainOutbox();
    expect(written).toBe(0);
    expect(storeState.saved).toHaveLength(0);
    expect(ackNow).toEqual(['msg-orphan']);
  });

  // 销账即失忆：账一销，这条就再也拉不回来了。写不进收件箱时必须留着账。
  it('写收件箱失败 → 不销账，下次拉回来再试', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_0';
    stubOutbox([entry(messageId, outboxPush(messageId))]);
    const { ActiveMsgStore } = await import('./activeMsgStore');
    vi.spyOn(ActiveMsgStore, 'saveInboxMessage').mockRejectedValueOnce(new Error('quota'));
    const { written, ackNow } = await drainOutbox();
    expect(written).toBe(0);
    expect(ackNow).toEqual([]);
  });

  it('账本读失败照常抛（「没读到」≠「读到了、确实没有」，调用方才好分开收场）', async () => {
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockRejectedValue(new Error('offline'));
    await expect(drainOutbox()).rejects.toThrow('offline');
  });

  // 契约测试：push→inbox 的字段映射有两份手工同步的副本（SW 的 saveContentToInbox 与
  // 这里的补收路径），销账检查只读 metadata.messageIndex/totalMessages、缺失当末段——
  // 任一副本漏抄这两个字段，多段回复的首段就会被当成末段销账，后续段永久丢失且无报错。
  // 这里钉住补收侧必须把顶层段号抄进 metadata（与 sw-keep-alive.ts 的映射同一条规则；
  // 那份是 SW 代码没法直接 import，改动 SW 映射时这条测试就是要一起过的清单）。
  it('顶层 messageIndex/totalMessages 必须抄进 metadata（销账检查只认 metadata 里的）', async () => {
    const messageId = 'msg_task_7@1700000000000_hook_0';
    stubOutbox([entry(messageId, {
      messageKind: 'content',
      message: '第一段',
      messageId,
      sessionId: 'sess_task_7@1700000000000',
      taskUuid: 'uuid-round-1',
      messageIndex: 1,
      totalMessages: 3,
      metadata: { charId: CHAR.id },
    })]);
    await drainOutbox();
    const inbox = storeState.saved[0];
    expect(inbox).toBeTruthy();
    expect(inbox.metadata.messageIndex).toBe(1);
    expect(inbox.metadata.totalMessages).toBe(3);
    expect(inbox.metadata.sessionId).toBe('sess_task_7@1700000000000');
  });
});

// 账本上躺着的存量 ≠「我丢了的消息」：服务端从建表那一刻起就在记，而销账是客户端这
// 一版才有的能力。头一趟要是当补收放进聊天流，用户会被这段时间收过的消息整批重放一遍
// （角色「疯狂回复」，而且删掉重复消息反而会让近史去重失效、下一趟倒得更凶）。时效
// 窗口挡不住这一档——存量的年龄本来就在窗口之内，「昨晚更新 worker、今天升级前端」
// 就是最典型的那条时间线。
describe('第一次接上服务端账本', () => {
  const entry = (messageId: string, taskUuid: string) => ({
    id: 1,
    messageId,
    taskUuid,
    sessionId: 'sess-x',
    messageIndex: 1,
    totalMessages: 1,
    createdAt: Date.now(),
    deliveredAt: null,
    push: {
      messageKind: 'content',
      message: '这是账本上的存量',
      messageId,
      taskUuid,
      metadata: { charId: CHAR.id, charName: '小满' },
    },
  });

  const stubOutboxOnce = (entries: any[]) =>
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue(entries as any);

  it('存量整批销账，一条都不进聊天流', async () => {
    stubOutboxOnce([entry('m1', 'uuid-1'), entry('m2', 'uuid-2')]);
    const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);

    const { written, ackNow } = await drainOutbox();

    expect(written).toBe(0);
    expect(storeState.saved).toHaveLength(0);
    expect(ack).toHaveBeenCalledWith(['m1', 'm2']);
    expect(ackNow).toEqual([]);      // 已经在接管里销掉了，不用调用方再销一次
    expect(localStorage.getItem(AMSG_OUTBOX_ADOPTED_LS_KEY)).toBeTruthy();
  });

  // 接管那一趟恰好赶上用户发消息时，这一轮的回复不能被当存量销掉——否则他等来的是
  // 一句「云端已处理，但回复没能取回」。
  it('此刻正等着的那一轮不算存量，照常补收上屏', async () => {
    setInstantChatPending(CHAR.id, 'uuid-awaited');
    stubOutboxOnce([entry('m-old', 'uuid-old'), entry('m-awaited', 'uuid-awaited')]);
    const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);

    const { written } = await drainOutbox();

    expect(written).toBe(1);
    expect(storeState.saved.map((m: any) => m.messageId)).toEqual(['m-awaited']);
    expect(ack).toHaveBeenCalledWith(['m-old']);
  });

  // 回归守卫：换设备 / 重装 PWA / 清过 localStorage 的用户，启动第一趟走的就是这条路。
  // 后台任务的结果不进聊天流，没有「存量重放刷屏」这回事，而补收是它唯一的入口（不弹
  // 通知的结果上游只落账本、不发推送）。跟存量一起销掉的话，云端已经跑完的门牌整理会
  // 一声不响地蒸发，面板全绿、日志干净、就是东西没了。
  it('后台任务的结果不算存量，照常交给分发口', async () => {
    resultDispatch.calls = [];
    resultDispatch.settle = true;
    const resultEntry = {
      ...entry('m-result', 'uuid-job'),
      push: { messageKind: 'result', resultKind: 'plate-consolidate', messageId: 'm-result' },
    };
    stubOutboxOnce([entry('m-old', 'uuid-old'), resultEntry]);
    const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);

    const { ackNow } = await drainOutbox();

    expect(ack, '结果不在整批销账那一批里').toHaveBeenCalledWith(['m-old']);
    expect(resultDispatch.calls).toHaveLength(1);
    expect(ackNow, '消化成功之后才销它自己那一条').toEqual(['m-result']);
    expect(localStorage.getItem(AMSG_OUTBOX_ADOPTED_LS_KEY)).toBeTruthy();
  });

  // 先记标记再销账的话，销账一失败，剩下的存量下一趟就会被当成补收倒进聊天流。
  it('存量没销干净 → 不记标记，下一趟重新接管', async () => {
    stubOutboxOnce([entry('m1', 'uuid-1')]);
    vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockRejectedValue(new Error('worker 没应答'));

    const { written, ackNow } = await drainOutbox();

    expect(written).toBe(0);
    expect(storeState.saved).toHaveLength(0);
    expect(ackNow).toEqual([]);
    expect(localStorage.getItem(AMSG_OUTBOX_ADOPTED_LS_KEY)).toBeNull();
  });

  it('接管过一次之后，账本上的新条目照常补收', async () => {
    const list = stubOutboxOnce([entry('m-backlog', 'uuid-old')]);
    vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
    await drainOutbox();
    expect(storeState.saved).toHaveLength(0);

    list.mockResolvedValue([entry('m-new', 'uuid-new')] as any);
    const { written } = await drainOutbox();

    expect(written).toBe(1);
    expect(storeState.saved.map((m: any) => m.messageId)).toEqual(['m-new']);
  });

  // 自动路径把存量整批销掉是对的（分不清哪些是真丢的），但对「我确实少收了消息」的
  // 用户来说，那批存量恰恰就是他要找的东西——销了就再也拿不回来了。所以手动补收
  // 这条路要能越过接管：用户自己知道自己丢了，这个判断他做得了。
  it('手动补收越过首次接管，存量照样上屏', async () => {
    stubOutboxOnce([entry('m-missed', 'uuid-missed')]);
    const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);

    const { written } = await drainOutbox({ treatBacklogAsMissed: true });

    expect(written).toBe(1);
    expect(storeState.saved.map((m: any) => m.messageId)).toEqual(['m-missed']);
    // 没被当存量销掉：销账要等落库走完那一步（backfill 里 written 的那条不进 ackNow）。
    expect(ack).not.toHaveBeenCalledWith(['m-missed']);
    // 手动补过一次就算接上了，后面回到自动路径，别下次又把新条目当存量销掉。
    expect(localStorage.getItem(AMSG_OUTBOX_ADOPTED_LS_KEY)).toBeTruthy();
  });
});
