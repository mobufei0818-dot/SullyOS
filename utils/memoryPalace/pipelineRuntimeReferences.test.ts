import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('memory palace pipeline runtime references', () => {
    const source = readFileSync(path.resolve(__dirname, './pipeline.ts'), 'utf8');

    it('logs the resolved per-character hot-zone value without referencing the removed constant', () => {
        expect(source).not.toMatch(/\bHOT_ZONE_SIZE\b/);
        expect(source).toContain('热区: ${hotZoneSizeForLog}');
    });

    it('keeps the per-character waterline types beside CharacterProfile', () => {
        const typesSource = readFileSync(path.resolve(__dirname, '../../types.ts'), 'utf8');

        expect(typesSource).toContain("export type MemoryPalaceWaterlinePreset = 'online' | 'balanced' | 'offline' | 'custom';");
        expect(typesSource).toContain('export interface MemoryPalaceWaterlineConfig');
        expect(typesSource).toContain('memoryPalaceWaterline?: MemoryPalaceWaterlineConfig;');
    });

    it('does not call the light LLM from the pre-reply injection pipeline', () => {
        expect(source).not.toContain('runLightRecallRouter(');
        expect(source).not.toContain('getLightLLMConfig(');
        expect(source).toContain('analyzeLocalContext(');
        expect(source).toContain('analyzeDeepEngagement(');
    });
});
