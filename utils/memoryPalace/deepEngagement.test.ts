import { beforeEach, describe, expect, it } from 'vitest';

import type { Message } from '../../types';
import { injectMemoryPalace } from './pipeline';
import { analyzeDeepEngagement, renderDeepEngagementGuidance } from './deepEngagement';

let nextId = 1;
const message = (role: Message['role'], content: string): Message => ({
    id: nextId++,
    charId: 'char-depth',
    role,
    type: 'text',
    content,
    timestamp: nextId * 1000,
});

describe('M3 Deep Engagement', () => {
    beforeEach(() => {
        nextId = 1;
        localStorage.clear();
    });

    it('recognizes an explicit invitation to examine a fictional contradiction', () => {
        const source = '我想认真分析一下：虚构小镇把广场全部改成预约制，明明说是提高效率，为什么居民反而更少交流？你怎么看？';
        const analysis = analyzeDeepEngagement([message('user', source)]);

        expect(['exploratory', 'analytical']).toContain(analysis.mode);
        expect(analysis.shouldGuide).toBe(true);
        expect(analysis.state.analyticalDepth).toBeGreaterThan(0.5);
        expect(analysis.state.perspectiveBreadth).toBeGreaterThan(0.45);

        const guidance = renderDeepEngagementGuidance(analysis);
        expect(guidance).toContain('### 此刻的交流深度');
        expect(guidance).toContain('不只是复述或站队');
        expect(guidance).toContain('不是在提交分析报告');
        expect(guidance).not.toContain(source);
        expect(guidance).not.toContain('虚构小镇');
    });

    it('does not confuse a long emotional message with an invitation to analyze', () => {
        const analysis = analyzeDeepEngagement([
            message('user', '我现在真的很难受，脑子也很乱，先别分析这些事情了，陪陪我，让我慢慢缓过来。'),
        ]);

        expect(analysis.mode).toBe('supportive');
        expect(analysis.state.analyticalDepth).toBeLessThan(0.25);
        expect(analysis.state.emotionalHolding).toBeGreaterThan(0.7);
        expect(analysis.state.challengeTolerance).toBeLessThan(0.2);
        expect(renderDeepEngagementGuidance(analysis)).toContain('先被听见和接住');
    });

    it('does not turn length alone into deep talk', () => {
        const analysis = analyzeDeepEngagement([
            message('user', '今天早上先整理了书架，下午又去买了日用品，回来以后做饭、洗衣服、收拾桌面，然后看了一会儿窗外，最后准备早点休息。'),
        ]);

        expect(analysis.mode).toBe('reactive');
        expect(analysis.shouldGuide).toBe(false);
        expect(renderDeepEngagementGuidance(analysis)).toBe('');
    });

    it('keeps a multi-turn deep discussion alive through a short continuation', () => {
        const messages: Message[] = [];
        for (let turn = 0; turn < 5; turn += 1) {
            messages.push(message('user', `我想继续分析虚构社区的规则：一方面强调开放，另一方面又不断增加限制，这种矛盾背后的逻辑是什么？`));
            messages.push(message('assistant', '我也在想。'));
        }
        messages.push(message('user', '对，这里的逻辑我还没想明白。'));

        const analysis = analyzeDeepEngagement(messages);

        expect(analysis.trendDepth).toBeGreaterThan(0.5);
        expect(['exploratory', 'analytical']).toContain(analysis.mode);
        expect(analysis.state.exploratoryDrive).toBeGreaterThan(0.4);
    });

    it('allows challenge only when analysis is invited and emotional room remains', () => {
        const openDebate = analyzeDeepEngagement([
            message('user', '我有一个判断但不确定，你可以反驳我：虚构协会一边要求统一，一边鼓励创新，这套逻辑是不是矛盾？'),
        ]);
        const overwhelmed = analyzeDeepEngagement([
            message('user', '我真的撑不住了！！！先别分析，也不要反驳我，现在只想有人陪着。'),
        ]);

        expect(openDebate.state.challengeTolerance).toBeGreaterThan(0.35);
        expect(overwhelmed.state.challengeTolerance).toBeLessThan(0.1);
    });

    it('stores only numeric evidence and never copies the source sentence into Trace', async () => {
        const privateSource = '这是仅用于测试隐私边界的虚构密语，不得进入追踪记录；请和我一起分析它的逻辑。';
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { deepEngagement: true },
        }));

        const trace = await injectMemoryPalace(
            { id: 'char-depth', name: '测试角色', memoryPalaceEnabled: false },
            [message('user', privateSource)],
            undefined,
            '测试用户',
            { entryPoint: 'chat_app' },
        );

        expect(trace.deepEngagement?.status).toBe('observed');
        expect(trace.deepEngagement?.engine).toBe('conversation_v2');
        expect(trace.stages.some(stage => stage.name === 'deep_engagement')).toBe(true);
        expect(JSON.stringify(trace)).not.toContain(privateSource);
        expect(JSON.stringify(trace)).not.toContain('虚构密语');
    });

    it('keeps M3 out of non-ChatApp entry points', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { deepEngagement: true },
        }));
        const trace = await injectMemoryPalace(
            { id: 'char-depth', memoryPalaceEnabled: false },
            [message('user', '请认真分析这个虚构问题背后的逻辑。')],
            undefined,
            undefined,
            { entryPoint: 'world_home' },
        );

        expect(trace.deepEngagement?.status).toBe('out_of_scope');
        expect(trace.stages.some(stage => stage.name === 'deep_engagement')).toBe(false);
    });
});
