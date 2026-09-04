/**
 * Instant Push / 主动消息链路共用的 trace ring buffer（localStorage）。
 *
 * 「无条件抓」的那一层通道日志：不受 devDebug 勾选影响，开发者随时能翻最近发生了什么
 * （另外两写——console.info 和 appendDevDebugLog——各自留在调用方，语义不同）。
 *
 * 键名、容量、条目形状只在这里定义一次。写在 instantPushClient / activeMsgRuntime、
 * 读在调试面板，三处各抄一份的话，键一改（比如升 v2）读侧会静默显示空列表——
 * 调试面板骗人比没有更糟。
 */

import { APP_VERSION, BUILD_LABEL } from './buildInfo';

const TRACE_LOG_KEY = 'instant_push_trace_log_v1';
/**
 * 留多少条。
 *
 * 一轮多段回复本身就能打三四十条，再加上 SW 每喊一次页面也记一条，200 条只够翻回
 * 三四轮——而排障要的往往是「上午那次」。实测每条约 280 字节，400 条也就一百来 KB，
 * localStorage 装得下，导出的文件也还是能直接发给人的大小。
 */
const TRACE_LOG_LIMIT = 400;

export interface InstantTraceEntry {
  ts?: string;
  event?: string;
  sessionId?: string;
  [key: string]: unknown;
}

/** 追加一条，超出容量丢最老的。读写失败一律静默：trace 不能反过来打断正常链路。 */
export const appendInstantTraceEntry = (entry: InstantTraceEntry): void => {
  try {
    const raw = localStorage.getItem(TRACE_LOG_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const next = Array.isArray(list) ? [...list, entry].slice(-TRACE_LOG_LIMIT) : [entry];
    localStorage.setItem(TRACE_LOG_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
};

/** 最近 limit 条，最新的排在最前（调试面板按这个顺序显示）。 */
export const readRecentInstantTraces = (limit: number): InstantTraceEntry[] => {
  try {
    const raw = localStorage.getItem(TRACE_LOG_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.slice(-limit).reverse() : [];
  } catch {
    return [];
  }
};

/**
 * 缓冲里的**全部**条目（最新在最前），给「导出 trace」用。
 *
 * 面板上只显示得下最近几条，而排障要的恰恰是「一小时前那会儿发生了什么」——这两百条
 * 一直存着，缺的只是把它们拿出来的口子。远端用户手上没有 DevTools（iOS 装成 PWA 更是
 * 一点辙都没有），这是唯一能把现场交出来的途径。
 */
export const readAllInstantTraces = (): InstantTraceEntry[] =>
  readRecentInstantTraces(TRACE_LOG_LIMIT);

/**
 * 导出成一段能直接贴给开发者的文本。一条都没有时返回空串，调用方据此不做动作。
 *
 * 带上构建版本：同一段 trace 在新旧两个构建上的含义可能完全不同（事件名会加、会改），
 * 不知道是哪个构建打的就只能靠猜，而这份东西存在的意义就是不用猜。
 */
export const formatInstantTraceLog = (): string => {
  const entries = readAllInstantTraces();
  if (entries.length === 0) return '';
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    build: BUILD_LABEL,
    count: entries.length,
    entries,
  }, null, 2);
};

// ─── Service Worker 那一侧的日志 ───
//
// SW 里 console.log 出来的东西，在远端用户手上等于不存在（手机没有 DevTools，装成
// PWA 更没有），于是「推送到没到 SW、SW 有没有喊到页面」整段都看不见——而页面这边
// 的第一条记录已经是「开始处理」了，中间那截空白恰恰是最要命的地方。
// SW 把它写进一个独立的小库（见 worker/sw-keep-alive.ts），这里把它读出来一起导出。
const SW_TRACE_DB_NAME = 'ActiveMsgSwTrace';
const SW_TRACE_STORE = 'entries';

/**
 * 读 SW 写下的日志。**不带版本号打开**：库归 SW 建，页面这边只是来读，
 * 带版本号会在库还没被建过时触发一次建库、甚至跟 SW 抢升级。
 * 读不到就返回空数组——SW 还没装新版、或者浏览器不给开，都不该让导出整个失败。
 */
export const readSwTraces = async (): Promise<InstantTraceEntry[]> => {
  if (typeof indexedDB === 'undefined') return [];
  try {
    const db = await new Promise<IDBDatabase | null>((resolve) => {
      const request = indexedDB.open(SW_TRACE_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    if (!db) return [];
    try {
      if (!db.objectStoreNames.contains(SW_TRACE_STORE)) return [];
      const rows = await new Promise<InstantTraceEntry[]>((resolve) => {
        const tx = db.transaction(SW_TRACE_STORE, 'readonly');
        const request = tx.objectStore(SW_TRACE_STORE).getAll();
        request.onsuccess = () => resolve((request.result || []) as InstantTraceEntry[]);
        request.onerror = () => resolve([]);
        tx.onabort = () => resolve([]);
      });
      return rows;
    } finally {
      // 页面只是来读一趟，读完就还回去：连接开着会挡住 SW 后续的版本升级。
      try { db.close(); } catch { /* ignore */ }
    }
  } catch {
    return [];
  }
};

/** 导出文件里那段「这台设备当时是什么状况」。都是环境信息，不含任何聊天内容。 */
const captureEnvSnapshot = (): Record<string, unknown> => {
  const snapshot: Record<string, unknown> = {};
  try {
    snapshot.userAgent = navigator.userAgent;
    snapshot.language = navigator.language;
    // 装成 PWA 独立窗口跑的，行为跟浏览器标签页不一样（尤其 iOS）。
    snapshot.standalone = window.matchMedia?.('(display-mode: standalone)').matches
      || (navigator as any)?.standalone === true;
    snapshot.swSupported = 'serviceWorker' in navigator;
    snapshot.swControlled = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;
    snapshot.visibility = typeof document !== 'undefined' ? document.visibilityState : undefined;
    snapshot.online = navigator.onLine;
    // 导出这一刻设备的钟。跟条目里的时间戳对照能看出设备时钟有没有跑偏。
    snapshot.now = new Date().toISOString();
    snapshot.timezoneOffsetMin = new Date().getTimezoneOffset();
  } catch { /* 拿不到的就不记 */ }
  return snapshot;
};

/**
 * 导出「页面 + SW 两侧合在一起」的完整现场。
 *
 * 两侧的记录都带 ISO 时间戳，合并后按时间排一次，读的人就能直接看出
 * 「推送几点到的 SW、SW 几点喊的页面、页面几点才动手」——这三个时刻之间的空档，
 * 正是排这类故障唯一要看的东西。
 */
export const formatFullTraceLog = async (): Promise<string> => {
  const pageEntries = readAllInstantTraces();
  const swEntries = await readSwTraces();
  if (pageEntries.length === 0 && swEntries.length === 0) return '';

  const merged = [
    ...pageEntries.map((entry) => ({ side: 'page', ...entry })),
    ...swEntries.map((entry) => ({ side: 'sw', ...entry })),
  ].sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')));

  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    build: BUILD_LABEL,
    env: captureEnvSnapshot(),
    count: merged.length,
    pageCount: pageEntries.length,
    swCount: swEntries.length,
    entries: merged,
  }, null, 2);
};
