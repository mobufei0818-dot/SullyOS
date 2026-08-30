import { extractAvatarPerformanceTimeline, type AvatarPerformanceCue, type AvatarPerformanceDirection } from './avatarPerformance';

export interface ParsedCallReply {
  text: string;
  thinkingChain?: string;
  /** 第一条演出指令（立即生效）。 */
  performance?: AvatarPerformanceDirection;
  /** 完整演出时间轴：正文中穿插的所有指令，按位置比例调度。 */
  performanceCues?: AvatarPerformanceCue[];
}

export const stripCallTextFormatting = (raw: string): string => (raw || '')
  .replace(/```(?:[a-z0-9_-]+)?\s*/gi, '')
  .replace(/```/g, '')
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]+)\]\((?:https?:\/\/|\/)[^)]*\)/g, '$1')
  .replace(/^(?:\s{0,3}#{1,6}\s+|\s{0,3}>\s?|\s*[-+*]\s+)/gm, '')
  .replace(/(\*\*|__)([\s\S]*?)\1/g, '$2')
  .replace(/([*_~`])([^\n]*?)\1/g, '$2')
  .replace(/[\t ]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const readContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (typeof block === 'string') return block;
    if (!block || typeof block !== 'object') return '';
    const item = block as Record<string, unknown>;
    return typeof item.text === 'string' ? item.text : typeof item.content === 'string' ? item.content : '';
  }).join('');
};

export const parseCallAssistantMessage = (message: any, keepThinking = false): ParsedCallReply => {
  const nativeReasoning = readContent(
    message?.reasoning_content ?? message?.reasoning ?? message?.thinking ?? '',
  ).trim();
  const directContent = readContent(message?.content).trim();
  // 少数中转把完整最终回复错误地塞进 reasoning_content。content 为空时仍要让电话有台词，
  // 但不能把同一段既当思维链又当台词重复展示。
  const raw = directContent || nativeReasoning;
  const nativeChain = directContent ? nativeReasoning : '';
  const inlineChains: string[] = [];
  const closedThinkRe = /<(think|thinking|thought)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let cleaned = raw.replace(closedThinkRe, (_whole: string, _tag: string, body: string) => {
    if (body.trim()) inlineChains.push(body.trim());
    return '';
  });
  cleaned = cleaned.replace(/<(?:think|thinking|thought)\b[^>]*>([\s\S]*)$/i, (_whole: string, body: string) => {
    if (body.trim()) inlineChains.push(body.trim());
    return '';
  });
  cleaned = cleaned.replace(/<\/?(?:think|thinking|thought)\b[^>]*>/gi, '');

  const { text, cues } = extractAvatarPerformanceTimeline(cleaned);
  const uniqueChains = [...new Set([nativeChain, ...inlineChains].map(item => item.trim()).filter(Boolean))];
  return {
    text,
    ...(keepThinking && uniqueChains.length ? { thinkingChain: uniqueChains.join('\n\n') } : {}),
    ...(cues.length ? { performance: cues[0].direction, performanceCues: cues } : {}),
  };
};
