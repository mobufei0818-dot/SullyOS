import type { OSTheme } from '../types';

const COMPANION_CHAT_STYLE_RESIDUE = {
    chatAvatarShape: 'rounded',
    chatAvatarSize: 'medium',
    chatBubbleStyle: 'modern',
    chatMessageSpacing: 'spacious',
    chatHeaderStyle: 'gradient',
    chatInputStyle: 'rounded',
    chatChromeStyle: 'soft',
    chatBackgroundStyle: 'mesh',
    chatShowTimestamp: 'always',
} as const satisfies Partial<OSTheme>;

const COMPANION_CHAT_SIGNATURE_KEYS = [
    'chatBubbleStyle',
    'chatMessageSpacing',
    'chatHeaderStyle',
    'chatInputStyle',
    'chatChromeStyle',
    'chatBackgroundStyle',
] as const;

/**
 * The first companion desktop preset accidentally persisted its preview styling
 * into the global chat appearance. Remove only the still-matching preset values;
 * fields the user changed afterwards remain untouched.
 */
export const stripCompanionChatStyleResidue = (
    theme: OSTheme,
): { theme: OSTheme; repaired: boolean } => {
    if (theme.skin !== 'companion' && theme.skin !== 'default') {
        return { theme, repaired: false };
    }

    const matchesCompanionSignature = COMPANION_CHAT_SIGNATURE_KEYS.every(
        key => theme[key] === COMPANION_CHAT_STYLE_RESIDUE[key],
    );
    if (!matchesCompanionSignature) return { theme, repaired: false };

    const repairedTheme: any = { ...theme };
    for (const [key, value] of Object.entries(COMPANION_CHAT_STYLE_RESIDUE)) {
        if (repairedTheme[key] === value) delete repairedTheme[key];
    }
    return { theme: repairedTheme as OSTheme, repaired: true };
};
