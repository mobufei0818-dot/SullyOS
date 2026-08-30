import { beforeEach, describe, expect, it } from 'vitest';

import type { Message } from '../../types';
import {
    advanceConversationEngagement,
    analyzeConversationEngagement,
    clearConversationEngagementState,
    CONVERSATION_ENGAGEMENT_ENGINE_KEY,
    CONVERSATION_ENGAGEMENT_STORAGE_PREFIX,
    loadConversationEngagementState,
    renderConversationEngagementGuidance,
} from './conversationEngagement';
import { injectMemoryPalace } from './pipeline';

let nextId = 1;
const history: Message[] = [];
const push = (role: Message['role'], content: string): Message => {
    const item: Message = {
        id: nextId++,
        charId: 'char-engagement',
        role,
        type: 'text',
        content,
        timestamp: nextId * 1000,
    };
    history.push(item);
    return item;
};

describe('M3 v2 Conversation Engagement', () => {
    beforeEach(() => {
        nextId = 1;
        history.length = 0;
        localStorage.clear();
    });

    it('treats an understated personal load as an unfinished disclosure, not a closed comfort request', () => {
        push('user', '我很累，事情很多。');
        const result = advanceConversationEngagement('char-engagement', history);

        expect(result.analysis.conversationAct).toBe('open_disclosure');
        expect(result.analysis.engagementState).toBe('opening');
        expect(result.analysis.interactionMode).toBe('supportive');
        expect(result.analysis.responsePlan).toMatchObject({
            primary: 'acknowledge',
            secondary: 'invite',
        });
        expect(result.analysis.subject.active).toBe(true);
        expect(result.analysis.reasons).toContain('personal_load');

        const guidance = renderConversationEngagementGuidance(result.analysis);
        expect(guidance).toContain('### 谈话参与原则');
        expect(guidance).toContain('对方出现负面情绪，不代表当前谈话的目标是消除这种情绪');
        expect(guidance).toContain('情绪是谈话的一部分，不应覆盖谈话本身');
        expect(guidance).toContain('不要根据关键词、记忆或既有印象补全事件并提前站队');
        expect(guidance).not.toContain('User');
        expect(guidance).toContain('先听见，再了解，再形成看法');
        expect(guidance).toContain('### 当前谈话参与策略');
        expect(guidance).toContain('持续关注对方正在经历什么');
        expect(guidance).toContain('不要用“别想了”“回来就好”“一切都会过去”');
        expect(guidance).toContain('不必固定变成“发生什么了”“然后呢”');
        expect(guidance).toContain('你不只需要留意');
        expect(guidance).not.toContain('角色');
        expect(guidance).not.toContain('我很累');
    });

    it.each([
        '桌面上的三个窗口还都停在那里。',
        '这阵子像一直在逆着风走。',
        '刚才那段到现在还悬在半空。',
    ])('opens a meaningful unclosed statement without requiring topic keywords: %s', (content) => {
        push('user', content);
        const result = advanceConversationEngagement('char-engagement', history);

        expect(result.analysis.conversationAct).toBe('open_disclosure');
        expect(result.analysis.engagementState).toBe('opening');
        expect(result.analysis.interactionMode).toBe('exploratory');
        expect(result.analysis.reasons).toContain('open_ended_statement');
        expect(result.analysis.responsePlan).toMatchObject({
            primary: 'acknowledge',
            secondary: 'invite',
        });
        expect(renderConversationEngagementGuidance(result.analysis)).toContain('事情本身发生了什么');
    });

    it.each([
        '帮我把下面这段内容翻译成英文。',
        '这个函数返回什么？',
        '下午好呀。',
    ])('does not turn a direct request, question, or greeting into a disclosure: %s', (content) => {
        push('user', content);
        const result = advanceConversationEngagement('char-engagement', history);

        expect(result.analysis.engagementState).toBe('idle');
        expect(result.analysis.shouldGuide).toBe(false);
        expect(result.analysis.stance.confidence).toBe(0);
    });

    it('distinguishes a tired status update with an explicit closure from an opening', () => {
        push('user', '今天上班好累，准备睡觉啦。');
        const result = advanceConversationEngagement('char-engagement', history);

        expect(result.analysis.conversationAct).toBe('close');
        expect(result.analysis.engagementState).toBe('idle');
        expect(result.analysis.shouldGuide).toBe(false);
        expect(result.state.activeSubject).toBeUndefined();
        const guidance = renderConversationEngagementGuidance(result.analysis);
        expect(guidance).toContain('### 谈话参与原则');
        expect(guidance).not.toContain('### 当前谈话参与策略');
    });

    it('keeps the same subject through elaboration and a low-information continuation', () => {
        push('user', '我很累，事情很多。');
        const opened = advanceConversationEngagement('char-engagement', history);
        const subjectId = opened.state.activeSubject?.id;

        push('assistant', '我在听。');
        push('user', '主要是今天单位那个事情。');
        const engaged = advanceConversationEngagement('char-engagement', history, opened.state);
        expect(engaged.analysis.engagementState).toBe('engaged');
        expect(engaged.state.activeSubject?.id).toBe(subjectId);
        expect(engaged.analysis.responsePlan.primary).toBe('follow');

        push('assistant', '嗯。');
        push('user', '就是……');
        const continued = advanceConversationEngagement('char-engagement', history, engaged.state);
        expect(continued.analysis.engagementState).toBe('engaged');
        expect(continued.state.activeSubject?.id).toBe(subjectId);
        expect(continued.analysis.responsePlan.explicitQuestionBudget).toBe(0);
        expect(continued.analysis.reasons).toContain('repeated_low_information_turn');
    });

    it('reflects a new development against the active subject instead of restarting the conversation', () => {
        push('user', '之前那些事又有后续了。');
        const opened = advanceConversationEngagement('char-engagement', history);
        push('assistant', '继续。');
        push('user', '今天主任突然又叫了另一个人过去，明明之前说让我负责。');
        const updated = advanceConversationEngagement('char-engagement', history, opened.state);

        expect(updated.analysis.conversationAct).toBe('update');
        expect(updated.analysis.engagementState).toBe('engaged');
        expect(updated.analysis.responsePlan).toMatchObject({ primary: 'reflect', secondary: 'follow' });
        expect(updated.analysis.subject.unresolvedHookKinds).toContain('changed_arrangement');
        expect(updated.analysis.stance.confidence).toBeGreaterThan(opened.analysis.stance.confidence);
    });

    it('moves into resolving and forms only a progressive stance when the user asks for a view', () => {
        push('user', '之前主任说这件事让我负责，今天却突然换了另一个人。');
        const opened = advanceConversationEngagement('char-engagement', history);
        push('assistant', '这里确实出现了变化。');
        push('user', '所以你觉得他是不是根本没打算让我负责？');
        const resolving = advanceConversationEngagement('char-engagement', history, opened.state);

        expect(resolving.analysis.conversationAct).toBe('ask_stance');
        expect(resolving.analysis.engagementState).toBe('resolving');
        expect(['reflect', 'evaluate']).toContain(resolving.analysis.responsePlan.primary);
        expect(resolving.analysis.responsePlan.explicitQuestionBudget).toBe(0);
        expect(renderConversationEngagementGuidance(resolving.analysis)).toContain('先保留你正在形成的印象');
    });

    it('closes the old subject and opens a new one when the user shifts topics', () => {
        push('user', '单位那件事还有后续。');
        const work = advanceConversationEngagement('char-engagement', history);
        const workId = work.state.activeSubject?.id;
        push('assistant', '你说。');
        push('user', '算了不想这个了，给你看我刚画的东西！');
        const shifted = advanceConversationEngagement('char-engagement', history, work.state);

        expect(shifted.analysis.conversationAct).toBe('shift');
        expect(shifted.analysis.engagementState).toBe('opening');
        expect(shifted.analysis.responsePlan).toMatchObject({ primary: 'close', secondary: 'shift' });
        expect(shifted.state.activeSubject?.id).not.toBe(workId);
        expect(shifted.analysis.subject.changed).toBe(true);
    });

    it('enters a new topic directly when there is no old subject to close', () => {
        push('user', '给你看我刚画的东西！');
        const shifted = advanceConversationEngagement('char-engagement', history);

        expect(shifted.analysis.conversationAct).toBe('shift');
        expect(shifted.analysis.responsePlan).toMatchObject({ primary: 'shift' });
        expect(shifted.analysis.responsePlan.secondary).toBeUndefined();
    });

    it('does not revive a closed subject on the next ordinary greeting', () => {
        push('user', '单位那件事还有后续。');
        const opened = advanceConversationEngagement('char-engagement', history);
        push('assistant', '我听着。');
        push('user', '算了，先不说了。');
        const closed = advanceConversationEngagement('char-engagement', history, opened.state);
        expect(closed.analysis.engagementState).toBe('closing');

        push('assistant', '好。');
        push('user', '早上好。');
        const greeting = advanceConversationEngagement('char-engagement', history, closed.state);
        expect(greeting.analysis.engagementState).toBe('idle');
        expect(greeting.state.activeSubject).toBeUndefined();
        expect(greeting.analysis.shouldGuide).toBe(false);
    });

    it('persists per-character state locally and makes duplicate payload builds idempotent', () => {
        push('user', '今天公司来了个特别奇怪的人。');
        const first = analyzeConversationEngagement('char-engagement', history);
        const stored = loadConversationEngagementState('char-engagement');
        const duplicate = analyzeConversationEngagement('char-engagement', history);

        expect(first.engagementState).toBe('opening');
        expect(stored?.activeSubject).toBeDefined();
        expect(duplicate).toEqual(first);
        expect(loadConversationEngagementState('char-engagement')?.activeSubject?.knownFacts).toHaveLength(1);

        clearConversationEngagementState('char-engagement');
        expect(loadConversationEngagementState('char-engagement')).toBeUndefined();
    });

    it('does not carry a subject into a replaced chat history for the same character', () => {
        push('user', '之前那些事又有后续了。');
        const opened = advanceConversationEngagement('char-engagement', history);
        const replacementHistory: Message[] = [{
            id: 999,
            charId: 'char-engagement',
            role: 'user',
            type: 'text',
            content: '早上好。',
            timestamp: Date.now(),
        }];
        const replacement = advanceConversationEngagement(
            'char-engagement',
            replacementHistory,
            opened.state,
        );

        expect(replacement.analysis.engagementState).toBe('idle');
        expect(replacement.state.activeSubject).toBeUndefined();
        expect(replacement.analysis.shouldGuide).toBe(false);
    });

    it('keeps the legacy depth engine available as a runtime fallback', async () => {
        localStorage.setItem(CONVERSATION_ENGAGEMENT_ENGINE_KEY, 'legacy');
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { deepEngagement: true },
        }));
        const trace = await injectMemoryPalace(
            { id: 'char-engagement', memoryPalaceEnabled: false },
            [push('user', '请认真分析这个规则背后的逻辑。')],
            undefined,
            undefined,
            { entryPoint: 'chat_app' },
        );

        expect(trace.deepEngagement?.engine).toBe('legacy_depth');
        expect(trace.deepEngagement?.status).toBe('observed');
    });

    it('clears corrupt v2 state after a one-turn automatic legacy fallback', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { deepEngagement: true },
        }));
        localStorage.setItem(`${CONVERSATION_ENGAGEMENT_STORAGE_PREFIX}char-engagement`, JSON.stringify({
            version: 2,
            charId: 'char-engagement',
            engagementState: 'engaged',
            interactionMode: 'exploratory',
            activeSubject: { id: 'broken' },
        }));
        const trace = await injectMemoryPalace(
            { id: 'char-engagement', memoryPalaceEnabled: false },
            [push('user', '然后呢。')],
            undefined,
            undefined,
            { entryPoint: 'chat_app' },
        );

        expect(trace.deepEngagement?.engine).toBe('legacy_depth');
        expect(localStorage.getItem(`${CONVERSATION_ENGAGEMENT_STORAGE_PREFIX}char-engagement`)).toBeNull();
    });
});
