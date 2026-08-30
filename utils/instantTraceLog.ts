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
const TRACE_LOG_LIMIT = 200;

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
