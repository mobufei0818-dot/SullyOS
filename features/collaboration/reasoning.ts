export interface ParsedCollaborationReply {
  content: string;
  thinkingChain?: string;
}

const readText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      return readText(record.text ?? record.content ?? record.value ?? record.thinking);
    }).join('');
  }
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  return readText(record.text ?? record.content ?? record.value ?? record.thinking);
};

const readContentAndThinking = (value: unknown): { content: string; thinking: string } => {
  if (!Array.isArray(value)) return { content: readText(value), thinking: '' };
  const content: string[] = [];
  const thinking: string[] = [];
  value.forEach(block => {
    if (typeof block === 'string') {
      content.push(block);
      return;
    }
    if (!block || typeof block !== 'object') return;
    const record = block as Record<string, unknown>;
    const type = String(record.type || '').toLowerCase();
    const thought = readText(record.thinking ?? record.reasoning ?? record.reasoning_content);
    if (thought && (['thinking', 'reasoning', 'analysis'].includes(type) || !record.text && !record.content)) {
      thinking.push(thought);
    }
    const text = readText(record.text ?? record.content ?? record.value);
    if (text && !['thinking', 'reasoning', 'analysis'].includes(type)) content.push(text);
  });
  return { content: content.join(''), thinking: thinking.join('') };
};

/**
 * Keep the model's native reasoning channel separate from the deliverable.
 * A few OpenAI-compatible proxies put the final answer in reasoning_content
 * while leaving content empty; in that case it remains the answer instead of
 * being duplicated as both thinking and visible output.
 */
export const parseCollaborationReply = (data: any): ParsedCollaborationReply => {
  const message = data?.choices?.[0]?.message || data?.message || data || {};
  const separated = readContentAndThinking(message.content);
  const directContent = separated.content.trim();
  const nativeReasoning = [
    separated.thinking,
    readText(message.reasoning_content ?? message.reasoning ?? message.thinking ?? ''),
  ].map(item => item.trim()).filter(Boolean).join('\n\n');
  const raw = directContent || nativeReasoning;
  const nativeChain = directContent ? nativeReasoning : '';
  const inlineChains: string[] = [];
  const closedThinkRe = /<(think|thinking|thought)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let content = raw.replace(closedThinkRe, (_whole: string, _tag: string, body: string) => {
    if (body.trim()) inlineChains.push(body.trim());
    return '';
  });
  content = content.replace(/<(?:think|thinking|thought)\b[^>]*>([\s\S]*)$/i, (_whole: string, body: string) => {
    if (body.trim()) inlineChains.push(body.trim());
    return '';
  });
  content = content.replace(/<\/?(?:think|thinking|thought)\b[^>]*>/gi, '').trim();
  const uniqueChains = [...new Set([nativeChain, ...inlineChains].map(item => item.trim()).filter(Boolean))];
  return {
    content,
    ...(uniqueChains.length ? { thinkingChain: uniqueChains.join('\n\n') } : {}),
  };
};

/** Strip incomplete inline thinking from the visible streaming draft. */
export const visibleCollaborationStreamText = (fullText: string): string => (
  parseCollaborationReply({ choices: [{ message: { content: fullText } }] }).content
);
