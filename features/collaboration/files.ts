import JSZip from 'jszip';
import { extractPdfText, isPdfFile } from '../../utils/pdfText';
import type {
  CollaborationArtifactFormat,
  CollaborationAttachment,
} from './types';
import { collaborationId } from './types';
import {
  collaborationInlineText,
  parseCollaborationMarkdown,
  type CollaborationInlineSpan,
  type CollaborationMarkdownBlock,
} from './markdown';

const MAX_EXTRACTED_CHARS = 300_000;

export interface ExtractedSourceFile {
  text: string;
  pageCount?: number;
}

export const isCollaborationImageFile = (file: Pick<File, 'name' | 'type'>): boolean => (
  /^image\/(?:png|jpe?g|webp|gif)$/i.test(file.type)
  || /\.(?:png|jpe?g|webp|gif)$/i.test(file.name)
);

export const collaborationBlobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => typeof reader.result === 'string'
    ? resolve(reader.result)
    : reject(new Error('图片读取失败'));
  reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
  reader.readAsDataURL(blob);
});

const clampExtractedText = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_EXTRACTED_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_EXTRACTED_CHARS)}\n\n[文件内容过长，协同工作仅读取了前 ${MAX_EXTRACTED_CHARS.toLocaleString()} 个字符]`;
};

const extractDocxText = async (file: File): Promise<string> => {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) throw new Error('没有在 Word 文件中找到正文');
  const xml = new DOMParser().parseFromString(documentXml, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('Word 文件正文无法解析');
  const paragraphs = Array.from(xml.getElementsByTagNameNS('*', 'p'));
  return paragraphs.map(paragraph => {
    const pieces: string[] = [];
    Array.from(paragraph.getElementsByTagName('*')).forEach(node => {
      const name = node.localName;
      if (name === 't') pieces.push(node.textContent || '');
      else if (name === 'tab') pieces.push('\t');
      else if (name === 'br' || name === 'cr') pieces.push('\n');
    });
    return pieces.join('');
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
};

export const extractSourceFile = async (
  file: File,
  onProgress?: (label: string) => void,
): Promise<ExtractedSourceFile> => {
  if (isPdfFile(file)) {
    const result = await extractPdfText(await file.arrayBuffer(), {
      onProgress: ({ page, totalPages }) => onProgress?.(`正在读取 ${file.name} · ${page}/${totalPages} 页`),
    });
    if (!result.text.trim()) {
      throw new Error('这个 PDF 没有可提取的文字；扫描版 PDF 暂时需要先做 OCR');
    }
    const clamped = clampExtractedText(result.text);
    const complete = !clamped.includes('[文件内容过长，协同工作仅读取了前');
    const coverage = complete
      ? `[PDF 全文已提取：共 ${result.pageCount} 页，已读取 ${result.extractedPages} 页]`
      : `[PDF 已提取 ${result.extractedPages}/${result.pageCount} 页；正文超过字符上限，以下内容已标注截断]`;
    return { text: `${coverage}\n\n${clamped}`, pageCount: result.pageCount };
  }
  if (/\.docx$/i.test(file.name)) {
    onProgress?.(`正在读取 ${file.name}`);
    const text = await extractDocxText(file);
    if (!text.trim()) throw new Error('这个 Word 文件没有可提取的正文');
    return { text: clampExtractedText(text) };
  }
  if (/\.doc$/i.test(file.name)) {
    throw new Error('旧版 .doc 暂不支持，请先另存为 .docx');
  }
  if (/\.(txt|md|markdown|json|csv|tsv|html?|xml|yaml|yml)$/i.test(file.name) || file.type.startsWith('text/')) {
    onProgress?.(`正在读取 ${file.name}`);
    return { text: clampExtractedText(await file.text()) };
  }
  throw new Error('暂时支持常见图片、PDF、DOCX、TXT、Markdown、JSON、CSV 和 HTML 文件');
};

const escapeXml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const runXml = (
  text: string,
  options: { bold?: boolean; italic?: boolean; code?: boolean; link?: boolean } = {},
): string => {
  const font = options.code ? 'Consolas' : 'Aptos';
  const eastAsia = options.code ? 'Microsoft YaHei' : 'Microsoft YaHei';
  const properties = [
    `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${eastAsia}"/>`,
    options.bold ? '<w:b/><w:bCs/>' : '',
    options.italic ? '<w:i/><w:iCs/>' : '',
    options.code ? '<w:shd w:val="clear" w:color="auto" w:fill="EEF1F5"/><w:sz w:val="20"/>' : '',
    options.link ? '<w:color w:val="4F46E5"/><w:u w:val="single"/>' : '',
  ].join('');
  return `<w:r><w:rPr>${properties}</w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
};

const inlineRunsXml = (
  spans: CollaborationInlineSpan[],
  extra: { bold?: boolean; italic?: boolean } = {},
): string => spans.map(span => runXml(
  span.kind === 'link' && span.href ? `${span.text} (${span.href})` : span.text,
  {
    ...extra,
    bold: extra.bold || span.kind === 'bold',
    italic: extra.italic || span.kind === 'italic',
    code: span.kind === 'code',
    link: span.kind === 'link',
  },
)).join('');

const markdownBlockXml = (block: CollaborationMarkdownBlock): string => {
  if (block.type === 'blank') return '<w:p/>';
  if (block.type === 'divider') {
    return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="8" w:color="CBD5E1"/></w:pBdr><w:spacing w:after="160"/></w:pPr></w:p>';
  }
  if (block.type === 'code') {
    return (block.text.split('\n').length ? block.text.split('\n') : ['']).map(line => (
      `<w:p><w:pPr><w:ind w:left="240"/><w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/><w:spacing w:after="0"/></w:pPr>${runXml(line || ' ', { code: true })}</w:p>`
    )).join('');
  }
  if (block.type === 'heading') {
    const level = Math.min(3, block.level);
    return `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>${inlineRunsXml(block.spans, { bold: true })}</w:p>`;
  }
  if (block.type === 'bullet') {
    return `<w:p><w:pPr><w:ind w:left="480" w:hanging="280"/></w:pPr>${runXml('•  ')}${inlineRunsXml(block.spans)}</w:p>`;
  }
  if (block.type === 'ordered') {
    return `<w:p><w:pPr><w:ind w:left="480" w:hanging="280"/></w:pPr>${runXml(`${block.ordinal}.  `)}${inlineRunsXml(block.spans)}</w:p>`;
  }
  if (block.type === 'check') {
    return `<w:p><w:pPr><w:ind w:left="480" w:hanging="280"/></w:pPr>${runXml(block.checked ? '☒  ' : '☐  ', { bold: true })}${inlineRunsXml(block.spans)}</w:p>`;
  }
  if (block.type === 'quote') {
    return `<w:p><w:pPr><w:ind w:left="420"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="CBD5E1"/></w:pBdr></w:pPr>${inlineRunsXml(block.spans, { italic: true })}</w:p>`;
  }
  return `<w:p>${inlineRunsXml(block.spans)}</w:p>`;
};

export const createDocxBlob = async (content: string, title: string): Promise<Blob> => {
  const zip = new JSZip();
  const body = parseCollaborationMarkdown(content).map(markdownBlockXml).join('');
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`);
  zip.folder('_rels')?.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`);
  zip.folder('docProps')?.file('core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
  <dc:title>${escapeXml(title)}</dc:title><dc:creator>SullyOS 协同工作</dc:creator><dcterms:created>${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`);
  const word = zip.folder('word');
  word?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`);
  word?.folder('_rels')?.file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  word?.file('styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120" w:line="340" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
</w:styles>`);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
};

