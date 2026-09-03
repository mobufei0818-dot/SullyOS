// utils/amsg2ScheduleRestraint.test.ts
//
// 排程清单的「分寸」回归守卫。
//
// 病象：用户说「今天想看书」，角色排了一条晚上问进度的任务，之后每一轮聊天结尾都补
// 一句「书看到哪了」；早上问过一次早饭没得到回应，接着一路问喝水吃饭。根因不在人设
// 太爱操心——排程清单每轮全量注入、带着 promptHint 原文，还贴在整段 prompt 的最后
// 一句，模型于是把一件排在今晚的事读成了本轮就该办的事。
//
// 同仓库里每轮全量注入的块（便利贴、用药提醒、Notion 笔记）早就各配了「不必每次都提」
// 的分寸句，排程清单是漏掉的那一个。这份文件钉三样，任何一样塌了都不会报错，只会表现
// 成「角色又开始每轮催了」：
//   · 两处清单（平时聊天那份 / 到点那份）都带上「还没到点就别提前开口」；
//   · 两处说的是同一句话——各写各的迟早漂成两套词，模型会当成两回事；
//   · 清单块插在易变尾段之前，「回到你自己」钢印还是模型开口前的最后一眼。

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// amsg2TaskContext 顶层拉了 DB / 台账，纯 Node 环境里跑不起来；这里只测拼文案。
vi.mock('./db', () => ({ DB: { getRecentMessagesByCharId: vi.fn() } }));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    upsertExpiredNotices: vi.fn().mockResolvedValue([]),
    getExpiredNotices: vi.fn().mockResolvedValue([]),
  },
}));

import { AMSG2_SCHEDULE_NOT_YET_NOTE, buildFireTaskListBlock } from './amsg2Tasks';
import { buildAmsg2TaskContextText, insertAmsg2TaskContextBlock } from './amsg2TaskContext';
import type { ActiveMsg2TaskRecord } from '../types';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const H = 3600_000;
/** 就是那条惹祸的任务：今晚问问书看到哪了。 */
const bookTask = (over: Partial<ActiveMsg2TaskRecord> = {}): ActiveMsg2TaskRecord => ({
  taskUuid: 'aabbccdd-0000-0000-0000-000000000000',
  clientTaskId: 'cid-aabb',
  mode: 'prompted',
  firstSendTime: new Date(Date.now() + 8 * H).toISOString(),
  recurrenceType: 'none',
  promptHint: '问问书看到哪了',
  expirePolicy: 'expire',
  source: 'character',
  status: 'scheduled',
  createdAt: Date.now(),
  ...over,
});

describe('排程清单不该被当成本轮待办', () => {
  it('平时聊天：有任务时清单带上「还没到点别提前开口」', () => {
    const text = buildAmsg2TaskContextText([bookTask()], [], Date.now(), undefined);
    // promptHint 照旧给全：改期、取消、判断「已经排着相近的一条」都要靠它，
    // 藏起来是把能力和病症一起砍了。要管的是模型怎么读它，不是让它看不见。
    expect(text).toContain('问问书看到哪了');
    expect(text).toContain(AMSG2_SCHEDULE_NOT_YET_NOTE);
  });

  it('一条都没排时不提这句：没有可催的事，白说一遍反而勾着', () => {
    const text = buildAmsg2TaskContextText([], [], Date.now(), undefined);
    expect(text).not.toContain(AMSG2_SCHEDULE_NOT_YET_NOTE);
    // 常驻简介照旧在（角色得随时知道自己能排），只是不该顺带提醒「催」这件事存在
    expect(text).toContain('schedule_active_message');
  });

  it('到点那份清单同样带这句：正在发的是这条，别顺手把没到点的几条一起催了', () => {
    const block = buildFireTaskListBlock([bookTask()], {
      nowMs: Date.now(),
      tzId: 'Asia/Shanghai',
    });
    expect(block).toContain(AMSG2_SCHEDULE_NOT_YET_NOTE);
  });

  it('两处引用同一个常量，不是各写各的字面量', () => {
    const ctxSrc = read('./amsg2TaskContext.ts');
    const tasksSrc = read('./amsg2Tasks.ts');
    expect(ctxSrc).toContain('AMSG2_SCHEDULE_NOT_YET_NOTE');
    expect(tasksSrc).toContain('AMSG2_SCHEDULE_NOT_YET_NOTE');
    // 正文只该在常量定义那一处出现；哪边现抄一份，两处的词迟早对不上
    const literal = '不用你现在提前替它开口';
    expect((ctxSrc.match(new RegExp(literal, 'g')) ?? []).length).toBe(0);
    expect((tasksSrc.match(new RegExp(literal, 'g')) ?? []).length).toBe(1);
  });
});

describe('排程块的位置：钢印要留住最后一眼', () => {
  const block = { role: 'system', content: '【你的主动消息排程·仅你可见】…' };

  it('插在易变尾段之前，「回到你自己」还是最后一条', () => {
    const messages = [
      { role: 'system', content: '稳定前缀' },
      { role: 'user', content: '在吗' },
      { role: 'system', content: '易变尾段…### 最后，回到你自己' },
    ];
    const out = insertAmsg2TaskContextBlock(messages, block, 2);
    expect(out.map((m) => m.content)).toEqual([
      '稳定前缀',
      '在吗',
      block.content,
      '易变尾段…### 最后，回到你自己',
    ]);
    expect(out[out.length - 1].content).toContain('回到你自己');
  });

  it('工具循环里下标照用：前缀没动，块仍落在尾段之前而不是 tool 结果后面', () => {
    const loopMessages = [
      { role: 'system', content: '稳定前缀' },
      { role: 'user', content: '在吗' },
      { role: 'system', content: '易变尾段' },
      { role: 'assistant', content: '(tool_calls)' },
      { role: 'tool', content: '已创建' },
    ];
    const out = insertAmsg2TaskContextBlock(loopMessages, block, 2);
    expect(out[2].content).toBe(block.content);
    expect(out[3].content).toBe('易变尾段');
    expect(out).toHaveLength(6);
  });

  it('拿不到尾段下标时退回贴尾：位置不理想，但块本身不能丢', () => {
    // 丢了的话角色不知道自己名下挂着什么，同一件事会被重复排。
    const messages = [{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }];
    for (const idx of [-1, 99]) {
      const out = insertAmsg2TaskContextBlock(messages, block, idx);
      expect(out[out.length - 1].content).toBe(block.content);
      expect(out).toHaveLength(3);
    }
  });

  it('useChatAI 不再把排程块贴在数组尾巴上', () => {
    const src = read('../hooks/useChatAI.ts');
    expect(src).toContain('insertAmsg2TaskContextBlock(messages, block, payload.volatileTailIndex)');
    // 旧写法：return [...messages, { role: 'system', content: text }]
    expect(src).not.toMatch(/\[\s*\.\.\.messages,\s*\{\s*role:\s*'system',\s*content:\s*text\s*\}\s*\]/);
  });
});
