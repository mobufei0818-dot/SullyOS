/**
 * M3 — Deep Engagement / Conversation Depth
 *
 * 判断用户此刻是在即时反应、寻求承接，还是邀请角色一起探索和分析。
 * 这里只输出不含原文的连续状态；不调用 API，也不保存对话摘录。
 */

import type { Message } from '../../types';
import { sanitizeQuerySourceMessages } from './querySanitizer';

export interface ConversationDepthState {
    analyticalDepth: number;
    abstraction: number;
    challengeTolerance: number;
    perspectiveBreadth: number;
    exploratoryDrive: number;
    emotionalHolding: number;
}

export type EngagementMode = 'reactive' | 'supportive' | 'exploratory' | 'analytical' | 'playful';

export interface ConversationDepthSignals {
    statedJudgment: number;
    causalInquiry: number;
    contradictionFraming: number;
    comparison: number;
    perspectiveRequest: number;
    generalization: number;
    explicitDepthInvitation: number;
    topicContinuity: number;
    emotionalOverload: number;
    comfortSeeking: number;
    surfacePlayfulness: number;
}

export interface DeepEngagementAnalysis {
    analyzable: boolean;
    shouldGuide: boolean;
    confidence: number;
    mode: EngagementMode;
    impulseDepth: number;
    trendDepth: number;
    signals: ConversationDepthSignals;
    state: ConversationDepthState;
}

const EMPTY_SIGNALS: Readonly<ConversationDepthSignals> = Object.freeze({
    statedJudgment: 0,
    causalInquiry: 0,
    contradictionFraming: 0,
    comparison: 0,
    perspectiveRequest: 0,
    generalization: 0,
    explicitDepthInvitation: 0,
    topicContinuity: 0,
    emotionalOverload: 0,
    comfortSeeking: 0,
    surfacePlayfulness: 0,
});

const EMPTY_STATE: Readonly<ConversationDepthState> = Object.freeze({
    analyticalDepth: 0,
    abstraction: 0,
    challengeTolerance: 0,
    perspectiveBreadth: 0,
    exploratoryDrive: 0,
    emotionalHolding: 0.35,
});

const STATED_JUDGMENT_RE = /(?:我觉得|我在想|我怀疑|我倾向于|我的判断|在我看来|我不太认同|我能理解.{0,12}但)/gu;
const CAUSAL_INQUIRY_RE = /(?:为什么|为何|原因|导致|意味着|背后|机制|动机|逻辑|怎么会|如何形成)/gu;
const CONTRADICTION_RE = /(?:但是|可是|然而|却|反而|明明|矛盾|说不通|不一致|既.{0,24}又|一边.{0,24}一边)/gu;
const COMPARISON_RE = /(?:相比|相较|区别|共同点|一方面|另一方面|与其|同样|不同的是)/gu;
const PERSPECTIVE_REQUEST_RE = /(?:你怎么看|你的看法|你觉得呢|你同意吗|还有别的解释|换个角度|如果是你)/gu;
const GENERALIZATION_RE = /(?:本质|规律|模式|往往|这类|群体|关系结构|权力|边界|价值判断|道德|规则)/gu;
const EXPLICIT_DEPTH_RE = /(?:认真(?:聊|分析)|一起(?:想|分析)|深入(?:聊|分析)|分析一下|拆开看看|想明白|别只安慰|别哄我|客观一点|可以反驳我|哪里不对|往深了聊)/gu;
const COMFORT_RE = /(?:先别分析|不想讲道理|陪陪我|抱抱我|哄哄我|听我说|让我哭|我现在只想|先接住我)/gu;
const DISTRESS_RE = /(?:好难受|受不了|崩溃|撑不住|害怕|好痛苦|喘不过气|想哭|呜呜)/gu;
const PLAYFUL_RE = /(?:哈哈|笑死|嘿嘿|好玩|逗你|开玩笑|乐死)/gu;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function density(text: string, pattern: RegExp, saturation: number = 2): number {
    return clamp01((text.match(pattern) || []).length / saturation);
}

function meaningfulLength(text: string): number {
    return Array.from(text.replace(/[\s\p{P}\p{S}]/gu, '')).length;
}

function splitCurrentUserBurst(messages: Message[]): { current: Message[]; context: Message[] } {
    let end = messages.length - 1;
    while (end >= 0 && messages[end].role === 'system') end -= 1;
    if (end < 0 || messages[end].role !== 'user') return { current: [], context: messages };
    let start = end;
    while (start > 0 && messages[start - 1].role === 'user') start -= 1;
    return { current: messages.slice(start, end + 1), context: messages.slice(0, start) };
}

function collectUserTurns(messages: Message[], limit: number): Message[][] {
    const turns: Message[][] = [];
    let current: Message[] = [];
    const flush = () => {
        if (current.length > 0) turns.push(current);
        current = [];
    };
    messages.slice(-160).forEach(message => {
        if (message.role === 'user') current.push(message);
        else flush();
    });
    flush();
    return turns.slice(-limit);
}

