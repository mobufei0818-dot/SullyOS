import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string): string =>
    readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8').replace(/\r\n?/g, '\n');

const countOccurrences = (source: string, needle: string): number => source.split(needle).length - 1;

describe('Qixi entry confirmation and color selection wiring', () => {
    const componentSource = readSource('../components/events/qixi/QixiDemoEvent.tsx');
    const cssSource = readSource('../components/events/qixi/QixiDemoRound2.css');
    const part1Source = readSource('./qixiMemoryBundle.ts');
    const part2Source = readSource('./qixiBridge.ts');
    const part3Source = readSource('./qixiReunion.ts');

    it('shows the real number of model requests before starting a fresh run', () => {
        const configuredCount = Number(componentSource.match(/QIXI_MODEL_API_CALL_COUNT\s*=\s*(\d+)/)?.[1]);
        const effectiveRequestCount = countOccurrences(part1Source, 'stream: true') * 3
            + countOccurrences(part2Source, 'stream: true')
            + countOccurrences(part3Source, 'stream: true');

        expect(configuredCount).toBe(4);
        expect(configuredCount).toBe(effectiveRequestCount);
        expect(componentSource).toContain('次模型 API');
        expect(componentSource).toContain('本次旅程共会调用 {QIXI_MODEL_API_CALL_COUNT} 次模型 API');
        expect(componentSource).not.toContain('七夕场景、鹊桥与最终见面');
        expect(componentSource).not.toContain('适合较长内容生成');
    });

    it('does not start generation until the API confirmation is accepted', () => {
        const colorConfirmationButton = componentSource.match(/<button[^>]*data-qixi-action="confirm-layer-color"[\s\S]*?<\/button>/)?.[0] || '';

        expect(colorConfirmationButton).toContain('setApiConfirmationOpen(true)');
        expect(colorConfirmationButton).not.toContain('startFresh');
        expect(componentSource).toMatch(/const confirmApiAndStart[\s\S]*?setApiConfirmationOpen\(false\);[\s\S]*?void startFresh\(\)/);
        expect(componentSource).toContain('data-qixi-action="cancel-api-confirmation"');
        expect(componentSource).toContain('取消不会发起任何一次生成调用');
    });

    it('keeps the color page hierarchy and selected-color identity explicit', () => {
        expect(componentSource).toContain('className="q7-color-select-copy"');
        expect(componentSource).toContain('<h2><span>先为这一边</span><strong>留下颜色。</strong></h2>');
        expect(componentSource).toContain('className="q7-layer-color-current"');
        expect(cssSource).toContain('.q7-color-select-copy h2 span');
        expect(cssSource).toContain('.q7-color-select-copy h2 strong');
        expect(cssSource).toContain('.q7-api-confirm__count');
    });

    it('keeps the final mobile hold inside the activity instead of browser long-press UI', () => {
        expect(componentSource).toContain('event.preventDefault();');
        expect(componentSource).toContain('setPointerCapture?.(event.pointerId)');
        expect(componentSource).toContain('onPointerCancel={endTouch}');
        expect(componentSource).toContain('onLostPointerCapture={endTouch}');
        expect(componentSource).toContain('onContextMenu={event => event.preventDefault()}');
        expect(componentSource).toContain('onDragStart={event => event.preventDefault()}');
        expect(cssSource).toContain('-webkit-touch-callout:none');
        expect(cssSource).toContain('-webkit-tap-highlight-color:transparent');
        expect(cssSource).toContain('overscroll-behavior:none');
    });

    it('gives all seven rooms a distinct transition motif and keeps the original light magpie glyph', () => {
        expect(componentSource).toContain('q7-transition-emblem is-${currentSceneId}');
        ['lostLayer', 'doubleWish', 'threadNeedle', 'offerings', 'reflection', 'nightMarket', 'wordCloud'].forEach(sceneId => {
            expect(cssSource).toContain(`.q7-transition-emblem.is-${sceneId}`);
        });
        expect(componentSource).toContain('const QixiBird: React.FC');
        expect(componentSource).toMatch(/<span className={`q7-magpie[\s\S]*?<i \/>[\s\S]*?<b \/>/);
        expect(componentSource).not.toContain('className="q7-bird-body"');
        expect(cssSource).toContain('.q7-magpie>i');
        expect(cssSource).toContain('.q7-magpie>b');
    });

    it('keeps Char-colour performance bubbles readable on phones', () => {
        expect(cssSource).toContain('Char-colour writing is dialogue, not tiny decorative copy');
        expect(cssSource).toContain('.q7-char-visual-quips>p{font-size:14px');
        expect(cssSource).toContain('.q7-lost-core-instruction{left:-23%;right:-18%');
        expect(cssSource).toContain('.q7-lost-real-reply{left:-20%;right:-22%');
        expect(cssSource).toContain('.q7-beat-prompt.is-char .q7-char-stage-direction{font-size:16px!important');
    });

    it('shows the User purchase and Char independent self-purchase in the market', () => {
        expect(componentSource).toContain('<small>你挑中</small>');
        expect(componentSource).toContain('<small>另一边偷偷自购</small>');
        expect(componentSource).toContain("currentSceneId === 'offerings' || currentSceneId === 'nightMarket'");
        expect(componentSource).toContain("['offerings', 'nightMarket'].includes(currentSceneId)");
        expect(componentSource).toContain("nightMarket: '从摊位上挑一件你真的想买的商品'");
        expect(componentSource).toContain("currentSceneId === 'lostLayer' ? '另一层挤了进来' : '另一层传来'");
    });
});
