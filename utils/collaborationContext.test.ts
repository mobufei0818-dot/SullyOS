import { describe, expect, it } from 'vitest';
import { buildCollaborationModelMessages, selectCollaborationMemories, stripFrozenCollaborationMemoryContext } from '../features/collaboration/context';
import type { MemoryNode } from './memoryPalace/types';

const memory = (id: string, content: string, patch: Partial<MemoryNode> = {}): MemoryNode => ({
  id,
  charId: 'char-1',
  content,
  room: 'study',
  tags: [],
  importance: 5,
  mood: 'neutral',
  embedded: false,
  createdAt: 1,
  lastAccessedAt: 1,
  accessCount: 0,
  ...patch,
});

describe('collaboration context isolation', () => {
  it('selects task-relevant memories and excludes archived or group memories', () => {
    const selected = selectCollaborationMemories([
      memory('project', '用户正在制作 AIRP 项目的协同工作模式', { importance: 8 }),
      memory('meal', '用户昨天吃了拉面', { importance: 9 }),
      memory('archived', 'AIRP 协同旧方案', { archived: true, importance: 10 }),
      memory('group', '群聊里讨论 AIRP', { groupId: 'group-1', importance: 10 }),
    ], '继续设计 AIRP 协同工作', 5, 10);
    expect(selected.map(item => item.id)).toContain('project');
    expect(selected.map(item => item.id)).not.toContain('archived');
    expect(selected.map(item => item.id)).not.toContain('group');
    expect(selected[0].id).toBe('project');
  });

  it('builds model history only from the explicitly supplied session', () => {
    const modelMessages = buildCollaborationModelMessages('角色快照', [
      { id: 'm1', sessionId: 'session-a', role: 'user', content: '这个窗口的任务', createdAt: 1 },
      { id: 'm2', sessionId: 'session-a', role: 'assistant', content: '这个窗口的回答', createdAt: 2 },
    ]);
    expect(modelMessages).toEqual([
      { role: 'system', content: '角色快照' },
      { role: 'user', content: '这个窗口的任务' },
      { role: 'assistant', content: '这个窗口的回答' },
    ]);
    expect(JSON.stringify(modelMessages)).not.toContain('其它窗口');
  });

  it('keeps frozen ChatApp roles before the collaboration overlay and isolated task history', () => {
    const modelMessages = buildCollaborationModelMessages('协同任务协议', [
      { id: 'm1', sessionId: 'session-a', role: 'user', content: '现在做报告', createdAt: 3 },
    ], undefined, [
      { role: 'system', content: 'ChatApp 完整 ContextBuilder' },
      { role: 'user', content: '日常聊天里的上一句' },
      { role: 'assistant', content: '日常聊天里的上一条回复' },
    ]);

    expect(modelMessages).toEqual([
      { role: 'system', content: 'ChatApp 完整 ContextBuilder' },
      { role: 'user', content: '日常聊天里的上一句' },
      { role: 'assistant', content: '日常聊天里的上一条回复' },
      { role: 'system', content: '协同任务协议' },
      { role: 'user', content: '现在做报告' },
    ]);
  });

  it('injects only the selected maker protocol into that collaboration window', () => {
    const messages = buildCollaborationModelMessages('角色快照', [
      { id: 'm1', sessionId: 'session-a', role: 'user', content: '想要夜航风格', createdAt: 1 },
    ], 'journal-css');
    expect(messages[1].role).toBe('system');
    expect(messages[1].content).toContain('kind: journal-css');
    expect(messages[1].content).toContain('.sully-journal');
    expect(JSON.stringify(messages)).not.toContain('kind: bubble-theme');
  });

  it('places a fresh per-turn memory block next to this session history', () => {
    const messages = buildCollaborationModelMessages('冻结角色身份', [
      { id: 'm1', sessionId: 'session-a', role: 'user', content: '继续昨天那份报告', createdAt: 1 },
    ], undefined, [], '### 本轮动态记忆（仅本次请求）\n- 昨天一起确定了目录');
    expect(messages).toEqual([
      { role: 'system', content: '冻结角色身份' },
      { role: 'system', content: '### 本轮动态记忆（仅本次请求）\n- 昨天一起确定了目录' },
      { role: 'user', content: '继续昨天那份报告' },
    ]);
  });

  it('keeps a full-length uploaded paper available on the next follow-up turn', () => {
    const paper = `摘要之后的论文全文：${'正文段落。'.repeat(55_000)}`;
    const messages = buildCollaborationModelMessages('角色快照', [
      {
        id: 'upload', sessionId: 'session-a', role: 'user', content: '请阅读这篇论文', createdAt: 1,
        attachments: [{ id: 'att', assetId: 'asset', kind: 'source', name: '论文.pdf', mimeType: 'application/pdf', size: 1, createdAt: 1, pageCount: 18, extractedText: paper }],
      },
      { id: 'summary', sessionId: 'session-a', role: 'assistant', content: '先说摘要。', createdAt: 2 },
      { id: 'follow-up', sessionId: 'session-a', role: 'user', content: '请继续分析正文第三节。', createdAt: 3 },
    ]);
    expect(messages.some(message => typeof message.content === 'string' && message.content.includes('摘要之后的论文全文'))).toBe(true);
    expect(messages.some(message => typeof message.content === 'string' && message.content.includes('PDF 共 18 页'))).toBe(true);
  });

  it('passes an explicitly selected Word format as an invisible delivery requirement', () => {
    const messages = buildCollaborationModelMessages('角色快照', [
      { id: 'm1', sessionId: 'session-a', role: 'user', content: '整理成报告', requestedFormat: 'docx', createdAt: 1 },
    ]);
    expect(messages[1].content).toContain('[本轮文件交付格式：docx');
    expect(messages[1].content).toContain('artifact 真文件');
  });

  it('removes stale one-time recall blocks from pre-upgrade session snapshots', () => {
    const cleaned = stripFrozenCollaborationMemoryContext(`### 角色设定
保留我是谁

### 记忆宫殿 (Memory Palace)
这里是首轮已经过期的召回
#### 用户的房间
- 老内容

### 当前模式
继续保留协同规则`);
    expect(cleaned).toContain('### 角色设定');
    expect(cleaned).toContain('### 当前模式');
    expect(cleaned).not.toContain('首轮已经过期的召回');
    expect(cleaned).not.toContain('老内容');
  });
});