const canvasToJpeg = (canvas: HTMLCanvasElement): Promise<Uint8Array> => new Promise((resolve, reject) => {
  canvas.toBlob(async blob => {
    if (!blob) {
      reject(new Error('PDF 页面渲染失败'));
      return;
    }
    resolve(new Uint8Array(await blob.arrayBuffer()));
  }, 'image/jpeg', 0.92);
});

const wrapCanvasText = (context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] => {
  if (!text) return [''];
  const words = /\s/.test(text) ? text.split(/(\s+)/).filter(Boolean) : Array.from(text);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current + word;
    if (current && context.measureText(candidate).width > maxWidth) {
      lines.push(current.trimEnd());
      current = word.trimStart();
    } else {
      current = candidate;
    }
  }
  if (current || lines.length === 0) lines.push(current.trimEnd());
  return lines;
};

const renderPdfPages = async (content: string, title: string): Promise<Array<{ bytes: Uint8Array; width: number; height: number }>> => {
  if (typeof document === 'undefined') throw new Error('当前环境无法生成 PDF');
  const width = 1240;
  const height = 1754;
  const marginX = 104;
  const marginTop = 112;
  const marginBottom = 112;
  const pages: HTMLCanvasElement[] = [];
  let canvas!: HTMLCanvasElement;
  let context!: CanvasRenderingContext2D;
  let y = marginTop;

  const newPage = () => {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    context = canvas.getContext('2d') as CanvasRenderingContext2D;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#172033';
    context.textBaseline = 'top';
    pages.push(canvas);
    y = marginTop;
  };

  const drawBlock = (text: string, font: string, lineHeight: number, gapAfter: number, color = '#172033') => {
    context.font = font;
    const lines = wrapCanvasText(context, text, width - marginX * 2);
    for (const line of lines) {
      if (y + lineHeight > height - marginBottom) {
        newPage();
        context.font = font;
      }
      context.fillStyle = color;
      context.fillText(line, marginX, y);
      y += lineHeight;
    }
    y += gapAfter;
  };

  newPage();
  drawBlock(title, '700 52px system-ui, "Microsoft YaHei", sans-serif', 68, 34);
  for (const block of parseCollaborationMarkdown(content)) {
    if (block.type === 'heading') {
      const fontSize = block.level === 1 ? 46 : block.level === 2 ? 40 : 35;
      drawBlock(collaborationInlineText(block.spans), `700 ${fontSize}px system-ui, "Microsoft YaHei", sans-serif`, fontSize + 16, block.level === 1 ? 24 : 18);
    } else if (block.type === 'bullet') {
      drawBlock(`•  ${collaborationInlineText(block.spans)}`, '32px system-ui, "Microsoft YaHei", sans-serif', 50, 7);
    } else if (block.type === 'ordered') {
      drawBlock(`${block.ordinal}.  ${collaborationInlineText(block.spans)}`, '32px system-ui, "Microsoft YaHei", sans-serif', 50, 7);
    } else if (block.type === 'check') {
      drawBlock(`${block.checked ? '☒' : '☐'}  ${collaborationInlineText(block.spans)}`, '32px system-ui, "Microsoft YaHei", sans-serif', 50, 7);
    } else if (block.type === 'quote') {
      drawBlock(`❝  ${collaborationInlineText(block.spans)}`, 'italic 31px system-ui, "Microsoft YaHei", sans-serif', 49, 10, '#64748b');
    } else if (block.type === 'code') {
      const codeLines = block.text.split('\n');
      for (const line of codeLines) drawBlock(line || ' ', '27px ui-monospace, Consolas, "Microsoft YaHei", monospace', 43, 0, '#334155');
      y += 12;
    } else if (block.type === 'divider') {
      if (y + 32 > height - marginBottom) newPage();
      context.strokeStyle = '#cbd5e1';
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(marginX, y + 8);
      context.lineTo(width - marginX, y + 8);
      context.stroke();
      y += 32;
    } else if (block.type === 'blank') {
      y += 24;
    } else {
      drawBlock(collaborationInlineText(block.spans), '32px system-ui, "Microsoft YaHei", sans-serif', 50, 8, '#25314a');
    }
    if (y > height - marginBottom) newPage();
  }
  return Promise.all(pages.map(async page => ({ bytes: await canvasToJpeg(page), width, height })));
};