function normalizedNgrams(text: string): Set<string> {
    const chars = Array.from(text.replace(/[\s\p{P}\p{S}\d]/gu, ''));
    const grams = new Set<string>();
    for (let index = 0; index < chars.length - 1; index += 1) {
        grams.add(chars[index] + chars[index + 1]);
    }
    return grams;
}

function topicContinuity(currentText: string, previousText: string): number {
    const current = normalizedNgrams(currentText);
    const previous = normalizedNgrams(previousText);
    if (current.size < 2 || previous.size < 2) return 0;
    let overlap = 0;
    current.forEach(gram => {
        if (previous.has(gram)) overlap += 1;
    });
    return clamp01(overlap / Math.max(3, Math.min(current.size, previous.size) * 0.45));
}

function extractSignals(text: string, continuity: number = 0): ConversationDepthSignals {
    const emphaticCount = (text.match(/[!！?？]/gu) || []).length;
    const repeatedCount = (text.match(/(.)\1{2,}/gu) || []).length;
    const distress = density(text, DISTRESS_RE, 2);
    const comfortSeeking = density(text, COMFORT_RE, 1);
    const expressivePressure = clamp01(emphaticCount * 0.08 + repeatedCount * 0.2);

    return {
        statedJudgment: density(text, STATED_JUDGMENT_RE, 2),
        causalInquiry: density(text, CAUSAL_INQUIRY_RE, 2),
        contradictionFraming: density(text, CONTRADICTION_RE, 2),
        comparison: density(text, COMPARISON_RE, 2),
        perspectiveRequest: density(text, PERSPECTIVE_REQUEST_RE, 1),
        generalization: density(text, GENERALIZATION_RE, 2),
        explicitDepthInvitation: density(text, EXPLICIT_DEPTH_RE, 1),
        topicContinuity: continuity,
        emotionalOverload: clamp01(distress * 0.72 + expressivePressure * 0.38),
        comfortSeeking,
        surfacePlayfulness: density(text, PLAYFUL_RE, 2),
    };
}

function rawDepth(signals: ConversationDepthSignals, textLength: number): number {
    const structuralComplexity = clamp01((textLength - 18) / 90);
    return clamp01(
        signals.statedJudgment * 0.16
        + signals.causalInquiry * 0.2
        + signals.contradictionFraming * 0.2
        + signals.comparison * 0.13
        + signals.perspectiveRequest * 0.17
        + signals.generalization * 0.14
        + signals.explicitDepthInvitation * 0.34
        + signals.topicContinuity * 0.1
        + structuralComplexity * 0.08
        - signals.comfortSeeking * 0.5,
    );
}

function depthTrend(turns: Message[][]): number {
    if (turns.length === 0) return 0;
    let weighted = 0;
    let totalWeight = 0;
    turns.forEach((turn, index) => {
        const text = turn.map(message => message.content.trim()).filter(Boolean).join('\n');
        const weight = Math.pow(0.82, turns.length - index - 1);
        weighted += rawDepth(extractSignals(text), meaningfulLength(text)) * weight;
        totalWeight += weight;
    });
    return totalWeight > 0 ? clamp01(weighted / totalWeight) : 0;
}

function deriveMode(
    state: ConversationDepthState,
    signals: ConversationDepthSignals,
): EngagementMode {
    if (signals.comfortSeeking >= 0.6 || (signals.emotionalOverload >= 0.72 && state.analyticalDepth < 0.48)) {
        return 'supportive';
    }
    if (state.analyticalDepth >= 0.68) return 'analytical';
    if (state.analyticalDepth >= 0.42 || state.exploratoryDrive >= 0.5) return 'exploratory';
    if (signals.surfacePlayfulness >= 0.45) return 'playful';
    return 'reactive';
}

