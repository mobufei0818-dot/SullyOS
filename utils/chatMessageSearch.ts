import type { Message } from '../types';

export type SearchableChatMessage = Pick<Message, 'type' | 'content'>;

const EMOJI_DIRECTIVE_PATTERN = /(?:\[\[?\s*(?:表情|emoji)\s*[:：][^\]\r\n]*\]\]?|［\s*(?:表情|emoji)\s*[:：][^］\r\n]*］|【\s*(?:表情|emoji)\s*[:：][^】\r\n]*】)/giu;

export const normalizeChatSearchText = (value: string): string => (
    value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
);

/** Removes model-facing emoji commands so their English names do not crowd out real chat hits. */
export const stripEmojiDirectivesFromSearchText = (value: string): string => (
    value.replace(EMOJI_DIRECTIVE_PATTERN, ' ')
);

/** Emoji messages are visual assets/URLs rather than meaningful keyword-searchable copy. */
export const searchableChatMessageText = (message?: SearchableChatMessage | null): string => {
    if (!message || message.type === 'emoji') return '';
    return normalizeChatSearchText(stripEmojiDirectivesFromSearchText(message.content || ''));
};

export const chatMessageIncludesKeyword = (
    message: SearchableChatMessage | null | undefined,
    query: string,
): boolean => {
    const normalizedQuery = normalizeChatSearchText(query);
    if (!normalizedQuery) return true;
    const content = searchableChatMessageText(message);
    return !!content && content.includes(normalizedQuery);
};

export const chatMessageFuzzyMatchesKeyword = (
    message: SearchableChatMessage | null | undefined,
    query: string,
): boolean => {
    const normalizedQuery = normalizeChatSearchText(query);
    if (!normalizedQuery) return true;
    const content = searchableChatMessageText(message);
    if (!content) return false;
    if (content.includes(normalizedQuery)) return true;
    let index = 0;
    for (const character of normalizedQuery) {
        const found = content.indexOf(character, index);
        if (found < 0) return false;
        index = found + 1;
    }
    return true;
};
