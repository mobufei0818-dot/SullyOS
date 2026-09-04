/**
 * Service Worker → 页面这条通道的体检。
 *
 * 主动消息有两条腿：推送到达时 SW 立刻喊页面（实时），以及页面自己每 60 秒去云端账本
 * 捞一次（兜底）。前者断了之后功能表面上还是好的——消息照样会到，只是慢上几十秒，
 * 用户多半会当成「网络有点卡」而不会来报，于是它可以坏很久没人发现。
 *
 * 这里做两件事：把「页面和 SW 是什么关系」拍个快照，以及**用推送真正走的那条路**
 * 探一次通不通。两者都只读、不改任何状态。
 */

/** 页面与 Service Worker 的注册关系。字段都取自浏览器，取不到就留空。 */
export interface SwRegistrationSnapshot {
  /** 这个环境有没有 Service Worker（隐私模式 / 老浏览器可能没有）。 */
  supported: boolean;
  /**
   * 页面**受不受**当前 SW 控制。
   * 为 false 时 SW 仍可能通过 includeUncontrolled 找到页面，所以它不等于「一定收不到」，
   * 但配合探测结果一起看就能说明问题。
   */
  controlled: boolean;
  /** SW 的作用域，和页面路径对不上的话 SW 根本管不到这个页面。 */
  scope?: string;
  /** 页面自己的路径（不带查询串和 hash，那上面可能有不该进日志的东西）。 */
  pagePath?: string;
  /** 三种状态各自的 state，用来看是不是卡在等待激活。 */
  activeState?: string;
  waitingState?: string;
  installingState?: string;
  /** 已激活 SW 的脚本路径，用来确认跑的是不是当前这份。 */
  activeScriptPath?: string;
  /** 装成 PWA 独立窗口打开的（iOS 上这种壳的行为跟浏览器标签页不一样）。 */
  standalone?: boolean;
}

/** 一次通道探测的结果。两条路分别记，为的是把「SW 没在跑」和「SW 找不到页面」分开。 */
export interface SwChannelProbeResult {
  /** 页面递了回信地址的那条路（MessageChannel）。它通 = SW 在跑、收得到页面的消息。 */
  portAck: boolean;
  portMs?: number;
  /**
   * SW 自己把页面找出来的那条路（clients.matchAll + postMessage）。
   * **推送通知页面走的就是它**，所以只有这条的结果能代表真实链路。
   */
  clientsAck: boolean;
  clientsMs?: number;
  /** 等了多久放弃。 */
  waitedMs: number;
}

/** 从已有记录看这条通道最近的状态。 */
export interface SwChannelHealth {
  /**
   * - 'ok'：最近确实收到过 SW 喊的消息，实时这条腿是活的
   * - 'fallback-only'：有冲刷发生过，但没有一次是 SW 喊的——全靠兜底在捞
   * - 'idle'：这段记录里根本没有冲刷，无从判断（刚装好、或一直没收到消息）
   */
  status: 'ok' | 'fallback-only' | 'idle';
  /** 最近一次收到 SW 消息的时刻（ISO），从来没有就是 undefined。 */
  lastSwMessageAt?: string;
  /** 各触发源分别冲刷了几次，按次数从多到少。 */
  flushByTrigger: Array<{ trigger: string; count: number }>;
}

/**
 * 判断实时通道还活着没有。
 *
 * 判据是「有没有过 SW 喊页面这件事」，而不是「消息到没到」——消息最终总会到（兜底
 * 轮询在捞），所以拿它当判据永远看不出问题。反过来，一段时间里冲刷全由兜底触发，
 * 就说明实时那条腿断了：功能看着正常，只是每条消息都白等最多一分钟。
 */
