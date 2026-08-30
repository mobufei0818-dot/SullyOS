import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendInstantTraceEntry,
  formatInstantTraceLog,
  readAllInstantTraces,
  readRecentInstantTraces,
} from './instantTraceLog';

// 这个缓冲存在的意义是「隔着屏幕把现场交出来」：远端用户手上没有 DevTools（iOS 装成
// PWA 更是一点辙都没有），出事之后唯一能拿到的证据就是它。面板上只显示得下最近几条，
// 所以下面钉的两件事都是导出这条路的命门：
//   1. 全量读到的必须比面板显示的多——否则「复制全部」复制的还是屏幕上那几行；
//   2. 一条都没有时返回空串——调用方据此不动作，不能让用户复制到一份空壳还以为成了。

const TRACE_LOG_KEY = 'instant_push_trace_log_v1';

describe('instantTraceLog 导出', () => {
  beforeEach(() => {
    localStorage.removeItem(TRACE_LOG_KEY);
  });

  it('全量读拿得到面板显示不下的那些（导出的是现场，不是屏幕上那几行）', () => {
    for (let i = 0; i < 20; i++) {
      appendInstantTraceEntry({ ts: new Date(i).toISOString(), event: `e${i}` });
    }

    expect(readRecentInstantTraces(5)).toHaveLength(5);
    expect(readAllInstantTraces()).toHaveLength(20);
    // 最新的排最前，两个读口同一个顺序口径。
    expect(readAllInstantTraces()[0].event).toBe('e19');
  });

  it('导出文本能解析回来，带着构建版本和全部条目', () => {
    appendInstantTraceEntry({ ts: '2026-08-20T01:32:00.000Z', event: 'runtime-expire-decision-swallow', anchorMs: 1 });
    appendInstantTraceEntry({ ts: '2026-08-20T01:33:00.000Z', event: 'runtime-flush-start' });

    const parsed = JSON.parse(formatInstantTraceLog());
    expect(parsed.count).toBe(2);
    expect(parsed.entries).toHaveLength(2);
    // 同一段 trace 在新旧构建上含义可能不同，不知道是哪个构建打的就只能靠猜。
    expect(typeof parsed.build).toBe('string');
    expect(parsed.build.length).toBeGreaterThan(0);
    expect(typeof parsed.appVersion).toBe('string');
    expect(parsed.entries[0].event).toBe('runtime-flush-start');
  });

  it('一条都没有时返回空串（调用方据此不动作，不给用户一份空壳）', () => {
    expect(formatInstantTraceLog()).toBe('');
  });
});
