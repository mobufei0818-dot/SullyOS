import { describe, expect, it } from 'vitest';
import { createQixiChatMessagePair, createQixiEventChatCard, formatQixiEventCardForContext, tryParseQixiEventChatCard } from './qixiChatCard';

const card = createQixiEventChatCard({
    runId: 'run-1',
    charName: 'Sully',
    userName: '条条',
    timestamp: 1,
    openingChat: ['你刚才回我了吗？', '奇怪，我没看见。'],
    scenes: [{ id: 'doubleWish', title: '双面祈愿处', sharedObject: '双面愿笺', userActions: ['写下愿望'], userResults: ['把愿望留在正面'], charAction: '从背面写下自己的愿望', memoryLine: '一张纸同时朝向两个地方' }],
    bridgeNodes: [{ name: '草莓牛奶', artifactLabel: '草莓牛奶', memoryLine: '你说只剩最后一盒' }],
    reunionLines: ['终于找到你了。'],
    metaReflection: [],
    companionshipReflection: ['原来我们一直都认得出彼此。'],
    blessing: ['七夕快乐。'],
    promiseInvitation: ['那我们约好了。'],
    promiseComplete: '不许反悔。',
});

describe('qixi chat card', () => {
    it('keeps the structured full journey and parses it back', () => {
        expect(tryParseQixiEventChatCard(card)?.bridgeNodes[0].name).toBe('草莓牛奶');
        expect(card.summary).toContain('上下文夹层');
    });

    it('formats a second-person context that lets Char remember the whole event', () => {
        const context = formatQixiEventCardForContext(card, 'char');
        expect(context).toContain('你经历了一次奇怪的空间坍缩');
        expect(context).toContain('你和条条');
        expect(context).toContain('双面祈愿处');
        expect(context).toContain('原来我们一直都认得出彼此');
        expect(context).toContain('草莓牛奶');
        expect(context).toContain('唤来一只鹊');
        expect(context).toContain('共同触碰的约定');
        expect(context).not.toContain('记忆物件铺成鹊桥');
    });

    it('puts the activity card immediately before the private-chat line', () => {
        const [activityCard, privateLine] = createQixiChatMessagePair('char-1', card, '回来以后慢慢说。', 100);
        expect(activityCard.type).toBe('score_card');
        expect(privateLine.type).toBe('text');
        expect(activityCard.timestamp).toBe(100);
        expect(privateLine.timestamp).toBe(101);
        expect(activityCard.metadata.qixiRunId).toBe(privateLine.metadata.qixiRunId);
    });
});
