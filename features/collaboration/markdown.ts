export type CollaborationInlineKind = 'text' | 'bold' | 'italic' | 'code' | 'link';

export interface CollaborationInlineSpan {
  kind: CollaborationInlineKind;
  text: string;
  href?: string;
}

export type CollaborationMarkdownBlock =
  | { type: 'heading'; level: number; spans: CollaborationInlineSpan[] }
  | { type: 'paragraph'; spans: CollaborationInlineSpan[] }
  | { type: 'bullet'; spans: CollaborationInlineSpan[] }
  | { type: 'ordered'; ordinal: number; spans: CollaborationInlineSpan[] }
  | { type: 'check'; checked: boolean; spans: CollaborationInlineSpan[] }
  | { type: 'quote'; spans: CollaborationInlineSpan[] }
  | { type: 'code'; language: string; text: string }
  | { type: 'divider' }
  | { type: 'blank' };

const INLINE_TOKEN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|\[([^\]]+)\]\(([^)]+)\))/g;

export const parseCollaborationInline = (source: string): CollaborationInlineSpan[] => {
  const spans: CollaborationInlineSpan[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  INLINE_TOKEN.lastIndex = 0;
  while ((match = INLINE_TOKEN.exec(source))) {
    if (match.index > cursor) spans.push({ kind: 'text', text: source.slice(cursor, match.index) });
    const token = match[0];
    if (token.startsWith('`')) spans.push({ kind: 'code', text: token.slice(1, -1) });
    else if (token.startsWith('**') || token.startsWith('__')) spans.push({ kind: 'bold', text: token.slice(2, -2) });
    else if (token.startsWith('[')) spans.push({ kind: 'link', text: match[2], href: match[3] });
    else spans.push({ kind: 'italic', text: token.slice(1, -1) });
    cursor = match.index + token.length;
  }
  if (cursor < source.length) spans.push({ kind: 'text', text: source.slice(cursor) });
  if (spans.length === 0) spans.push({ kind: 'text', text: source });
  return spans;
};

export const collaborationInlineText = (spans: CollaborationInlineSpan[]): string => (
  spans.map(span => span.kind === 'link' && span.href ? `${span.text} (${span.href})` : span.text).join('')
);

/**
 * ChatApp's context transcript contains machine-facing rows such as
 * `[2026-08-30 01:41] [聊天] ...`. Some models imitate those prefixes in the
 * answer. They are context metadata, not part of the character's reply. Strip
 * only that exact row prefix and keep a paragraph boundary between the leaked
 * rows. Artifact/file bodies are parsed out before this helper is applied.
 */
export const normalizeCollaborationVisibleText = (source: string): string => {
  const transcriptPrefix = /(^|\n)[ \t]*\[\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\][ \t]*\[(?:聊天|通话|约会)\][ \t]*/g;
  let leakedRows = 0;
  const cleaned = source.replace(transcriptPrefix, (_match, boundary: string) => {
    leakedRows += 1;
    return boundary ? '\n\n' : '';
  });
  if (leakedRows === 0) return source;
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
};

export const parseCollaborationMarkdown = (source: string): CollaborationMarkdownBlock[] => {
  const blocks: CollaborationMarkdownBlock[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let codeLanguage = '';
  let codeLines: string[] | null = null;

  const finishCode = () => {
    if (!codeLines) return;
    blocks.push({ type: 'code', language: codeLanguage, text: codeLines.join('\n') });
    codeLines = null;
    codeLanguage = '';
  };

  for (const rawLine of lines) {
    const fence = rawLine.match(/^\s*```\s*([^\s`]*)\s*$/);
    if (fence) {
      if (codeLines) finishCode();
      else {
        codeLanguage = fence[1] || '';
        codeLines = [];
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(rawLine);
      continue;
    }

    const line = rawLine.replace(/\t/g, '    ');
    if (!line.trim()) {
      blocks.push({ type: 'blank' });
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'divider' });
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, spans: parseCollaborationInline(heading[2]) });
      continue;
    }
    const check = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (check) {
      blocks.push({ type: 'check', checked: check[1].toLowerCase() === 'x', spans: parseCollaborationInline(check[2]) });
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) {
      blocks.push({ type: 'bullet', spans: parseCollaborationInline(bullet[1]) });
      continue;
    }
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      blocks.push({ type: 'ordered', ordinal: Number(ordered[1]), spans: parseCollaborationInline(ordered[2]) });
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      blocks.push({ type: 'quote', spans: parseCollaborationInline(quote[1]) });
      continue;
    }
    blocks.push({ type: 'paragraph', spans: parseCollaborationInline(line) });
  }
  finishCode();
  return blocks;
};
