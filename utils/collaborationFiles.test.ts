import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { assembleImagePdf, createDocxBlob, parseArtifactBlocks } from '../features/collaboration/files';

describe('collaboration artifact files', () => {
  it('parses the resilient header-based artifact protocol', () => {
    const parsed = parseArtifactBlocks(`我整理好了。\n\n\`\`\`artifact\ntitle: 项目提案
format: docx
---
# 项目提案

- 第一项
- 第二项
\`\`\``);
    expect(parsed.visibleText).toBe('我整理好了。');
    expect(parsed.artifacts).toEqual([{
      title: '项目提案',
      format: 'docx',
      content: '# 项目提案\n\n- 第一项\n- 第二项',
    }]);
  });

  it('keeps malformed artifact blocks visible instead of silently losing content', () => {
    const source = '```artifact\ntitle: 缺格式\n---\n正文\n```';
    const parsed = parseArtifactBlocks(source);
    expect(parsed.artifacts).toHaveLength(0);
    expect(parsed.visibleText).toBe(source);
  });

  it('creates a real docx zip with readable document XML', async () => {
    const blob = await createDocxBlob('# 标题\n\n你好，**世界**。\n\n* [x] 已完成\n\n```js\nconst ok = true;\n```', '测试文档');
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const documentXml = await zip.file('word/document.xml')?.async('string');
    const visibleText = documentXml?.replace(/<[^>]+>/g, '') || '';
    expect(blob.type).toContain('wordprocessingml.document');
    expect(documentXml).toContain('标题');
    expect(visibleText).toContain('你好，世界。');
    expect(documentXml).toContain('<w:b/>');
    expect(documentXml).toContain('☒');
    expect(documentXml).toContain('const ok = true;');
    expect(documentXml).not.toContain('**');
    expect(documentXml).not.toContain('```');
    expect(zip.file('word/_rels/document.xml.rels')).toBeTruthy();
  });

  it('assembles a parseable PDF instead of a share-only placeholder', async () => {
    const onePixelJpeg = Uint8Array.from(atob('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z'), char => char.charCodeAt(0));
    const blob = assembleImagePdf([{ bytes: onePixelJpeg, width: 1, height: 1 }]);
    const buffer = await blob.arrayBuffer();
    const pdfText = new TextDecoder('latin1').decode(buffer);
    const xrefOffset = Number(pdfText.match(/startxref\s+(\d+)/)?.[1]);
    const xrefSection = pdfText.slice(xrefOffset);
    const offsets = Array.from(xrefSection.matchAll(/^(\d{10}) 00000 n\s*$/gm), match => Number(match[1]));

    expect(blob.type).toBe('application/pdf');
    expect(pdfText.startsWith('%PDF-1.4')).toBe(true);
    expect(pdfText.endsWith('%%EOF')).toBe(true);
    expect(blob.size).toBeGreaterThan(onePixelJpeg.length);
    expect(pdfText).toContain('/Type /Page');
    expect(pdfText).toContain('/Count 1');
    expect(offsets).toHaveLength(5);
    offsets.forEach((offset, index) => expect(pdfText.slice(offset)).toMatch(new RegExp(`^${index + 1} 0 obj`)));
  });
});
