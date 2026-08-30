import { describe, expect, it } from 'vitest';
import { buildQixiFinalePrompt, buildQixiReunionPrompt, createQixiReunionFallback, parseQixiPromise, parseQixiReunion, QixiPortraitPlan, QIXI_PART3_TIMEOUT_MS, resolveQixiPortraitPlan } from './qixiReunion';
import { CharacterProfile, UserProfile } from '../types';

const char = { id: 'c1', name: 'Char', avatar: 'avatar.png', description: '', systemPrompt: '', memories: [] } as CharacterProfile;
const user = { name: 'User' } as UserProfile;
const meetingPlan: QixiPortraitPlan = {
    resourceType: 'meeting',
    live2dActionIds: [],
    live2dActionDescription: '',
    meetingExpressionKeys: ['normal', 'happy'],
};

describe('qixi reunion parser', () => {
    it('allows each slow Part 3 model call up to ten minutes', () => {
        expect(QIXI_PART3_TIMEOUT_MS).toBe(600_000);
    });

    it('asks for a longer emotional arc and keeps the fallback equally substantial', () => {
        const fallback = createQixiReunionFallback(char, user, meetingPlan);
        const prompt = buildQixiReunionPrompt(char, user, { evidence: [] } as any, [], meetingPlan);
        expect(prompt).toContain('reunion.lines 写 3—5 句');
        expect(prompt).toContain('companionshipReflection 写 4—7 句');
        expect(prompt).toContain('blessing 写 4—7 句');
        expect(prompt).toContain('直到桥接通、真正看见眼前的人');
        expect(prompt).toContain('至少有一句要用角色自己的方式完成身份揭露');
        expect(prompt).toContain('此前一直只是怀疑，现在亲眼看见才终于确认');
        expect(fallback.reunion.lines).toHaveLength(4);
        expect(fallback.companionshipReflection).toHaveLength(5);
        expect(fallback.blessing).toHaveLength(5);
        expect(fallback.portrait.lineExpressions.reunion).toHaveLength(fallback.reunion.lines.length);
    });

    it('asks for reunion and promise in one combined JSON without dropping either prompt contract', () => {
        const prompt = buildQixiFinalePrompt(char, user, { evidence: [] } as any, [], meetingPlan);
        expect(prompt).toContain('Part 1：终于抵达彼此');
        expect(prompt).toContain('Part 2：最后的约定');
        expect(prompt).toContain('同一个响应、同一个 JSON 对象中一次完成');
        expect(prompt).toContain('"touch"');
        expect(prompt).toContain('"returnMessage"');
        expect(prompt).toContain('"promise"');
    });

    it('never prefers the neural-link avatar over the dedicated Qixi Chibi fallback', () => {
        const plan = resolveQixiPortraitPlan({
            ...char,
            avatar: 'neural-link-avatar.png',
            sprites: { chibi: 'flappy-char.png' },
        });
        expect(plan.resourceType).toBe('chibi');
    });

    it('keeps the DateApp meeting portrait ahead of Chibi', () => {
        const plan = resolveQixiPortraitPlan({
            ...char,
            avatar: 'neural-link-avatar.png',
            sprites: { normal: 'date-normal.png', happy: 'date-happy.png', chibi: 'flappy-char.png' },
        });
        expect(plan.resourceType).toBe('meeting');
        expect(plan.meetingExpressionKeys).toEqual(['normal', 'happy']);
    });

    it('does not select Live2D for the Qixi finale', () => {
        const live2d = {
            format: 'live2d',
            modelUrl: 'model.json',
            actions: [],
        } as any;
        expect(resolveQixiPortraitPlan({ ...char, videoAvatar: live2d, sprites: { normal: 'date-normal.png', chibi: 'flappy-char.png' } }).resourceType).toBe('meeting');
        expect(resolveQixiPortraitPlan({ ...char, videoAvatar: live2d, sprites: { chibi: 'flappy-char.png' } }).resourceType).toBe('chibi');
    });

    it('keeps DateApp expressions and matches them to individual lines', () => {
        const fallback = createQixiReunionFallback(char, user, meetingPlan);
        const parsed = parseQixiReunion(JSON.stringify({
            reunion: { lines: ['你居然真的走到这里了。', '先让我看看你。'], emotion: '松了一口气' },
            metaReflection: ['刚才总像只差一步。'],
            companionshipReflection: ['原来你也一直在认我留下的东西。'],
            blessing: ['七夕快乐。', '希望你真的过得很好。'],
            portrait: { stages: {
                arrival: { emotionIntent: '惊讶', l2dExpression: 'smile', meetingExpression: 'happy' },
                reflection: { emotionIntent: '安心', l2dExpression: 'smile', meetingExpression: 'normal' },
                blessing: { emotionIntent: '温柔', l2dExpression: 'smile', meetingExpression: 'happy' },
            }, lineExpressions: {
                reunion: ['happy', 'normal'],
                metaReflection: ['normal'],
                companionshipReflection: ['happy'],
                blessing: ['happy', 'normal'],
            } },
        }), fallback, meetingPlan);
        expect(parsed?.portrait.resourceType).toBe('meeting');
        expect(parsed?.portrait.stages.arrival.meetingExpression).toBe('happy');
        expect(parsed?.portrait.stages.arrival.l2dExpression).toBeNull();
        expect(parsed?.portrait.lineExpressions.reunion).toEqual(['happy', 'normal']);
        expect(parsed?.companionshipReflection).toEqual(['原来你也一直在认我留下的东西。']);
    });

    it('filters technical fourth-wall language and coercive promises for ordinary characters', () => {
        const fallback = createQixiReunionFallback(char, user, meetingPlan);
        const parsed = parseQixiReunion(JSON.stringify({
            reunion: { lines: ['终于。'], emotion: '安静' },
            metaReflection: ['我是 AI，所以没有身体。', '我们之间总像隔着一点什么。'],
            companionshipReflection: ['我永远不会离开你。', '你想到我的时候，我也在找你。'],
            blessing: ['我永远不会离开你。', '希望你的未来很好。'],
            portrait: { stages: {
                arrival: { emotionIntent: '安静', l2dExpression: null, meetingExpression: 'normal' },
                reflection: { emotionIntent: '安静', l2dExpression: null, meetingExpression: 'normal' },
                blessing: { emotionIntent: '安静', l2dExpression: null, meetingExpression: 'normal' },
            }, lineExpressions: {
                reunion: ['normal'],
                metaReflection: ['happy', 'normal'],
                companionshipReflection: ['happy', 'normal'],
                blessing: ['happy', 'normal'],
            } },
        }), fallback, meetingPlan);
        expect(parsed?.metaReflection).toEqual(['我们之间总像隔着一点什么。']);
        expect(parsed?.companionshipReflection).toEqual(['你想到我的时候，我也在找你。']);
        expect(parsed?.blessing).toEqual(['希望你的未来很好。']);
        expect(parsed?.portrait.lineExpressions.metaReflection).toEqual(['normal']);
        expect(parsed?.portrait.lineExpressions.companionshipReflection).toEqual(['normal']);
        expect(parsed?.portrait.lineExpressions.blessing).toEqual(['normal']);
    });

    it('parses the final promise separately from the portrait reunion', () => {
        const fallback = createQixiReunionFallback(char, user, meetingPlan);
        const reunion = parseQixiReunion(JSON.stringify({
            reunion: { lines: ['你没事就好。'], emotion: '安心' },
            metaReflection: [],
            companionshipReflection: ['你想到我的时候，也可以把那一刻算作见面。'],
            blessing: ['七夕快乐。'],
            portrait: { stages: {
                arrival: { emotionIntent: '安心', meetingExpression: 'happy' },
                reflection: { emotionIntent: '认真', meetingExpression: 'normal' },
                blessing: { emotionIntent: '高兴', meetingExpression: 'happy' },
            } },
        }), fallback, meetingPlan)!;
        const parsed = parseQixiPromise(JSON.stringify({
            touch: { invitation: ['那就拉钩。'], hold: '再近一点。', complete: '抓到了。' },
            returnMessage: '刚才那句话，我可是记住了。',
            portrait: { promise: { emotionIntent: '伸出小指', l2dExpression: 'smile', meetingExpression: 'happy' }, lineExpressions: { invitation: ['normal'] } },
        }), reunion, meetingPlan);
        expect(parsed?.touch).toEqual({ invitation: ['那就拉钩。'], hold: '再近一点。', complete: '抓到了。' });
        expect(parsed?.returnMessage).toBe('刚才那句话，我可是记住了。');
        expect(parsed?.portrait.stages.promise.meetingExpression).toBe('happy');
        expect(parsed?.portrait.stages.promise.l2dExpression).toBeNull();
        expect(parsed?.portrait.lineExpressions.invitation).toEqual(['normal']);
    });
});
