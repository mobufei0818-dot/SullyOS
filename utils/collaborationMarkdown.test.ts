import { describe, expect, it } from 'vitest';
import {
  collaborationInlineText,
  normalizeCollaborationVisibleText,
  parseCollaborationMarkdown,
} from '../features/collaboration/markdown';

describe('collaboration markdown', () => {
  it('keeps visible structure without showing source markers', () => {
    const blocks = parseCollaborationMarkdown(`## 模块五：下一步

* [x] **终身退货窗口**：永久关闭。
* [ ] **待办事项**：进行能量补给。

---

\`\`\`js
WHILE (alive) { LOVE(); }
\`\`\``);

    expect(blocks.map(block => block.type)).toEqual([
      'heading', 'blank', 'check', 'check', 'blank', 'divider', 'blank', 'code',
    ]);
    const check = blocks.find(block => block.type === 'check');
    expect(check?.type === 'check' && check.checked).toBe(true);
    expect(check?.type === 'check' ? collaborationInlineText(check.spans) : '').toBe('终身退货窗口：永久关闭。');
    expect(check?.type === 'check' ? check.spans.some(span => span.kind === 'bold') : false).toBe(true);
    expect(JSON.stringify(blocks)).not.toContain('**');
    expect(JSON.stringify(blocks)).not.toContain('```');
  });

  it('keeps unsafe links as spans for the renderer to treat as plain text', () => {
    const [paragraph] = parseCollaborationMarkdown('[安全](https://example.com) [危险](javascript:alert(1))');
    expect(paragraph.type).toBe('paragraph');
    if (paragraph.type !== 'paragraph') return;
    expect(paragraph.spans.filter(span => span.kind === 'link')).toHaveLength(2);
  });

  it('removes leaked ChatApp transcript prefixes while keeping separate paragraphs', () => {
    const cleaned = normalizeCollaborationVisibleText([
      '[2026-08-30 01:41] [聊天] 第一段回复。',
      '[2026-08-30 01:42] [聊天] 第二段回复。',
    ].join('\n'));
    expect(cleaned).toBe('第一段回复。\n\n第二段回复。');
    expect(parseCollaborationMarkdown(cleaned).map(block => block.type)).toEqual(['paragraph', 'blank', 'paragraph']);
  });

  it('does not rewrite ordinary dates or artifact-like prose', () => {
    const source = '报告日期：[2026-08-30 01:41]\n正文中的 [聊天] 标签需要保留。';
    expect(normalizeCollaborationVisibleText(source)).toBe(source);
  });
});
