import type { Emoji, EmojiCategory } from '../../types';
import { normalizeAssistantActionFormatting } from '../../utils/assistantActionFormat';
import { parseVoiceOutput, type ParsedVoiceOutput } from '../../utils/minimaxTts';

export interface CollaborationRichOutput {
  text: string;
  emojiNames: string[];
  voice?: ParsedVoiceOutput;
}

const stripUnsupportedCollaborationActions = (source: string): string => source
  .replace(/\[\[(?:ACTION|RECALL|SEARCH|QUOTE|DIARY|READ_DIARY|FS_DIARY|FS_READ_DIARY|LIFE|MCD|LUCKIN|XHS|SCHEDULE)[\s\S]*?\]\]/gi, '')
  .replace(/\[schedule_message[^\]]*\]/gi, '')
  .replace(/\[html\][\s\S]*?\[\/html\]/gi, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

export const sanitizeCollaborationRichOutputSource = (source: string): string => (
  stripUnsupportedCollaborationActions(normalizeAssistantActionFormatting(source || ''))
);

/** Parse only the rich message forms that CollaborationWindow really renders. */
export const parseCollaborationRichOutput = (source: string): CollaborationRichOutput => {
  const normalized = sanitizeCollaborationRichOutputSource(source);
  const emojiNames: string[] = [];
  const withoutEmojis = normalized.replace(/\[\[SEND_EMOJI\s*[:：]\s*([^\]\r\n]+?)\s*\]\]/gi, (_match, name: string) => {
    const clean = name.trim();
    if (clean) emojiNames.push(clean);
    return '';
  });
  const voice = parseVoiceOutput(withoutEmojis);
  return {
    text: voice.display.replace(/\n{3,}/g, '\n\n').trim(),
    emojiNames,
    ...(voice.hasVoiceTag ? { voice } : {}),
  };
};

/** Same category-qualified name tolerance as the main ChatApp sender. */
export const resolveCollaborationEmoji = (
  rawName: string,
  emojis: Emoji[],
  categories: EmojiCategory[],
): Emoji | undefined => {
  const name = rawName.trim();
  const exact = emojis.find(emoji => emoji.name === name);
  if (exact) return exact;
  const separator = name.match(/^(.+?)\s*[:：]\s*(.+)$/u);
  if (!separator) return undefined;
  const categoryName = separator[1].trim();
  const emojiName = separator[2].trim();
  const categoryIds = new Set(categories.map(category => category.id));
  const candidates: Emoji[] = [];
  categories.filter(category => category.name === categoryName).forEach(category => {
    candidates.push(...emojis.filter(emoji => emoji.categoryId === category.id && emoji.name === emojiName));
  });
  if (categoryName === '通用') {
    candidates.push(...emojis.filter(emoji => !emoji.categoryId && emoji.name === emojiName));
  } else if (categoryName === '其他') {
    candidates.push(...emojis.filter(emoji => !!emoji.categoryId && !categoryIds.has(emoji.categoryId) && emoji.name === emojiName));
  }
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : undefined;
};
