// @vitest-environment jsdom

// useBlobRefUrl 契约测试 —— 钉住委托 @rei-standard/blob-store/react 后的两条关键语义
// （SDK 侧说好的行为测试随首个消费者落地，就是这份）：
//   1. 令牌 → 令牌切换期间返回 undefined，绝不把上一个（已 revoke 的）objectURL 吐给渲染层；
//   2. 非令牌值在渲染期直接透传，不等 effect、无一帧滞后（含 value 变化的那一帧）。
// 外加第 3 条 SullyOS 特有分支：builtin-room-asset:// 令牌在首帧就解析成当前部署 URL。
//
// 环境说明：vitest 全局是 node 环境，本文件靠文件头指令单独跑 jsdom（React DOM 需要
// document）；vitest.config.ts 的 include 只收 utils/**/*.test.ts，所以不写 JSX、
// 用 React.createElement。fake-indexeddb 由 test-setup.ts 注入，putImageBlob 直接可用。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useBlobRefUrl, putImageBlob, dataUrlToBlob } from './blobRef';

// React 18 下 createRoot + act 必须显式声明 act 环境，否则 act 直接告警且不聚合更新。
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 没有 URL.createObjectURL / revokeObjectURL，自己 stub：每次造一个可区分的假 URL，
// 顺便让测试能断言「切换后旧 URL 被 revoke」。
let objectUrlSeq = 0;
const createObjectURL = vi.fn(() => `blob:mock-${++objectUrlSeq}`);
const revokeObjectURL = vi.fn();
(URL as any).createObjectURL = createObjectURL;
(URL as any).revokeObjectURL = revokeObjectURL;

const TINY_PNG_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** 探针组件工厂：把 hook 每一帧的返回值按渲染顺序记进 frames。 */
function makeProbe() {
    const frames: Array<string | undefined> = [];
    function Probe({ value }: { value: string | undefined | null }) {
        frames.push(useBlobRefUrl(value));
        return null;
    }
    return { frames, Probe };
}

/** 反复放行宏任务，直到 predicate 成立（等 fake-indexeddb 的异步读完成）。 */
async function flushUntil(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 50 && !predicate(); i++) {
        await act(async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 2));
        });
    }
    expect(predicate()).toBe(true);
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('useBlobRefUrl 契约（委托 SDK useBlobUrl 后的语义）', () => {
    it('令牌 → 令牌切换期间返回 undefined，不吐已 revoke 的旧 objectURL', async () => {
        const refA = await putImageBlob(dataUrlToBlob(TINY_PNG_A));
        const refB = await putImageBlob(dataUrlToBlob(TINY_PNG_B));
        const { frames, Probe } = makeProbe();

        // 首挂令牌 A：解析前 undefined，Blob 读出后拿到 objectURL_A。
        act(() => root.render(createElement(Probe, { value: refA })));
        expect(frames[frames.length - 1]).toBeUndefined();
        await flushUntil(() => frames[frames.length - 1] !== undefined);
        const urlA = frames[frames.length - 1]!;
        expect(urlA).toMatch(/^blob:mock-/);

        // 切到令牌 B：同步 act 里提交 + 跑完 effect，但 B 的 Blob 是异步读的、此刻还没解析完。
        // 契约：此时 hook 返回 undefined，而不是已被 revoke 的 objectURL_A。
        act(() => root.render(createElement(Probe, { value: refB })));
        expect(frames[frames.length - 1]).toBeUndefined();
        expect(frames[frames.length - 1]).not.toBe(urlA);
        // 旧 URL 在切换时就被 revoke（不泄漏，也正因如此绝不能再吐给渲染层）。
        expect(revokeObjectURL).toHaveBeenCalledWith(urlA);

        // B 解析完成后拿到新的 objectURL_B。
        await flushUntil(() => frames[frames.length - 1] !== undefined);
        const urlB = frames[frames.length - 1]!;
        expect(urlB).toMatch(/^blob:mock-/);
        expect(urlB).not.toBe(urlA);
    });

    it('非令牌值渲染期直接透传，无一帧滞后（含 undefined 与 value 变化帧）', async () => {
        const passthroughValues: Array<string | undefined> = [
            TINY_PNG_A,
            'https://example.com/a.png',
            'linear-gradient(180deg, #fff, #000)',
            undefined,
        ];
        for (const value of passthroughValues) {
            const { frames, Probe } = makeProbe();
            const localRoot = createRoot(document.createElement('div'));
            act(() => localRoot.render(createElement(Probe, { value })));
            // 首帧（第 0 项）就是原值，而不是先 undefined 再补一帧。
            expect(frames[0]).toBe(value);
            act(() => localRoot.unmount());
        }

        // 非令牌 → 非令牌切换：变化的那一帧就已经是新值，不吐上一个值的滞后帧。
        const { frames, Probe } = makeProbe();
        act(() => root.render(createElement(Probe, { value: TINY_PNG_A })));
        expect(frames[0]).toBe(TINY_PNG_A);
        const framesBeforeSwitch = frames.length;
        act(() => root.render(createElement(Probe, { value: 'https://example.com/a.png' })));
        expect(frames.length).toBeGreaterThan(framesBeforeSwitch);
        for (const frame of frames.slice(framesBeforeSwitch)) {
            expect(frame).toBe('https://example.com/a.png');
        }
    });

    it('builtin-room-asset:// 令牌首帧就解析成当前部署的内置资源 URL', () => {
        const { frames, Probe } = makeProbe();
        const portable = 'builtin-room-asset://forest-cottage/assets/chair.png';
        // 独立算一份期望值：BASE_URL 拼在页面 origin 下，再挂 room-templates 路径。
        const appBase = new URL((import.meta as any).env?.BASE_URL || '/', window.location.href);
        const expected = new URL('room-templates/forest-cottage/assets/chair.png', appBase).href;

        act(() => root.render(createElement(Probe, { value: portable })));
        expect(frames[0]).toBe(expected);
    });
});