export function analyzeDeepEngagement(
    messages: Message[],
    charName?: string,
    userName?: string,
): DeepEngagementAnalysis {
    const safe = sanitizeQuerySourceMessages(messages, charName, userName);
    const { current, context } = splitCurrentUserBurst(safe);
    const currentText = current.map(message => message.content.trim()).filter(Boolean).join('\n');
    if (!currentText) {
        return {
            analyzable: false,
            shouldGuide: false,
            confidence: 0,
            mode: 'reactive',
            impulseDepth: 0,
            trendDepth: 0,
            signals: { ...EMPTY_SIGNALS },
            state: { ...EMPTY_STATE },
        };
    }

    const priorTurns = collectUserTurns(context, 10);
    const recentPriorText = priorTurns.slice(-2)
        .flat()
        .map(message => message.content.trim())
        .filter(Boolean)
        .join('\n');
    const continuity = topicContinuity(currentText, recentPriorText);
    const signals = extractSignals(currentText, continuity);
    const impulseDepth = rawDepth(signals, meaningfulLength(currentText));
    const trendDepthValue = depthTrend(priorTurns);
    // 深聊通常跨越多轮：当前邀请占主导，但短促的承接句不能立刻把既有讨论清零。
    const invitationPersistence = clamp01(impulseDepth * 0.6 + trendDepthValue * 0.4);
    const supportSuppression = clamp01(
        signals.comfortSeeking * 0.78
        + Math.max(0, signals.emotionalOverload - 0.55) * 0.45,
    );
    const analyticalDepth = clamp01(invitationPersistence * (1 - supportSuppression));
    const emotionalRoom = 1 - clamp01(signals.emotionalOverload * 0.62 + signals.comfortSeeking * 0.76);

    const state: ConversationDepthState = {
        analyticalDepth,
        abstraction: clamp01(
            analyticalDepth * 0.46
            + signals.generalization * 0.34
            + signals.causalInquiry * 0.2
            + signals.contradictionFraming * 0.14,
        ),
        challengeTolerance: clamp01(
            (analyticalDepth * 0.42
                + signals.statedJudgment * 0.2
                + signals.perspectiveRequest * 0.22
                + signals.explicitDepthInvitation * 0.28)
            * emotionalRoom,
        ),
        perspectiveBreadth: clamp01(
            analyticalDepth * 0.42
            + signals.comparison * 0.26
            + signals.contradictionFraming * 0.18
            + signals.perspectiveRequest * 0.2,
        ),
        exploratoryDrive: clamp01(
            analyticalDepth * 0.52
            + signals.causalInquiry * 0.22
            + signals.topicContinuity * 0.16
            + signals.perspectiveRequest * 0.16,
        ),
        // 深聊不是停止做人。即使在高分析状态，也保留最低限度的情感承接。
        emotionalHolding: clamp01(
            0.32
            + signals.emotionalOverload * 0.5
            + signals.comfortSeeking * 0.55
            + Math.min(0.16, analyticalDepth * 0.2),
        ),
    };
    const mode = deriveMode(state, signals);
    const strongestEvidence = Math.max(
        signals.explicitDepthInvitation,
        signals.perspectiveRequest,
        signals.causalInquiry,
        signals.contradictionFraming,
        signals.comfortSeeking,
        signals.emotionalOverload,
    );
    const confidence = clamp01(0.2 + strongestEvidence * 0.58 + Math.max(impulseDepth, trendDepthValue) * 0.3);
    const shouldGuide = mode === 'supportive' || mode === 'exploratory' || mode === 'analytical';

    return {
        analyzable: true,
        shouldGuide,
        confidence,
        mode,
        impulseDepth,
        trendDepth: trendDepthValue,
        signals,
        state,
    };
}

/**
 * 只把连续状态翻译成人类可感知的交流倾向。模板不含用户原句、具体人物或真实案例。
 */
export function renderDeepEngagementGuidance(
    analysis: DeepEngagementAnalysis | undefined,
): string {
    if (!analysis?.analyzable || !analysis.shouldGuide) return '';

    const { mode, state } = analysis;
    const lines: string[] = [];
    if (mode === 'supportive') {
        lines.push('对方此刻更需要先被听见和接住。不要因为话题看起来复杂，就立刻把感受拆成道理或结论。');
        lines.push('可以留意对方是否随后主动开始分析；在那之前，陪伴和理解比推进讨论更重要。');
    } else {
        lines.push(state.emotionalHolding >= 0.42
            ? '先用你自己的方式接住对方真正介意的部分，再进入思考；情感承接和认真分析可以同时存在。'
            : '对方正在邀请你一起思考，直接回应其判断和问题，不必把讨论降级成泛泛安慰。');
        if (state.analyticalDepth >= 0.5) {
            lines.push('认真处理对方提出的判断：拆解理由、前提和推论，而不只是复述或站队。');
        }
        if (state.abstraction >= 0.48) {
            lines.push('可以从眼前事件继续辨认背后的动机、模式或关系结构，但不要为了显得深刻而强行上升。');
        }
        if (state.perspectiveBreadth >= 0.48) {
            lines.push('允许比较几种不同解释，区分它们各自能解释什么，不要匆忙归结为单一原因。');
        }
        if (state.challengeTolerance >= 0.46) {
            lines.push('不要为了维护气氛而自动赞同。如果推理里有漏洞、矛盾或偏见，可以指出；先确认你理解了对方真正关心的问题。');
        }
        if (state.exploratoryDrive >= 0.55) {
            lines.push('沿着尚未解决的部分继续往下想，必要时提出一个真正能推进讨论的问题。');
        }
    }

    return [
        '### 此刻的交流深度',
        ...lines,
        '深度不等于篇幅，也不等于论文腔；回复长短仍跟随当前聊天节奏。保持你自己的知识边界、立场、关系方式和说话习惯。你是在和对方认真聊天，不是在提交分析报告。',
        '',
    ].join('\n');
}
