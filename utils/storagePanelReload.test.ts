import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 「一键优化」把重复图片合并之后，整页刷新是必须发生的一步。
//
// 合并只改库里的引用，内存里的 theme / customIcons / appearancePresets 还捏着合并前的
// 令牌；导出备份取的是内存态（OSContext.tsx 的 cloneForInPlace），不刷新就会把同一张图
// 的新旧两个 Blob 都打进包 —— 也就是当初加这个自动刷新要防的那件事。
//
// 所以这次刷新不能挂在面板的生命周期上：SettingsSection 收起来是 {open && children}，
// 整个设置页也随 activeApp 切换卸载，2.5 秒里用户随手收一下，带 cleanup 的定时器就被清了；
// 再点一次「一键优化」也会重置状态，而第二轮幂等必然 merged = 0，永远不会再排。
//
// 组件测跑不起来（vitest 是 node 环境、没装 jsdom），这里按源码钉住结构。

const source = readFileSync(
    path.resolve(__dirname, '../components/settings/StorageUsagePanel.tsx'),
    'utf8',
);

/** 从 startIdx 后的第一个左括号开始，按括号配平截出整段调用文本 */
function extractCall(text: string, startIdx: number): string {
    const open = text.indexOf('(', startIdx);
    if (open < 0) return '';
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') {
            depth--;
            if (depth === 0) return text.slice(startIdx, i + 1);
        }
    }
    return text.slice(startIdx);
}

/** 文件里所有 useEffect(...) 的完整调用文本 */
function allEffects(): string[] {
    const out: string[] = [];
    for (let from = 0; ; ) {
        const at = source.indexOf('useEffect(', from);
        if (at < 0) return out;
        const call = extractCall(source, at);
        out.push(call);
        from = at + Math.max(call.length, 'useEffect('.length);
    }
}

/** handleOptimize 那个 useCallback 的完整文本 */
function handleOptimizeBody(): string {
    const at = source.indexOf('const handleOptimize = useCallback');
    if (at < 0) return '';
    return extractCall(source, source.indexOf('useCallback', at));
}

/** scheduleMergeReload 函数体 */
function schedulerBody(): string {
    const at = source.indexOf('function scheduleMergeReload');
    if (at < 0) return '';
    const end = source.indexOf('\n}', at);
    return end < 0 ? source.slice(at) : source.slice(at, end);
}

const COMPONENT_AT = source.indexOf('const StorageUsagePanel');

describe('合并去重后的自动刷新', () => {
    it('排刷新的定时器不挂在 useEffect 上，也没人给它 cleanup', () => {
        const effects = allEffects();
        expect(effects.length).toBeGreaterThan(0);
        for (const effect of effects) {
            expect(effect).not.toContain('window.location.reload');
        }
        // 有 clearTimeout 就说明又有定时器被组件的生命周期管着了
        expect(source).not.toContain('clearTimeout');
    });

    it('刷新在 handleOptimize 里排，看这轮有没有真的合并过', () => {
        const body = handleOptimizeBody();
        expect(body).toContain('mergedDuplicates > 0');
        expect(body).toContain('scheduleMergeReload()');
    });

    it('计时器活在组件外面，面板卸载带不走它', () => {
        const head = source.slice(0, COMPONENT_AT);
        expect(head).toMatch(/setTimeout\(\(\)\s*=>\s*window\.location\.reload\(\),\s*MERGE_RELOAD_DELAY_MS\)/);
        // 组件内部一个定时器都不该有：有就是又被 React 的生命周期接管了
        expect(source.slice(COMPONENT_AT)).not.toContain('setTimeout');
    });

    it('同一轮里排过一次就不再排', () => {
        const scheduler = schedulerBody();
        expect(scheduler).toMatch(/if\s*\(mergeReloadScheduled\)\s*return/);
        expect(scheduler).toContain('mergeReloadScheduled = true');
        // 标记在模块级，跟着组件走就白搭了
        expect(source.slice(0, COMPONENT_AT)).toContain('let mergeReloadScheduled = false');
    });

    it('全文只有这一处排刷新', () => {
        const scheduled = source.match(/setTimeout\([^;]*window\.location\.reload/g) || [];
        expect(scheduled).toHaveLength(1);
    });

    it('「立即刷新」按钮还在，点了立刻走', () => {
        expect(source).toContain('onClick={() => window.location.reload()}');
    });
});
