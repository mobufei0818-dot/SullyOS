import { describe, it, expect } from 'vitest';
import { summarizeChannelHealth } from './swChannelProbe';

/**
 * 这组测试守的是一件很容易被忽略的事：主动消息有实时和兜底两条腿，实时那条断了之后
 * **功能表面上仍然是好的**——消息照样会到，只是每条都要白等最多一分钟。所以判定不能
 * 看「消息到没到」，只能看「有没有过 SW 喊页面这件事」。
 */
describe('summarizeChannelHealth（实时通道还活着没有）', () => {
  it('收到过 SW 消息 → 判定正常，并给出最近那次的时刻', () => {
    const health = summarizeChannelHealth([
      { event: 'runtime-flush-start', ts: '2026-09-04T02:50:30.000Z', trigger: 'SW通知' },
      { event: 'runtime-sw-message', ts: '2026-09-04T02:50:29.000Z' },
    ]);

    expect(health.status).toBe('ok');
    expect(health.lastSwMessageAt).toBe('2026-09-04T02:50:29.000Z');
  });

  it('消息一直在到、但没有一次是 SW 喊的 → 判定为只剩兜底', () => {
    // 这正是线上那台设备的形态：冲刷在跑、消息也上屏了，就是没人实时喊过它。
    // 只看「有没有冲刷」会把这种情况判成正常，那就永远发现不了。
    const health = summarizeChannelHealth([
      { event: 'runtime-flush-start', ts: '2026-09-04T02:50:30.000Z', trigger: '轮询补收' },
      { event: 'runtime-flush-start', ts: '2026-09-04T02:53:35.000Z', trigger: '轮询补收' },
      { event: 'runtime-inbox-message', ts: '2026-09-04T02:53:36.000Z' },
    ]);

    expect(health.status).toBe('fallback-only');
    expect(health.lastSwMessageAt).toBeUndefined();
  });

  it('一次冲刷都没有 → 不下结论（刚装好、或这段时间根本没消息）', () => {
    expect(summarizeChannelHealth([]).status).toBe('idle');
    expect(summarizeChannelHealth([{ event: 'runtime-emotion-done' }]).status).toBe('idle');
  });

  it('记录乱序时取最新的那条 SW 消息，不是最后遇到的那条', () => {
    const health = summarizeChannelHealth([
      { event: 'runtime-sw-message', ts: '2026-09-04T02:50:29.000Z' },
      { event: 'runtime-sw-message', ts: '2026-09-04T01:00:00.000Z' },
    ]);

    expect(health.lastSwMessageAt).toBe('2026-09-04T02:50:29.000Z');
  });

  it('按触发源分类计数，多的排前面', () => {
    const health = summarizeChannelHealth([
      { event: 'runtime-flush-start', trigger: '轮询补收' },
      { event: 'runtime-flush-start', trigger: '轮询补收' },
      { event: 'runtime-flush-start', trigger: '轮询补收' },
      { event: 'runtime-flush-start', trigger: '回到前台' },
    ]);

    expect(health.flushByTrigger).toEqual([
      { trigger: '轮询补收', count: 3 },
      { trigger: '回到前台', count: 1 },
    ]);
  });

  it('没带触发源的冲刷不计数，免得凑出一个查不出所以然的分组', () => {
    const health = summarizeChannelHealth([
      { event: 'runtime-flush-start' },
      { event: 'runtime-flush-start', trigger: 'SW通知' },
    ]);

    expect(health.flushByTrigger).toEqual([{ trigger: 'SW通知', count: 1 }]);
  });
});
