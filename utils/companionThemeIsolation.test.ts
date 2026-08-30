import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { OSTheme } from '../types';
import { stripCompanionChatStyleResidue } from './companionThemeIsolation';

const leakedCompanionTheme = (skin: OSTheme['skin']): OSTheme => ({
    wallpaper: 'companion-wallpaper',
    darkMode: false,
    hue: 267,
    saturation: 46,
    lightness: 64,
    contentColor: '#f6efff',
    skin,
    chatAvatarShape: 'rounded',
    chatAvatarSize: 'medium',
    chatBubbleStyle: 'modern',
    chatMessageSpacing: 'spacious',
    chatHeaderStyle: 'gradient',
    chatInputStyle: 'rounded',
    chatChromeStyle: 'soft',
    chatBackgroundStyle: 'mesh',
    chatShowTimestamp: 'always',
});

describe('companion desktop theme isolation', () => {
    it.each(['companion', 'default'] as const)(
        'removes the leaked global chat preset while skin=%s',
        skin => {
            const result = stripCompanionChatStyleResidue(leakedCompanionTheme(skin));

            expect(result.repaired).toBe(true);
            expect(result.theme.wallpaper).toBe('companion-wallpaper');
            expect(result.theme.contentColor).toBe('#f6efff');
            expect(result.theme.chatBackgroundStyle).toBeUndefined();
            expect(result.theme.chatHeaderStyle).toBeUndefined();
            expect(result.theme.chatChromeStyle).toBeUndefined();
        },
    );

    it('preserves fields the user changed after the leak', () => {
        const theme = { ...leakedCompanionTheme('companion'), chatAvatarSize: 'large' as const };
        const result = stripCompanionChatStyleResidue(theme);

        expect(result.repaired).toBe(true);
        expect(result.theme.chatAvatarSize).toBe('large');
        expect(result.theme.chatBackgroundStyle).toBeUndefined();
    });

    it('does not erase an independently selected mesh background', () => {
        const theme = {
            ...leakedCompanionTheme('default'),
            chatHeaderStyle: 'minimal' as const,
        };
        const result = stripCompanionChatStyleResidue(theme);

        expect(result.repaired).toBe(false);
        expect(result.theme).toEqual(theme);
    });

    it('keeps the companion desktop preset free of global chat appearance fields', () => {
        const source = readFileSync(path.resolve(__dirname, '../apps/Appearance.tsx'), 'utf8');
        const companionBlock = source.slice(source.indexOf("id: 'companion'"), source.indexOf("id: 'default'"));

        expect(companionBlock).toContain('wallpaper: COMPANION_WALLPAPER');
        expect(companionBlock).not.toMatch(/chat[A-Z]/);
    });
});
