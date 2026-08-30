import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    JOURNAL_AI_CSS_PROMPT,
    JOURNAL_APPEARANCE_PRESETS,
    JOURNAL_APPEARANCE_SAFETY_CSS,
    JOURNAL_CUSTOM_CSS_SELECTORS,
    JOURNAL_CSS_SCOPE_HINT,
    JOURNAL_CSS_SCOPE_REGEX,
    flattenJournalAppearance,
    resolveJournalAppearanceCss,
    resolveJournalPreset,
} from './journalAppearance';
import { validateScopedCss } from './scopedCss';

describe('journalAppearance', () => {
    it('ships several scoped presets and keeps the original preset unchanged', () => {
        expect(JOURNAL_APPEARANCE_PRESETS.map(preset => preset.id)).toEqual([
            'original',
            'letterpress',
            'sakura',
            'forest',
            'midnight',
        ]);
        expect(resolveJournalPreset('original').css).toBe('');

        for (const preset of JOURNAL_APPEARANCE_PRESETS) {
            const validation = validateScopedCss(
                preset.css,
                JOURNAL_CSS_SCOPE_REGEX,
                JOURNAL_CSS_SCOPE_HINT,
            );
            expect(validation.errors, preset.name).toEqual([]);
        }
    });

    it('gives every non-original preset its own layout language instead of a shared recolored shell', () => {
        const themed = JOURNAL_APPEARANCE_PRESETS.filter(preset => preset.id !== 'original');
        expect(new Set(themed.map(preset => preset.layout)).size).toBe(themed.length);

        for (const preset of themed) {
            expect(preset.css, preset.name).toContain(`.sully-journal-theme-${preset.id}`);
            expect(preset.css, preset.name).toContain('.sully-journal-notebook-grid');
            expect(preset.css, preset.name).toContain('.sully-journal-calendar-list');
            expect(preset.css, preset.name).toContain('.sully-journal-spread');
            expect(preset.css, preset.name).toContain('@media(max-width:719px)');
        }

        expect(resolveJournalPreset('letterpress').css).toContain('.sully-journal-post-route');
        expect(resolveJournalPreset('sakura').css).toContain('.sully-journal-celestial-map');
        expect(resolveJournalPreset('forest').css).toContain('.sully-journal-field-rings');
        expect(resolveJournalPreset('midnight').css).toContain('.sully-journal-memory-circuit');

        expect(resolveJournalPreset('letterpress').css).toContain('grid-template-columns:repeat(auto-fit,minmax(220px,1fr))');
        expect(resolveJournalPreset('sakura').css).toContain('.sully-journal-notebook:first-child{grid-column:1/-1');
        expect(resolveJournalPreset('forest').css).toContain('grid-template-columns:1fr!important');
        expect(resolveJournalPreset('midnight').css).toContain('grid-template-columns:repeat(3,minmax(0,1fr))');
    });

    it('places custom CSS after the selected preset so users can override it', () => {
        const customCss = '.sully-journal-paper{border-radius:2px!important;}';
        const css = resolveJournalAppearanceCss({ preset: 'sakura', customCss });

        expect(css).toContain('.sully-journal-theme-sakura');
        expect(css.endsWith(customCss)).toBe(true);
    });

    it('rejects CSS that would escape into another app', () => {
        const validation = validateScopedCss(
            '.sully-chat-root{display:none}',
            JOURNAL_CSS_SCOPE_REGEX,
            JOURNAL_CSS_SCOPE_HINT,
        );

        expect(validation.isValid).toBe(false);
    });

    it('flattens a preset and overrides into standalone CSS', () => {
        const override = '.sully-journal-paper{opacity:.9}';
        const standalone = flattenJournalAppearance({ preset: 'forest', customCss: override });

        expect(standalone.preset).toBe('original');
        expect(standalone.customCss).toContain('.sully-journal-calendar-hero');
        expect(standalone.customCss?.endsWith(override)).toBe(true);
        expect(resolveJournalAppearanceCss(standalone)).toBe(standalone.customCss);
    });

    it('puts every public JournalApp and theme-art selector into the copyable AI prompt', () => {
        const sources = [
            '../apps/JournalApp.tsx',
            '../components/journal/JournalThemeArtwork.tsx',
        ].map(relative => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')).join('\n');
        const sourceHooks = Array.from(sources.matchAll(/\bsully-journal-[a-z0-9-]+/gi))
            .map(match => `.${match[0]}`)
            .filter(selector => !selector.endsWith('-'));
        const requiredHooks = new Set([
            ...sourceHooks,
            '.sully-journal-appearance-button',
            '.sully-journal-paper-user',
            '.sully-journal-paper-char',
            '.sully-journal-theme-art-select',
            '.sully-journal-theme-art-calendar',
            '.sully-journal-theme-art-write',
        ]);

        expect([...requiredHooks].filter(selector => !JOURNAL_CUSTOM_CSS_SELECTORS.includes(selector as any))).toEqual([]);
        expect(JOURNAL_CUSTOM_CSS_SELECTORS.length).toBe(new Set(JOURNAL_CUSTOM_CSS_SELECTORS).size);
        for (const selector of JOURNAL_CUSTOM_CSS_SELECTORS) {
            expect(JOURNAL_AI_CSS_PROMPT, selector).toContain(selector);
        }
        expect(JOURNAL_AI_CSS_PROMPT).toContain('不得用 display:none');
    });

    it('ships a final safety layer that keeps every Journal escape control reachable', () => {
        for (const selector of [
            '.sully-journal-root',
            '.sully-journal-header',
            '.sully-journal-calendar-hero',
            '.sully-journal-editor-header',
            '.sully-journal-back',
            '.sully-journal-appearance-button',
        ]) {
            expect(JOURNAL_APPEARANCE_SAFETY_CSS).toContain(selector);
        }
        expect(JOURNAL_APPEARANCE_SAFETY_CSS).toContain('visibility:visible!important');
        expect(JOURNAL_APPEARANCE_SAFETY_CSS).toContain('pointer-events:auto!important');
        expect(JOURNAL_APPEARANCE_SAFETY_CSS).toContain('pointer-events:none!important');
        expect(JOURNAL_APPEARANCE_SAFETY_CSS).toContain('env(safe-area-inset-top,0px)');
    });

    it('wires a non-persistent, cross-page preview with a body-level one-click rescue', () => {
        const journalApp = readFileSync(fileURLToPath(new URL('../apps/JournalApp.tsx', import.meta.url)), 'utf8');
        const editor = readFileSync(fileURLToPath(new URL('../components/journal/JournalAppearanceEditor.tsx', import.meta.url)), 'utf8');

        expect(journalApp).toContain('previewJournalAppearance');
        expect(journalApp).toContain('effectiveJournalAppearance');
        expect(journalApp).toContain('onStartPreview');
        expect(editor).toContain('预览并浏览');
        expect(editor).toContain('正在预览日记本美化');
        expect(editor).toContain('一键撤销');
        expect(editor).toContain('document.body');
    });

    it('provides recovery paths for users whose already-saved CSS steals taps', () => {
        const editor = readFileSync(fileURLToPath(new URL('../components/journal/JournalAppearanceEditor.tsx', import.meta.url)), 'utf8');
        const settings = readFileSync(fileURLToPath(new URL('../apps/Settings.tsx', import.meta.url)), 'utf8');

        expect(editor).toContain('elementFromPoint');
        expect(editor).toContain('sully-journal-saved-style-rescue');
        expect(editor).toContain('日记美化急救：恢复原版');
        expect(settings).toContain('handleJournalAppearanceEmergencyReset');
        expect(settings).toContain('重置交换日记美化');
    });
});
