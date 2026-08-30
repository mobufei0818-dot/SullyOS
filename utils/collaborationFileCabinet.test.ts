import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import {
  buildCollaborationFileCabinetBlock,
  collaborationFileMessageMetadata,
  extractCollaborationFileDirectives,
  resolveCollaborationFileByTitle,
} from '../features/collaboration/chatLibrary';
import type { CollaborationLibraryFile } from '../features/collaboration/types';

const file = (name: string, assetId: string, extractedText = ''): CollaborationLibraryFile => ({
  id: `attachment-${assetId}`,
  assetId,
  kind: 'artifact',
  name,
  mimeType: name.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size: 2048,
  createdAt: Number(assetId.replace(/\D/g, '')) || 1,
  extractedText,
  format: name.endsWith('.pdf') ? 'pdf' : 'docx',
  sessionId: 'session-1',
  sessionTitle: '交付窗口',
  messageId: `message-${assetId}`,
});

const message = (patch: Partial<Message>): Message => ({
  id: 1,
  charId: 'char-1',
  role: 'user',
  type: 'text',
  content: '',
  timestamp: 1,
  ...patch,
});

describe('current-chat collaboration file cabinet', () => {
  it('parses Chinese and protocol directives while keeping natural text', () => {
    const parsed = extractCollaborationFileDirectives('我做过这个，发你看看。\n[[COLLAB_FILE:项目说明.pdf]]\n[[协同文件：《项目说明.pdf》]]');
    expect(parsed.visibleText).toBe('我做过这个，发你看看。');
    expect(parsed.requestedTitles).toEqual(['项目说明.pdf']);
  });

  it('resolves exact names and only unambiguous exact stems', () => {
    const files = [file('项目说明.pdf', 'asset-1'), file('项目说明.docx', 'asset-2')];
    expect(resolveCollaborationFileByTitle(files, '《项目说明.pdf》')?.assetId).toBe('asset-1');
    expect(resolveCollaborationFileByTitle(files, '项目说明')).toBeNull();
    expect(resolveCollaborationFileByTitle([files[0]], '项目说明')?.assetId).toBe('asset-1');
    expect(resolveCollaborationFileByTitle(files, '项目说名.pdf')).toBeNull();
  });

  it('injects titles only and expands exact content for the current title mention or next turn after delivery', () => {
    const files = [
      file('项目说明.pdf', 'asset-1', '这是项目说明的完整正文。'),
      file('预算.docx', 'asset-2', '这是预算正文。'),
      file('会议纪要.docx', 'asset-3', '这是会议纪要正文。'),
      file('旧方案.pdf', 'asset-4', '这是旧方案正文。'),
    ];
    const byTitle = buildCollaborationFileCabinetBlock(files, [message({ content: '顺便看看《项目说明》里写了什么' })], '条条');
    expect(byTitle).toContain('《项目说明.pdf》');
    expect(byTitle).toContain('《预算.docx》');
    expect(byTitle).toContain('这是项目说明的完整正文。');
    expect(byTitle).not.toContain('这是预算正文。');
    expect(byTitle).not.toContain('application/pdf');
    expect(byTitle).not.toContain('2048 bytes');
    expect(byTitle).not.toContain('内容速览');
    expect(byTitle).not.toContain('#### 《预算.docx》的可读内容');
    expect(byTitle).not.toContain('#### 《旧方案.pdf》的可读内容');

    const afterDelivery = buildCollaborationFileCabinetBlock(files, [
      message({ id: 1, role: 'assistant', type: 'collaboration_file', content: '[协同文件：预算.docx]', metadata: { collaborationAssetId: 'asset-2', fileName: '预算.docx' }, timestamp: 1 }),
      message({ id: 2, role: 'user', content: '这个里面写了什么', timestamp: 2 }),
    ], '条条');
    expect(afterDelivery).toContain('#### 《预算.docx》的可读内容');
    expect(afterDelivery).toContain('这是预算正文。');
    expect(afterDelivery).not.toContain('#### 《项目说明.pdf》的可读内容');

    const oneTurnLater = buildCollaborationFileCabinetBlock(files, [
      message({ id: 1, role: 'user', content: '把预算发我', timestamp: 1 }),
      message({ id: 2, role: 'assistant', type: 'collaboration_file', content: '[协同文件：预算.docx]', metadata: { collaborationAssetId: 'asset-2', fileName: '预算.docx' }, timestamp: 2 }),
      message({ id: 3, role: 'user', content: '这个里面写了什么', timestamp: 3 }),
      message({ id: 4, role: 'assistant', content: '我看一下。', timestamp: 4 }),
      message({ id: 5, role: 'user', content: '好哦', timestamp: 5 }),
    ], '条条');
    expect(oneTurnLater).not.toContain('#### 《预算.docx》的可读内容');
    expect(oneTurnLater).not.toContain('这是预算正文。');
  });

  it('uses the actual user profile name in the character-facing prompt', () => {
    const block = buildCollaborationFileCabinetBlock([file('交付.pdf', 'asset-9')], [], '条条');
    expect(block).toContain('引导「条条」从 ChatApp 加号页进入');
    expect(block).not.toContain('引导「用户」');
  });

  it('does not truncate or cap explicitly requested readable file bodies', () => {
    const longBody = `开头-${'正文'.repeat(7_000)}-结尾`;
    const files = [
      file('长文档.pdf', 'asset-10', longBody),
      file('第二份.pdf', 'asset-11', '第二份全文'),
      file('第三份.pdf', 'asset-12', '第三份全文'),
      file('第四份.pdf', 'asset-13', '第四份全文'),
    ];
    const block = buildCollaborationFileCabinetBlock(files, [message({
      content: '读取《长文档》《第二份》《第三份》《第四份》',
    })], '条条');
    expect(block).toContain(longBody);
    expect(block).toContain('第二份全文');
    expect(block).toContain('第三份全文');
    expect(block).toContain('第四份全文');
    expect(block).not.toContain('已截断');
  });

  it('keeps chat message metadata reference-only', () => {
    const metadata = collaborationFileMessageMetadata(file('交付.pdf', 'asset-9', '很长的正文'));
    expect(metadata.collaborationAssetId).toBe('asset-9');
    expect(metadata.fileName).toBe('交付.pdf');
    expect(JSON.stringify(metadata)).not.toContain('很长的正文');
    expect(metadata).not.toHaveProperty('blob');
  });
});
