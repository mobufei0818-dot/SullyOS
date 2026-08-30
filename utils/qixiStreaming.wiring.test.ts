import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string): string =>
    readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8').replace(/\r\n?/g, '\n');

const countOccurrences = (source: string, needle: string): number => source.split(needle).length - 1;

describe('Qixi streaming request wiring', () => {
    const part1Source = readSource('./qixiMemoryBundle.ts');
    const part2Source = readSource('./qixiBridge.ts');
    const part3Source = readSource('./qixiReunion.ts');
    const componentSource = readSource('../components/events/qixi/QixiDemoEvent.tsx');

    it('streams all four Qixi model requests and folds the bridge into Part 1b', () => {
        expect(part1Source).not.toContain('stream: false');
        expect(part2Source).not.toContain('stream: false');
        expect(part3Source).not.toContain('stream: false');

        // Part 1a/1b/1c share the same request body, so one stream flag covers all three calls.
        expect(countOccurrences(part1Source, 'stream: true')).toBe(1);
        expect(part1Source).toContain("phase === 'second' ? 'b' : 'c-bridge'");
        expect(part1Source).toContain('normalizeQixiPhaseChunk(');
        expect(part1Source).toContain('parseQixiJsonObject(thirdResponse.content)');
        expect(part1Source).toContain('Incremental SSE reader stops on [DONE]');

        expect(countOccurrences(part2Source, 'stream: true')).toBe(0);
        expect(part2Source).not.toContain('/chat/completions');
        expect(part2Source).not.toContain('safeFetchJson');
        expect(part2Source).toContain('if (memoryBundle.bridge)');

        expect(countOccurrences(part3Source, 'stream: true')).toBe(1);
        expect(countOccurrences(part3Source, 'Do not wait for a Claude proxy to close the socket after [DONE]')).toBe(1);
        expect(part3Source).toContain("purpose: 'qixi-reunion-and-promise-v5'");
        expect(part3Source).toContain('buildQixiFinalePrompt');

        const effectiveRequestCount = countOccurrences(part1Source, 'stream: true') * 3
            + countOccurrences(part2Source, 'stream: true')
            + countOccurrences(part3Source, 'stream: true');
        expect(effectiveRequestCount).toBe(4);
    });

    it('keeps chat completions on the zero automatic retry path', () => {
        const safeApiSource = readSource('./safeApi.ts');

        expect(safeApiSource).toContain("return url.includes('/chat/completions')");
        expect(safeApiSource).toMatch(/automaticRetryLimit\s*=\s*isChatCompletionUrl\([^)]*\)\s*\?\s*0/);
    });

    it('delivers each serial content phase before starting the next request', () => {
        const firstDelivery = part1Source.indexOf("options.onPhaseReady?.('first', firstBundle)");
        const secondRequest = part1Source.indexOf('const secondResponse = await requestPhase');
        const secondDelivery = part1Source.indexOf("options.onPhaseReady?.('second', secondBundle)");
        const thirdRequest = part1Source.indexOf('const thirdResponse = await requestPhase');
        const thirdDelivery = part1Source.indexOf("options.onPhaseReady?.('third', bundle)");

        expect(firstDelivery).toBeGreaterThan(0);
        expect(firstDelivery).toBeLessThan(secondRequest);
        expect(secondDelivery).toBeGreaterThan(secondRequest);
        expect(secondDelivery).toBeLessThan(thirdRequest);
        expect(thirdDelivery).toBeGreaterThan(thirdRequest);

        expect(componentSource).toMatch(/if \(phase === 'first'\)[\s\S]*?setLoadingReady\(true\)/);
        expect(componentSource).toContain('materialPhaseReady >= requiredMaterialPhase');
        expect(componentSource).toContain('disabled={!currentSceneMaterialReady}');
        expect(componentSource).toContain('currentSceneMaterialReady ? qixiTransitionLines(currentSceneId, scenePayload) : []');
    });
});
