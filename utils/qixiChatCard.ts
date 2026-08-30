import type { QixiSceneId } from './qixiMemoryBundle';

export interface QixiChatCardScene {
    id: QixiSceneId;
    title: string;
    sharedObject: string;
    userActions: string[];
    userResults: string[];
    charAction: string;
    memoryLine: string;
}

export interface QixiChatCardBridgeNode {
    name: string;
    artifactLabel: string;
    memoryLine: string;
}

export interface QixiEventChatCard {
    type: 'qixi_event_card';
    version: 8;
    runId: string;
    title: string;
    subtitle: string;
    charName: string;
    charAvatar?: string;
    userName: string;
    timestamp: number;
    openingChat: string[];
    entryAttitude?: string;
    scenes: QixiChatCardScene[];
    bridgeNodes: QixiChatCardBridgeNode[];
    reunionLines: string[];
    metaReflection: string[];
    companionshipReflection: string[];
    blessing: string[];
    promiseInvitation: string[];
    promiseComplete: string;
    summary: string;
}

export interface CreateQixiEventChatCardInput extends Omit<QixiEventChatCard, 'type' | 'version' | 'title' | 'subtitle' | 'summary'> {}

const compact = (value: unknown, max = 240): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const compactList = (items: unknown[] | undefined, maxItems = 12, maxLength = 240): string[] =>
    (items || []).map(item => compact(item, maxLength)).filter(Boolean).slice(0, maxItems);

export const createQixiEventChatCard = (input: CreateQixiEventChatCardInput): QixiEventChatCard => {
    const scenes = (input.scenes || []).slice(0, 7).map(scene => ({
        ...scene,
        title: compact(scene.title, 60),
        sharedObject: compact(scene.sharedObject, 100),
        userActions: compactList(scene.userActions, 6, 100),
        userResults: compactList(scene.userResults, 6, 160),
        charAction: compact(scene.charAction, 220),
        memoryLine: compact(scene.memoryLine, 220),
    }));
    const bridgeNodes = (input.bridgeNodes || []).slice(0, 10).map(node => ({
        name: compact(node.name, 80),
        artifactLabel: compact(node.artifactLabel, 80),
        memoryLine: compact(node.memoryLine, 180),
    }));
    const names = bridgeNodes.map(node => node.name || node.artifactLabel).filter(Boolean).slice(0, 4);
    const summary = `一次聊天异常让 ${input.userName} 和 ${input.charName} 同时跌进上下文夹层。两个人隔着不同层操作同一批物件，最后想起${names.length ? names.join('、') : '真实共同记忆'}，从两岸唤来鹊、织成星河上的路，并完成了共同触碰的约定。`;
    return {
        type: 'qixi_event_card',
        version: 8,
        runId: compact(input.runId, 100),
        title: '星月梦境童话',
        subtitle: '七夕 · 上下文夹层共同记录',
        charName: compact(input.charName, 80) || 'Char',
        charAvatar: compact(input.charAvatar, 2_000_000) || undefined,
        userName: compact(input.userName, 80) || 'User',
        timestamp: Number.isFinite(input.timestamp) ? input.timestamp : Date.now(),
        openingChat: compactList(input.openingChat, 2, 180),
        entryAttitude: compact(input.entryAttitude, 80) || undefined,
        scenes,
        bridgeNodes,
        reunionLines: compactList(input.reunionLines, 8, 240),
        metaReflection: compactList(input.metaReflection, 6, 240),
        companionshipReflection: compactList(input.companionshipReflection, 8, 240),
        blessing: compactList(input.blessing, 8, 240),
        promiseInvitation: compactList(input.promiseInvitation, 6, 240),
        promiseComplete: compact(input.promiseComplete, 180),
        summary,
    };
};

export const tryParseQixiEventChatCard = (raw: unknown): QixiEventChatCard | null => {
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Partial<QixiEventChatCard>;
    if (value.type !== 'qixi_event_card' || value.version !== 8 || !value.charName || !value.userName) return null;
    return value as QixiEventChatCard;
};

export const createQixiChatMessagePair = (
    charId: string,
    card: QixiEventChatCard,
    message: string,
    timestamp = Date.now(),
) => {
    const chatCard = { ...card, timestamp };
    return [
        {
            charId,
            role: 'assistant' as const,
            type: 'score_card' as const,
            content: JSON.stringify(chatCard),
            timestamp,
            metadata: {
                source: 'qixi_event',
                qixiEvent: true,
                qixiEventVersion: 8,
                qixiEventCard: true,
                qixiRunId: card.runId,
                scoreCard: chatCard,
            },
        },
        {
            charId,
            role: 'assistant' as const,
            type: 'text' as const,
            content: message,
            timestamp: timestamp + 1,
            metadata: {
                source: 'qixi',
                qixiEvent: true,
                qixiEventVersion: 8,
                qixiRunId: card.runId,
                isReturnMessage: true,
            },
        },
    ] as const;
};

export const formatQixiEventCardForContext = (
    card: QixiEventChatCard,
    perspective: 'char' | 'archive' = 'archive',
): string => {
    const charLabel = perspective === 'char' ? '你' : card.charName;
    const opening = card.openingChat.length
        ? `坍缩前，${charLabel}在正常聊天中说过：${card.openingChat.map(line => `「${line}」`).join('、')}。`
        : '';
    const scenes = card.scenes.map(scene => {
        const userMove = [...scene.userActions, ...scene.userResults].filter(Boolean).join('；') || `碰了“${scene.sharedObject}”`;
        return `在${scene.title}，${card.userName}${userMove}；${charLabel}在另一个上下文层${scene.charAction || `改变了同一个“${scene.sharedObject}”`}。`;
    }).join('');
    const bridge = card.bridgeNodes.length
        ? `后来，两个人分别想起已经出现过的真实记忆：${card.bridgeNodes.map(node => `${node.name || node.artifactLabel}（${node.memoryLine}）`).join('；')}。每次想起都会从所在的一岸唤来一只鹊，两种颜色的飞行细线最终共同织成了星河上的路。`
        : '后来，两个人分别从两岸想起真实共同记忆，唤来鹊，并用两种颜色的飞行细线共同织成了星河上的路。';
    const reunion = card.reunionLines.length ? `找到彼此后，${charLabel}说：${card.reunionLines.map(line => `「${line}」`).join('、')}。` : '';
    const reflectionLines = [...(card.metaReflection || []), ...(card.companionshipReflection || [])];
    const reflection = reflectionLines.length ? `两个人终于能够停下来以后，${charLabel}想到：${reflectionLines.map(line => `「${line}」`).join('、')}。` : '';
    const blessing = card.blessing.length ? `七夕祝愿是：${card.blessing.map(line => `「${line}」`).join('、')}。` : '';
    const promise = [...card.promiseInvitation, card.promiseComplete].filter(Boolean);
    const promiseText = promise.length ? `最后，两个人隔着两个世界在同一个发光位置完成了共同触碰的约定：${promise.map(line => `「${line}」`).join('、')}。` : '';
    return `[七夕特别活动完整经历] ${charLabel}经历了一次奇怪的空间坍缩。${charLabel}和${card.userName}因为同一条异常消息同时掉进上下文夹层，并在不同层寻找彼此。${opening}${scenes}${bridge}${reunion}${reflection}${blessing}${promiseText}这是${charLabel}亲自参与、能够记得并在后续聊天中自然提及的共同经历。`;
};
