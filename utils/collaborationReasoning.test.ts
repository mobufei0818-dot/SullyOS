import { describe, expect, it } from 'vitest';
import { parseCollaborationReply, visibleCollaborationStreamText } from '../features/collaboration/reasoning';

describe('collaboration reasoning output', () => {
  it('keeps a native reasoning channel separate from the delivered content', () => {
    expect(parseCollaborationReply({
      choices: [{ message: { content: '这是交付正文。', reasoning_content: '先核对需求，再生成文件。' } }],
    })).toEqual({
      content: '这是交付正文。',
      thinkingChain: '先核对需求，再生成文件。',
    });
  });

  it('extracts inline think blocks without leaking tags into the deliverable', () => {
    expect(parseCollaborationReply({
      choices: [{ message: { content: '<think>先检查格式。</think>\n文件已经整理好了。' } }],
    })).toEqual({
      content: '文件已经整理好了。',
      thinkingChain: '先检查格式。',
    });
  });

  it('understands typed content arrays used by Anthropic-compatible responses', () => {
    expect(parseCollaborationReply({
      choices: [{ message: { content: [
        { type: 'thinking', thinking: '得先把标题层级校准。' },
        { type: 'text', text: '标题层级已经校准。' },
      ] } }],
    })).toEqual({
      content: '标题层级已经校准。',
      thinkingChain: '得先把标题层级校准。',
    });
  });

  it('uses reasoning as the answer when a broken proxy leaves content empty', () => {
    expect(parseCollaborationReply({
      choices: [{ message: { content: '', reasoning: '代理把最终答案放错字段了。' } }],
    })).toEqual({ content: '代理把最终答案放错字段了。' });
  });

  it('hides an unfinished inline thinking block from the streaming draft', () => {
    expect(visibleCollaborationStreamText('<think>还在核对第三')).toBe('');
    expect(visibleCollaborationStreamText('<think>核对完成。</think>现在开始交付')).toBe('现在开始交付');
  });
});