export const summarizeChannelHealth = (
  entries: Array<{ event?: string; ts?: string; trigger?: unknown }>,
): SwChannelHealth => {
  const counts = new Map<string, number>();
  let lastSwMessageAt: string | undefined;

  for (const entry of entries) {
    if (entry.event === 'runtime-sw-message') {
      // 记录不保证有序，取时间戳最大的那条。
      if (!lastSwMessageAt || String(entry.ts ?? '') > lastSwMessageAt) {
        lastSwMessageAt = entry.ts;
      }
    }
    if (entry.event === 'runtime-flush-start' && typeof entry.trigger === 'string') {
      counts.set(entry.trigger, (counts.get(entry.trigger) ?? 0) + 1);
    }
  }

  const flushByTrigger = [...counts.entries()]
    .map(([trigger, count]) => ({ trigger, count }))
    .sort((a, b) => b.count - a.count);

  const status: SwChannelHealth['status'] = lastSwMessageAt
    ? 'ok'
    : (flushByTrigger.length > 0 ? 'fallback-only' : 'idle');

  return { status, lastSwMessageAt, flushByTrigger };
};

/** 只留路径：查询串和 hash 上可能挂着不该进日志的东西。 */
const pathOf = (url: string): string => {
  try {
    return new URL(url, location.href).pathname;
  } catch {
    return '?';
  }
};

export const captureSwRegistrationSnapshot = async (): Promise<SwRegistrationSnapshot> => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return { supported: false, controlled: false };
  }

  const snapshot: SwRegistrationSnapshot = {
    supported: true,
    controlled: !!navigator.serviceWorker.controller,
    pagePath: typeof location !== 'undefined' ? pathOf(location.href) : undefined,
  };

  try {
    snapshot.standalone = typeof window !== 'undefined'
      && (window.matchMedia?.('(display-mode: standalone)').matches
        || (window.navigator as any)?.standalone === true);
  } catch { /* 拿不到就不记 */ }

  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) {
      snapshot.scope = pathOf(registration.scope);
      snapshot.activeState = registration.active?.state;
      snapshot.waitingState = registration.waiting?.state;
      snapshot.installingState = registration.installing?.state;
      if (registration.active?.scriptURL) {
        snapshot.activeScriptPath = pathOf(registration.active.scriptURL);
      }
    }
  } catch { /* 取不到注册信息就只回上面那几项 */ }

  return snapshot;
};

/**
 * 探一次 SW 能不能喊到这个页面。
 *
 * 发一条带随机串的探测给 SW，SW 会**分别**用两条路回信；这里等到两条都回来、
 * 或者等够 waitMs 为止。之所以要等而不是发完就走：没回信才是要抓的现象，
 * 而「没回信」只能靠等出来。
 *
 * 探测本身不改任何状态，失败也只是返回一份「都没通」的结果。
 */
export const probeSwChannel = async (waitMs = 3_000): Promise<SwChannelProbeResult> => {
  const result: SwChannelProbeResult = { portAck: false, clientsAck: false, waitedMs: waitMs };

  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return result;

  let target: ServiceWorker | null = null;
  try {
    target = navigator.serviceWorker.controller
      || (await navigator.serviceWorker.getRegistration())?.active
      || null;
  } catch { /* 下面按拿不到处理 */ }
  if (!target) return result;

  const nonce = `probe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();

  return await new Promise<SwChannelProbeResult>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      result.waitedMs = Date.now() - startedAt;
      try { navigator.serviceWorker.removeEventListener('message', onClientsMessage); } catch { /* ignore */ }
      clearTimeout(timer);
      resolve(result);
    };

    // clients 这条路的回信会走页面全局的 SW message 事件——跟真实推送落到同一个入口。
    const onClientsMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'sw-channel-probe-ack' || event.data?.nonce !== nonce) return;
      result.clientsAck = true;
      result.clientsMs = Date.now() - startedAt;
      if (result.portAck) finish();
    };

    try {
      navigator.serviceWorker.addEventListener('message', onClientsMessage);
    } catch { /* 加不上监听就只能靠超时收尾 */ }

    const timer = setTimeout(finish, waitMs);

    try {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event: MessageEvent) => {
        if (event.data?.type !== 'sw-channel-probe-port-ack' || event.data?.nonce !== nonce) return;
        result.portAck = true;
        result.portMs = Date.now() - startedAt;
        if (result.clientsAck) finish();
      };
      target.postMessage({ type: 'SW_CHANNEL_PROBE', nonce }, [channel.port2]);
    } catch {
      // 连消息都发不出去：两条路都算不通，不用干等满。
      finish();
    }
  });
};
