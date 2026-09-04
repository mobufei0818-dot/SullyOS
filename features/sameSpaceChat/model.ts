// SAME_SPACE_CHAT: this file owns the complete state/prompt/marker contract for the removable feature.

export const SAME_SPACE_ACTION_OPEN = '[[SAME_SPACE_ACTION]]';
export const SAME_SPACE_ACTION_CLOSE = '[[/SAME_SPACE_ACTION]]';

export interface SameSpaceChatState {
    enabled: boolean;
    startedAt: number;
    timeMode: 'realtime' | 'paused';
    sceneTimeAnchor: number;
    anchoredAt: number;
}

export interface SameSpaceOutputSegment {
    kind: 'action' | 'text';
    content: string;
}

export const createSameSpaceChatState = (now = Date.now()): SameSpaceChatState => ({
    enabled: true,
    startedAt: now,
    timeMode: 'realtime',
    sceneTimeAnchor: now,
    anchoredAt: now,
});

export const getSameSpaceSceneTime = (state: SameSpaceChatState, now = Date.now()): number => (
    state.timeMode === 'paused'
        ? state.sceneTimeAnchor
        : state.sceneTimeAnchor + Math.max(0, now - state.anchoredAt)
);

export const pauseSameSpaceTime = (state: SameSpaceChatState, now = Date.now()): SameSpaceChatState => ({
    ...state,
    timeMode: 'paused',
    sceneTimeAnchor: getSameSpaceSceneTime(state, now),
    anchoredAt: now,
});

export const resumeSameSpaceTime = (state: SameSpaceChatState, now = Date.now()): SameSpaceChatState => ({
    ...state,
    timeMode: 'realtime',
    sceneTimeAnchor: getSameSpaceSceneTime(state, now),
    anchoredAt: now,
});

export const advanceSameSpaceTime = (state: SameSpaceChatState, minutes: number, now = Date.now()): SameSpaceChatState => ({
    ...state,
    sceneTimeAnchor: getSameSpaceSceneTime(state, now) + Math.max(0, minutes) * 60_000,
    anchoredAt: now,
});

export const formatSameSpaceSceneTime = (state: SameSpaceChatState, now = Date.now()): string => (
    new Date(getSameSpaceSceneTime(state, now)).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    })
);

export const isSameSpaceActionMessage = (message: { metadata?: any }): boolean => (
    message?.metadata?.sameSpaceAction === true
);

export const wrapSameSpaceActionForHistory = (content: string, actorName: string): string => (
    `[同处动作｜${actorName}] ${String(content || '').trim()}`
);

export function splitSameSpaceAssistantOutput(raw: string): SameSpaceOutputSegment[] {
    const source = String(raw || '');
    const pattern = /\[\[SAME_SPACE_ACTION\]\]([\s\S]*?)\[\[\/SAME_SPACE_ACTION\]\]/gi;
    const segments: SameSpaceOutputSegment[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
        const before = source.slice(cursor, match.index).trim();
        if (before) segments.push({ kind: 'text', content: before });
        const action = match[1].trim().replace(/^[（(]|[）)]$/g, '').trim();
        if (action) segments.push({ kind: 'action', content: action });
        cursor = match.index + match[0].length;
    }
    const after = source.slice(cursor).trim();
    if (after) segments.push({ kind: 'text', content: after });
    return segments.length ? segments : [{
        kind: 'text',
        content: source.replace(/\[\[\/?SAME_SPACE_ACTION\]\]/gi, '').trim(),
    }];
}

export function buildSameSpaceChatPrompt(
    state: SameSpaceChatState,
    characterName: string,
    userName: string,
    now = Date.now(),
): string {
    const sceneTime = formatSameSpaceSceneTime(state, now);
    return `\n\n【同处聊天（轻量线下）】
${characterName}与${userName}此刻在同一现实空间中。当前场景时间：${sceneTime}；时间状态：${state.timeMode === 'paused' ? '已暂停' : '随现实时间流动'}。
本块覆盖普通线上聊天里“不得写动作”的限制，但只对本轮普通私聊生效：
1. 自然地回复当前上下文；通常输出一段简短动作和一段完整台词，不要把一句话切成很多碎气泡。
2. 动作必须单独输出为 ${SAME_SPACE_ACTION_OPEN}动作${SAME_SPACE_ACTION_CLOSE}；标签外只写说出口的话。不要给普通括号加特殊含义。
3. 只能描写${characterName}自己的可观察动作、神态、距离变化，以及客观环境；绝不能替${userName}决定动作、感受、想法或反应。
4. 用户历史中的“[同处动作｜${userName}]”是${userName}刚做的动作，不是说出口的话。
5. 不得擅自把场景时间推进到当前场景时间之后；只有用户明确推进时间或叙述时间流逝时才可跟进。
6. 不调用额外接口，不进入完整见面模式；保持当前角色人设、关系和聊天上下文。`;
}