const concatBytes = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  chunks.forEach(chunk => {
    result.set(chunk, offset);
    offset += chunk.length;
  });
  return result;
};

export const assembleImagePdf = (images: Array<{ bytes: Uint8Array; width: number; height: number }>): Blob => {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0];
  let length = 0;
  const push = (chunk: Uint8Array) => { chunks.push(chunk); length += chunk.length; };
  const pushText = (text: string) => push(encoder.encode(text));
  const objectCount = 2 + images.length * 3;
  const pageObjectIds = images.map((_, index) => 3 + index * 3);

  pushText('%PDF-1.4\n%PDFIMG\n');
  const addObject = (id: number, body: string | Uint8Array, suffix = '') => {
    offsets[id] = length;
    pushText(`${id} 0 obj\n`);
    if (typeof body === 'string') pushText(body);
    else push(body);
    pushText(`${suffix}\nendobj\n`);
  };

  addObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
  addObject(2, `<< /Type /Pages /Count ${images.length} /Kids [${pageObjectIds.map(id => `${id} 0 R`).join(' ')}] >>`);
  images.forEach((image, index) => {
    const pageId = pageObjectIds[index];
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    addObject(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    const imageHeader = `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`;
    addObject(imageId, concatBytes([encoder.encode(imageHeader), image.bytes]), '\nendstream');
    const commands = 'q\n595.28 0 0 841.89 0 0 cm\n/Im0 Do\nQ\n';
    addObject(contentId, `<< /Length ${encoder.encode(commands).length} >>\nstream\n${commands}endstream`);
  });
  const xrefOffset = length;
  pushText(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= objectCount; id++) pushText(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  pushText(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  const pdfBytes = concatBytes(chunks);
  const pdfBuffer = pdfBytes.buffer.slice(
    pdfBytes.byteOffset,
    pdfBytes.byteOffset + pdfBytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([pdfBuffer], { type: 'application/pdf' });
};

export const createPdfBlob = async (content: string, title: string): Promise<Blob> => (
  assembleImagePdf(await renderPdfPages(content, title))
);

const safeFileStem = (title: string): string => title
  .trim()
  .replace(/[\\/:*?"<>|]/g, '-')
  .replace(/\s+/g, ' ')
  .slice(0, 80) || '协同工作文件';

export interface ParsedArtifactRequest {
  title: string;
  format: CollaborationArtifactFormat;
  content: string;
}

const ARTIFACT_BLOCK = /```artifact\s*\n([\s\S]*?)```/gi;
const ALLOWED_FORMATS = new Set<CollaborationArtifactFormat>(['txt', 'md', 'html', 'json', 'docx', 'pdf']);

export const parseArtifactBlocks = (response: string): { visibleText: string; artifacts: ParsedArtifactRequest[] } => {
  const artifacts: ParsedArtifactRequest[] = [];
  const visibleText = response.replace(ARTIFACT_BLOCK, (_block, blockText: string) => {
    try {
      const parsed = JSON.parse(blockText.trim());
      const format = String(parsed?.format || '').toLowerCase() as CollaborationArtifactFormat;
      if (!ALLOWED_FORMATS.has(format) || typeof parsed?.content !== 'string') return _block;
      artifacts.push({
        title: typeof parsed.title === 'string' ? parsed.title : '协同工作文件',
        format,
        content: parsed.content,
      });
      return '';
    } catch {
      const separator = blockText.indexOf('\n---');
      if (separator < 0) return _block;
      const header = blockText.slice(0, separator).trim();
      const content = blockText.slice(separator + 4).replace(/^\s*\n/, '').trimEnd();
      const title = header.match(/^title\s*:\s*(.+)$/im)?.[1]?.trim();
      const format = header.match(/^format\s*:\s*([a-z0-9]+)$/im)?.[1]?.toLowerCase() as CollaborationArtifactFormat | undefined;
      if (!title || !format || !ALLOWED_FORMATS.has(format) || !content) return _block;
      artifacts.push({ title, format, content });
      return '';
    }
  }).trim();
  return { visibleText, artifacts };
};

const artifactMimeType = (format: CollaborationArtifactFormat): string => {
  if (format === 'pdf') return 'application/pdf';
  if (format === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (format === 'html') return 'text/html;charset=utf-8';
  if (format === 'json') return 'application/json;charset=utf-8';
  if (format === 'md') return 'text/markdown;charset=utf-8';
  return 'text/plain;charset=utf-8';
};

export const materializeArtifact = async (
  request: ParsedArtifactRequest,
): Promise<{ attachment: CollaborationAttachment; blob: Blob }> => {
  const stem = safeFileStem(request.title);
  let blob: Blob;
  if (request.format === 'docx') blob = await createDocxBlob(request.content, request.title);
  else if (request.format === 'pdf') blob = await createPdfBlob(request.content, request.title);
  else blob = new Blob([request.content], { type: artifactMimeType(request.format) });
  const assetId = collaborationId('asset');
  return {
    blob,
    attachment: {
      id: collaborationId('attachment'),
      assetId,
      kind: 'artifact',
      name: `${stem}.${request.format}`,
      mimeType: blob.type || artifactMimeType(request.format),
      size: blob.size,
      createdAt: Date.now(),
      extractedText: clampExtractedText(request.content),
      format: request.format,
    },
  };
};
