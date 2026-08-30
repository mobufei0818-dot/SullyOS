import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { APIConfig, CharacterProfile, SpriteConfig, UserProfile } from '../../../types';
import { useBlobRefUrl } from '../../../utils/blobRef';
import './QixiDemoEvent.css';
import './QixiDemoRound2.css';
import { QixiBGMToggle, useQixiBGM } from './QixiBGM';
import {
    createQixiFallbackBundle,
    loadQixiMemoryBundle,
    prepareQixiMemoryBundle,
    QixiMemoryArtifact,
    QixiMemoryBundle,
    QixiSceneId,
    QixiSceneOption,
    QIXI_SCENE_IDS,
    QIXI_DEFAULT_USER_LAYER_COLOR,
    QIXI_FALLBACK_CHAR_LAYER_COLOR,
    QIXI_USER_LAYER_COLORS,
    qixiCharMutter,
    qixiCharQuips,
    qixiCharVisibleText,
    qixiTransitionLines,
} from '../../../utils/qixiMemoryBundle';
import {
    normalizeQixiBridgeBundle,
    prepareQixiBridge,
    QixiBridgeBundle,
} from '../../../utils/qixiBridge';
import {
    createQixiReunionFallback,
    prepareQixiReunion,
    QixiJourneyBeat,
    QixiPortraitStage,
    QixiReunionBundle,
    resolveQixiPortraitPlan,
} from '../../../utils/qixiReunion';
import {
    createQixiEventChatCard,
    QixiEventChatCard,
} from '../../../utils/qixiChatCard';
import {
    enterQixiInterlayerState,
    qixiWordPickTarget,
    QixiEntryAttitude,
    resolveQixiWordArtifacts,
    resolveQixiWordSelectionIds,
    selectQixiWordTurn,
} from '../../../utils/qixiSessionState';

export const QIXI_DEMO_RECORD_KEY = 'qixi_2026_dual_layer_v7';

type Stage = 'cover' | 'colorSelect' | 'loading' | 'fakeChat' | 'distort' | 'entry' | 'sceneTransition' | 'scene' | 'bridgeLoading' | 'bridge' | 'bridgeCrossing' | 'reunionLoading' | 'reunion' | 'touch' | 'ending';
type MaterialPhaseReady = 0 | 1 | 2 | 3;
type EntryAttitude = QixiEntryAttitude;
type SceneBeat = 'idle' | 'user' | 'char' | 'complete';
type GenerationPart = 'part1' | 'part2' | 'part3';
type GenerationState = 'idle' | 'generating' | 'ready' | 'error';

export interface QixiGameV8 {
    version: 8;
    stage: Stage;
    attitude?: EntryAttitude;
    sceneIndex: number;
    sceneBeat: SceneBeat;
    wordCloudCharRevealed: number;
    decisions: Partial<Record<QixiSceneId, string[]>>;
    results: Partial<Record<QixiSceneId, string[]>>;
    completedScenes: QixiSceneId[];
    bridge?: QixiBridgeBundle;
    bridgePlaced: string[];
    bridgeFinalState?: 'idle' | 'flying' | 'connected';
    reunion?: QixiReunionBundle;
    reunionPage: number;
    reunionLineIndex: number;
    userLayerColor?: string;
}

export type QixiSessionMode = 'fresh' | 'replay';

export interface QixiReplaySnapshot {
    version: 8;
    bundle: QixiMemoryBundle;
    game: QixiGameV8;
}

export interface QixiReturnPayload {
    message: string;
    card: QixiEventChatCard;
    replaySnapshot: QixiReplaySnapshot;
}

interface TouchState {
    x: number;
    y: number;
    active: boolean;
    approaching: boolean;
    joined: boolean;
    releasedEarly: boolean;
    releasedAfterJoin: boolean;
}

interface QixiDemoSessionProps {
    char: CharacterProfile;
    user: UserProfile;
    apiConfig: APIConfig;
    onClose: () => void;
    sessionMode?: QixiSessionMode;
    replaySnapshot?: QixiReplaySnapshot | null;
    onReturnToChat?: (payload: QixiReturnPayload) => Promise<void> | void;
    onPortraitConfigSave?: (config: SpriteConfig) => void;
}

interface SceneMeta {
    title: string;
    ritual: string;
    intention: string;
    userColor: string;
    charColor: string;
}

const STORAGE_PREFIX = 'sullyos_qixi_dual_layer_v8_';
const CONTACT_DURATION_MS = 1250;
const WORD_PICK_COUNT = 3;
export const QIXI_MODEL_API_CALL_COUNT = 4;

const SCENES: Record<QixiSceneId, SceneMeta> = {
    lostLayer: { title: '失联层', ritual: '等待响应', intention: '遥寄 · 双星失联', userColor: '#f2c4d8', charColor: '#a8d9ff' },
    doubleWish: { title: '双面祈愿处', ritual: '翻面见字', intention: '拜七姐 · 写愿', userColor: '#f6c6d8', charColor: '#b8d8ff' },
    threadNeedle: { title: '穿针乞巧处', ritual: '共同穿线', intention: '穿针 · 乞巧', userColor: '#f1b3ca', charColor: '#9fd7ff' },
    offerings: { title: '供果与记忆陈列', ritual: '交换供物', intention: '供果 · 供桌', userColor: '#f2c7a6', charColor: '#b7d5ff' },
    reflection: { title: '投针照影', ritual: '双层水纹', intention: '投针 · 照影', userColor: '#efb8d4', charColor: '#91dcff' },
    nightMarket: { title: '乞巧市', ritual: '记忆夜市', intention: '七夕夜市 · 小事', userColor: '#f3c39e', charColor: '#a5d2ff' },
    wordCloud: { title: '葡萄架下的词云', ritual: '听见另一边', intention: '葡萄架 · 私语', userColor: '#efbadb', charColor: '#9fdcff' },
};

const createPlannedJourney = (bundle: QixiMemoryBundle): QixiJourneyBeat[] => QIXI_SCENE_IDS.map(sceneId => ({
    sceneId,
    sceneName: SCENES[sceneId].title,
    sharedObject: bundle.scenes[sceneId].sharedObject,
    userChoices: [],
    userResults: [],
    charAction: bundle.scenes[sceneId].charAction,
}));

const freshGame = (userLayerColor: string = QIXI_DEFAULT_USER_LAYER_COLOR): QixiGameV8 => ({
    version: 8,
    stage: 'cover',
    sceneIndex: 0,
    sceneBeat: 'idle',
    wordCloudCharRevealed: 0,
    decisions: {},
    results: {},
    completedScenes: [],
    bridgePlaced: [],
    bridgeFinalState: 'idle',
    reunionPage: 0,
    reunionLineIndex: 0,
    userLayerColor,
});

const loadGame = (charId: string): QixiGameV8 | null => {
    try {
        const value = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${charId}`) || 'null') as QixiGameV8 | null;
        return value?.version === 8 ? {
            ...value,
            bridgeFinalState: value.bridgeFinalState || 'idle',
            reunionLineIndex: value.reunionLineIndex || 0,
            wordCloudCharRevealed: value.wordCloudCharRevealed || 0,
        } : null;
    } catch {
        return null;
    }
};

const unique = <T,>(items: T[]): T[] => [...new Set(items)];
const createRunId = (): string => globalThis.crypto?.randomUUID?.() || `qixi-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const qixiChibiRaw = (char: CharacterProfile): string | undefined => char.vrState?.chibi?.img || char.sprites?.chibi;

const ExitButton: React.FC<{ onClose: () => void }> = ({ onClose }) => (
    <button type="button" className="q7-exit" onClick={onClose} aria-label="退出七夕活动">退出 <b>×</b></button>
);

const CelestialBackdrop: React.FC = () => (
    <svg className="q7-sky" viewBox="0 0 1000 1600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
            <radialGradient id="q7mist"><stop stopColor="#f4c9de" stopOpacity=".18" /><stop offset="1" stopColor="#7f62ad" stopOpacity="0" /></radialGradient>
            <linearGradient id="q7line"><stop stopColor="#f3d8e7" stopOpacity="0" /><stop offset=".5" stopColor="#f3d8e7" stopOpacity=".55" /><stop offset="1" stopColor="#f3d8e7" stopOpacity="0" /></linearGradient>
        </defs>
        <circle cx="510" cy="500" r="430" fill="url(#q7mist)" />
        <g fill="none" stroke="url(#q7line)"><ellipse cx="500" cy="530" rx="430" ry="255" transform="rotate(-18 500 530)" /><ellipse cx="500" cy="530" rx="330" ry="590" transform="rotate(29 500 530)" strokeDasharray="3 12" /><path d="M-100 1240C210 1010 690 1450 1110 1120" strokeDasharray="4 13" /></g>
        <g fill="#fff3dc"><path d="M124 224l7 15 16 7-16 7-7 16-7-16-16-7 16-7z" /><path d="M845 184l5 11 12 5-12 5-5 12-5-12-12-5 12-5z" /><path d="M779 642l5 11 12 5-12 5-5 12-5-12-12-5 12-5z" /><circle cx="235" cy="390" r="3" /><circle cx="760" cy="338" r="2.5" /><circle cx="690" cy="1020" r="3" /></g>
    </svg>
);

interface QixiFlappyHandle {
    advanceTime: (ms: number) => void;
    state: () => { score: number; alive: boolean; ready: boolean; y: number };
}

const QixiFlappyLoader = React.forwardRef<QixiFlappyHandle, {
    char: CharacterProfile;
    ready: boolean;
    notice: string;
    onClose: () => void;
    onContinue: () => void;
}>(({ char, ready, notice, onClose, onContinue }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const rafRef = useRef(0);
    const readySinceRef = useRef<number | null>(null);
    const [ui, setUi] = useState({ score: 0, alive: true });
    const spriteUrl = useBlobRefUrl(qixiChibiRaw(char));
    const simRef = useRef({
        y: 250,
        vy: 0,
        score: 0,
        alive: true,
        time: 0,
        nextPipe: 1.35,
        pipes: [] as Array<{ x: number; gapY: number; counted: boolean }>,
    });

    const reset = useCallback(() => {
        simRef.current = { y: 250, vy: -110, score: 0, alive: true, time: 0, nextPipe: 1.2, pipes: [] };
        setUi({ score: 0, alive: true });
    }, []);

    const step = useCallback((ms: number) => {
        const state = simRef.current;
        if (!state.alive) return;
        const dt = Math.min(0.04, Math.max(0, ms / 1000));
        state.time += dt;
        state.vy += 780 * dt;
        state.y += state.vy * dt;
        state.nextPipe -= dt;
        if (state.nextPipe <= 0) {
            const deterministicGap = (Math.round(state.time * 10) * 37 + state.pipes.length * 71 + state.score * 53) % 220;
            state.pipes.push({ x: 410, gapY: 135 + deterministicGap, counted: false });
            state.nextPipe = 1.75;
        }
        state.pipes.forEach(pipe => { pipe.x -= 118 * dt; });
        state.pipes = state.pipes.filter(pipe => pipe.x > -70);
        for (const pipe of state.pipes) {
            if (!pipe.counted && pipe.x < 76) {
                pipe.counted = true;
                state.score += 1;
                setUi(current => ({ ...current, score: state.score }));
            }
            const overlapsX = pipe.x < 105 && pipe.x + 58 > 48;
            const outsideGap = state.y - 23 < pipe.gapY - 73 || state.y + 23 > pipe.gapY + 73;
            if (overlapsX && outsideGap) state.alive = false;
        }
        if (state.y < 24) { state.y = 24; state.vy = 20; }
        if (state.y > 492) state.alive = false;
        if (ready && readySinceRef.current && performance.now() - readySinceRef.current > 2600) {
            state.vy += 950 * dt;
            if (state.y > 474) state.alive = false;
        }
        if (!state.alive) setUi(current => ({ ...current, alive: false }));
    }, [ready]);

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const state = simRef.current;
        ctx.clearRect(0, 0, 360, 520);
        const gradient = ctx.createLinearGradient(0, 0, 0, 520);
        gradient.addColorStop(0, '#2b173f');
        gradient.addColorStop(1, '#120a20');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 360, 520);
        ctx.strokeStyle = 'rgba(236,203,229,.12)';
        ctx.setLineDash([2, 9]);
        for (let y = 62; y < 520; y += 72) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(360, y - 34); ctx.stroke();
        }
        ctx.setLineDash([]);
        for (const pipe of state.pipes) {
            const topH = pipe.gapY - 73;
            const bottomY = pipe.gapY + 73;
            ctx.fillStyle = 'rgba(153,112,181,.54)';
            ctx.strokeStyle = 'rgba(244,205,228,.42)';
            ctx.lineWidth = 1;
            ctx.fillRect(pipe.x, 0, 58, topH);
            ctx.strokeRect(pipe.x, 0, 58, topH);
            ctx.fillRect(pipe.x, bottomY, 58, 520 - bottomY);
            ctx.strokeRect(pipe.x, bottomY, 58, 520 - bottomY);
            ctx.fillStyle = 'rgba(255,237,246,.62)';
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(topH % 2 ? '{…}' : '[消息]', pipe.x + 29, Math.max(24, topH - 14));
            ctx.fillText('上下文', pipe.x + 29, bottomY + 22);
        }
        ctx.save();
        ctx.translate(76, state.y);
        ctx.rotate(Math.max(-0.24, Math.min(0.35, state.vy / 900)));
        const image = imageRef.current;
        if (image?.complete && image.naturalWidth) {
            ctx.drawImage(image, -31, -31, 62, 62);
        } else {
            ctx.fillStyle = '#efb4ce';
            ctx.beginPath(); ctx.arc(0, 0, 25, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#2a1638';
            ctx.font = 'bold 18px serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(char.name.trim().charAt(0).toUpperCase(), 0, 1);
        }
        ctx.restore();
        ctx.fillStyle = '#efca92';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`SCORE ${String(state.score).padStart(2, '0')}`, 16, 25);
    }, [char.name]);

    useEffect(() => {
        if (!spriteUrl) { imageRef.current = null; return; }
        const image = new Image();
        image.src = spriteUrl;
        imageRef.current = image;
    }, [spriteUrl]);

    useEffect(() => {
        if (ready && readySinceRef.current === null) readySinceRef.current = performance.now();
    }, [ready]);

    useEffect(() => {
        let previous = performance.now();
        const frame = (now: number) => {
            step(now - previous);
            previous = now;
            draw();
            rafRef.current = requestAnimationFrame(frame);
        };
        rafRef.current = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(rafRef.current);
    }, [draw, step]);

    useEffect(() => {
        if (!ready || ui.alive) return;
        navigator.vibrate?.(18);
    }, [ready, ui.alive]);

    React.useImperativeHandle(ref, () => ({
        advanceTime: step,
        state: () => ({ score: simRef.current.score, alive: simRef.current.alive, ready, y: Math.round(simRef.current.y) }),
    }), [ready, step]);

    const flap = () => {
        if (!simRef.current.alive) {
            if (ready) return;
            reset();
            return;
        }
        simRef.current.vy = -315;
    };

    return <main className="q7-loading-game"><ExitButton onClose={onClose} /><section><p className="q7-kicker">MEMORY SORTING · FLAPPY CHAR</p><h2>穿过正在整理的<br />上下文碎片</h2>{notice && <small className="q7-loading-status">{notice}</small>}</section><div className="q7-flappy-shell"><canvas ref={canvasRef} width={360} height={520} onPointerDown={flap} aria-label="点击或触摸让角色上升" />{!ui.alive && !ready && <button type="button" onClick={reset}>再飞一次</button>}{!ui.alive && ready && <div className="q7-flappy-ready"><small>MEMORIES READY</small><b>记忆整理完成。</b><button type="button" data-qixi-action="loading-continue" onClick={onContinue}>落进那条异常消息</button></div>}</div><footer>点击 / 触摸，让 {char.name} 上升</footer></main>;
});
QixiFlappyLoader.displayName = 'QixiFlappyLoader';

const AnimatedText: React.FC<{ text: string; className?: string }> = ({ text, className }) => (
    <span className={className} aria-label={text}>{[...text].map((char, index) => <i key={`${char}-${index}`} style={{ '--char-index': index } as React.CSSProperties}>{char}</i>)}</span>
);

const LOST_LAYER_ERRORS = [
    ['API 429', '请求太快，请稍后再试'],
    ['TIMEOUT', '这条消息等了太久'],
    ['DELIVERY FAILED', '抱歉，暂时没能送达'],
    ['CONNECTION LOST', '正在努力重新连接'],
    ['RESPONSE BLOCKED', '很遗憾，回复中断了'],
    ['UNKNOWN ERROR', '或许可以换个说法'],
] as const;

const QixiBird: React.FC<{ className?: string; style?: React.CSSProperties }> = ({ className = '', style }) => (
    <span className={`q7-magpie ${className}`.trim()} style={style} aria-hidden="true">
        <i />
        <b />
    </span>
);

const SceneObject: React.FC<{
    sceneId: QixiSceneId;
    label: string;
    beat: SceneBeat;
    visualQuips?: string[];
    userText?: string;
    charText?: string;
    charMutter?: string;
    charReply?: string;
    charContribution?: string;
    topicOptions?: QixiSceneOption[];
    selectedTopicId?: string;
    onTopicSelect?: (id: string) => void;
}> = ({ sceneId, label, beat, visualQuips = [], userText, charText, charMutter, charReply, charContribution, topicOptions = [], selectedTopicId, onTopicSelect }) => {
    const changedByChar = beat === 'char' || beat === 'complete';
    return <div className={`q7-object is-${sceneId} is-beat-${beat}`} aria-label={label}>
        {sceneId === 'lostLayer' && <div className="q7-message-object">
            <i className="q7-message-line" /><i className="q7-message-line" /><i className="q7-message-line" />
            <div className="q7-topic-choices">{topicOptions.slice(0, 3).map((option, index) => <button type="button" key={option.id} style={{ '--topic-index': index } as React.CSSProperties} className={selectedTopicId === option.id ? 'is-selected' : ''} disabled={beat !== 'idle'} onClick={() => onTopicSelect?.(option.id)}><span>{option.label}</span></button>)}</div>
            {beat !== 'idle' && <div className={`q7-lost-error-field ${changedByChar ? 'is-erasing' : ''}`} aria-label="发送失败，报错正在铺满空间">
                {LOST_LAYER_ERRORS.map(([code, message], index) => <b key={code} style={{ '--error-index': index } as React.CSSProperties}><small>{code}</small><span>{message}</span>{changedByChar && <i aria-hidden="true" />}</b>)}
            </div>}
            {changedByChar && <div className="q7-char-overwrite">
                {charMutter && <AnimatedText className="q7-char-mutter" text={charMutter} />}
            </div>}
            {changedByChar && visualQuips.length > 0 && <div className="q7-lost-whispers" aria-label={`另一层的碎碎念：${visualQuips.join(' ')}`}>{visualQuips.slice(0, 2).map((quip, index) => <p key={`${quip}-${index}`} style={{ '--quip-index': index } as React.CSSProperties}>“{quip}”</p>)}</div>}
            {changedByChar && charText && <AnimatedText className="q7-lost-core-instruction" text={charText} />}
            {changedByChar && charReply && <AnimatedText className="q7-lost-real-reply" text={charReply} />}
        </div>}
        {sceneId === 'doubleWish' && <div className={`q7-wish-object ${changedByChar ? 'is-flipped' : ''}`}>
            <div className="front"><small>你的愿望</small><i className="q7-wish-seal">愿</i>{userText && <AnimatedText text={userText} />}</div>
            <div className="back"><small>{'另一面的愿望'}</small>{charText && <AnimatedText text={charText} />}{visualQuips[0] && <em className="q7-wish-whisper">“{visualQuips[0]}”</em>}</div>
            <span className="hanger" />
        </div>}
        {sceneId === 'threadNeedle' && <svg viewBox="0 0 260 220" aria-hidden="true"><path className="needle" d="M175 26L83 187" /><ellipse className="eye" cx="170" cy="35" rx="7" ry="14" transform="rotate(31 170 35)" /><path className="thread user-thread" d="M25 151C87 75 153 170 211 86S292 71 236 174" /><path className="thread char-thread" d="M233 177C190 138 159 55 103 105S40 119 29 159" /><circle className="thread-spark" cx="170" cy="35" r="4" /></svg>}
        {sceneId === 'offerings' && <div className="q7-offering-stage">
            <span className="q7-offering-table" aria-hidden="true" />
            <section className="q7-offering-slot is-user"><small>你放下</small><b>{userText || '你的供物'}</b><i aria-hidden="true" /></section>
            <section className="q7-offering-slot is-char"><small>另一边放下私物</small><b>{charContribution || '一件属于 ta 的私物'}</b><i aria-hidden="true" /></section>
            {changedByChar && visualQuips[0] && <em className="q7-offering-quip">“{visualQuips[0]}”</em>}
        </div>}
        {sceneId === 'reflection' && <div className="q7-water-object"><i /><i /><i /><span /><em className="q7-water-star">✦</em>{changedByChar && <b />}</div>}
        {sceneId === 'nightMarket' && <div className="q7-market-object">
            <span className="q7-market-awning" aria-hidden="true" />
            <section className="q7-market-purchase is-user"><small>你挑中</small><b>{userText || '还没选商品'}</b></section>
            {changedByChar && charContribution && <section className="q7-market-purchase is-char"><small>另一边偷偷自购</small><b>{charContribution}</b></section>}
            <i className="q7-market-lantern one" aria-hidden="true" /><i className="q7-market-lantern two" aria-hidden="true" />
            <b className="q7-market-ticket" />
        </div>}
        {sceneId === 'wordCloud' && <div className="q7-vine-object"><i /><i /><i /><span /><b /><b /><b /></div>}
        {visualQuips.length > 0 && !['lostLayer', 'doubleWish', 'offerings'].includes(sceneId) && <div className={`q7-char-visual-quips is-${sceneId}`} aria-label={`另一层吐槽：${visualQuips.join(' ')}`}>
            {visualQuips.map((quip, index) => <p key={`${quip}-${index}`} style={{ '--quip-index': index } as React.CSSProperties}>“{quip}”</p>)}
        </div>}
        {changedByChar && !['lostLayer', 'doubleWish', 'wordCloud'].includes(sceneId) && <span className="q7-char-signature" aria-hidden="true"><i /><i /><i /></span>}
        <small>{label}</small>
    </div>;
};

const activeMeetingSprites = (char: CharacterProfile): Record<string, string> => {
    const skin = char.activeSkinSetId
        ? char.dateSkinSets?.find(item => item.id === char.activeSkinSetId)
        : undefined;
    return skin?.sprites && Object.keys(skin.sprites).length ? skin.sprites : (char.sprites || {});
};

const QixiPortrait: React.FC<{
    char: CharacterProfile;
    reunion: QixiReunionBundle;
    stage: QixiPortraitStage;
    meetingExpression?: string | null;
    adjustable?: boolean;
    onMeetingConfigSave?: (config: SpriteConfig) => void;
}> = ({ char, reunion, stage, meetingExpression, adjustable = false, onMeetingConfigSave }) => {
    const [meetingFailed, setMeetingFailed] = useState(false);
    const [chibiFailed, setChibiFailed] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [meetingConfig, setMeetingConfig] = useState<SpriteConfig>(() => char.spriteConfig || { scale: 1, x: 0, y: 0 });
    const meetingSprites = activeMeetingSprites(char);
    const cue = reunion.portrait.stages[stage];
    const meetingKeys = Object.keys(meetingSprites).filter(key => !['chibi', 'thumbnail', 'icon', 'avatar'].includes(key.toLowerCase()));
    const requestedMeetingExpression = meetingExpression || cue.meetingExpression;
    const meetingKey = requestedMeetingExpression && meetingKeys.includes(requestedMeetingExpression)
        ? requestedMeetingExpression
        : meetingKeys.includes('normal') ? 'normal' : meetingKeys[0];
    const meetingRaw = meetingKey ? meetingSprites[meetingKey] : undefined;
    const chibiRaw = qixiChibiRaw(char);
    const meetingUrl = useBlobRefUrl(meetingRaw);
    const chibiUrl = useBlobRefUrl(chibiRaw);
    useEffect(() => setMeetingFailed(false), [meetingUrl]);
    useEffect(() => setChibiFailed(false), [chibiUrl]);
    useEffect(() => {
        setMeetingConfig(char.spriteConfig || { scale: 1, x: 0, y: 0 });
    }, [char.id, char.spriteConfig?.scale, char.spriteConfig?.x, char.spriteConfig?.y]);
    const meetingStyle: React.CSSProperties = {
        animation: 'q7-gal-portrait .7s ease both',
        transform: `translate(calc(-50% + ${meetingConfig.x}%), ${meetingConfig.y}%) scale(${meetingConfig.scale})`,
    };
    if (meetingUrl && !meetingFailed) {
        return <>
            <div className="q7-portrait is-meeting" data-emotion={cue.emotionIntent}><img src={meetingUrl} alt={char.name} onError={() => setMeetingFailed(true)} style={meetingStyle} /></div>
            {adjustable && <div className="q7-portrait-adjust">
                <button type="button" className="q7-portrait-adjust-toggle" aria-label="调整立绘大小与位置" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(open => !open)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.86 1.86-.06-.06A1.7 1.7 0 0 0 16 18.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V20h-2.6v-.1A1.7 1.7 0 0 0 10.9 18.4a1.7 1.7 0 0 0-1.88.34l-.06.06-1.86-1.86.06-.06A1.7 1.7 0 0 0 7.5 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H5.7V11h.1A1.7 1.7 0 0 0 7.5 10a1.7 1.7 0 0 0-.34-1.88l-.06-.06L8.96 6.2l.06.06A1.7 1.7 0 0 0 10.9 6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V4h2.6v.1A1.7 1.7 0 0 0 16 6a1.7 1.7 0 0 0 1.88-.34l.06-.06 1.86 1.86-.06.06A1.7 1.7 0 0 0 19.4 10a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1V14h-.1a1.7 1.7 0 0 0-1.7 1Z" /></svg>
                </button>
                {settingsOpen && <section className="q7-portrait-adjust-panel" onClick={event => event.stopPropagation()}>
                    <header><b>立绘调整</b><button type="button" onClick={() => { onMeetingConfigSave?.(meetingConfig); setSettingsOpen(false); }}>完成</button></header>
                    <label><span>大小 <i>{meetingConfig.scale.toFixed(1)}×</i></span><input type="range" min="0.5" max="2" step="0.1" value={meetingConfig.scale} onChange={event => setMeetingConfig(current => ({ ...current, scale: Number(event.target.value) }))} /></label>
                    <label><span>左右 <i>{meetingConfig.x}%</i></span><input type="range" min="-100" max="100" step="5" value={meetingConfig.x} onChange={event => setMeetingConfig(current => ({ ...current, x: Number(event.target.value) }))} /></label>
                    <label><span>上下 <i>{meetingConfig.y}%</i></span><input type="range" min="-50" max="50" step="5" value={meetingConfig.y} onChange={event => setMeetingConfig(current => ({ ...current, y: Number(event.target.value) }))} /></label>
                    <button type="button" className="q7-portrait-adjust-reset" onClick={() => setMeetingConfig({ scale: 1, x: 0, y: 0 })}>重置为见面模式默认</button>
                </section>}
            </div>}
        </>;
    }
    if (chibiUrl && !chibiFailed) {
        return <div className="q7-portrait is-chibi" data-emotion={cue.emotionIntent}><img src={chibiUrl} alt={char.name} onError={() => setChibiFailed(true)} /></div>;
    }
    return <div className="q7-portrait is-initial" data-emotion={cue.emotionIntent}><span>{char.name.trim().charAt(0).toUpperCase()}</span></div>;
};

export const QixiDemoSession: React.FC<QixiDemoSessionProps> = ({ char, user, apiConfig, onClose, sessionMode = 'fresh', replaySnapshot = null, onReturnToChat, onPortraitConfigSave }) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const flappyRef = useRef<QixiFlappyHandle | null>(null);
    const localGameAtOpen = useMemo(() => loadGame(char.id), [char.id]);
    const savedAtOpen = useRef<QixiGameV8 | null>(sessionMode === 'fresh' && localGameAtOpen?.stage !== 'ending' ? localGameAtOpen : null);
    const replayGameAtOpen = useRef<QixiGameV8 | null>(replaySnapshot?.version === 8 ? replaySnapshot.game : (sessionMode === 'replay' ? localGameAtOpen : null));
    const materialGenerationRef = useRef<Promise<QixiMemoryBundle> | null>(null);
    const bridgeGenerationRef = useRef<Promise<QixiBridgeBundle | null> | null>(null);
    const reunionGenerationRef = useRef<Promise<QixiReunionBundle | null> | null>(null);
    // Generated parts live outside the mutable gameplay state as well. Scene
    // transitions must never be able to erase a result that finished in the
    // background before the player reached that part.
    const bridgeResultRef = useRef<QixiBridgeBundle | null>(replayGameAtOpen.current?.bridge || null);
    const reunionResultRef = useRef<QixiReunionBundle | null>(replayGameAtOpen.current?.reunion || null);
    const finishRef = useRef(false);
    const runIdRef = useRef(createRunId());
    const fallbackBundle = useMemo(() => createQixiFallbackBundle(), []);
    const cachedAtOpen = useMemo(() => replaySnapshot?.version === 8 ? replaySnapshot.bundle : loadQixiMemoryBundle(char.id), [char.id, replaySnapshot]);
    const [game, setGame] = useState<QixiGameV8>(freshGame);
    const [memoryBundle, setMemoryBundle] = useState<QixiMemoryBundle | null>(cachedAtOpen);
    const [memoryStatus, setMemoryStatus] = useState<'idle' | 'loading' | 'memory' | 'fallback'>(cachedAtOpen?.source === 'memory' ? 'memory' : 'idle');
    const [memoryNotice, setMemoryNotice] = useState('');
    const [loadingReady, setLoadingReady] = useState(false);
    const [materialPhaseReady, setMaterialPhaseReady] = useState<MaterialPhaseReady>(cachedAtOpen ? 3 : 0);
    const [selectedUserLayerColor, setSelectedUserLayerColor] = useState<string>(
        replayGameAtOpen.current?.userLayerColor || savedAtOpen.current?.userLayerColor || QIXI_DEFAULT_USER_LAYER_COLOR,
    );
    const [apiConfirmationOpen, setApiConfirmationOpen] = useState(false);
    const [generationStatus, setGenerationStatus] = useState<Record<GenerationPart, GenerationState>>({ part1: 'idle', part2: 'idle', part3: 'idle' });
    const [generationError, setGenerationError] = useState<{ part: GenerationPart; message: string } | null>(null);
    const [touch, setTouch] = useState<TouchState>({ x: 50, y: 64, active: false, approaching: false, joined: false, releasedEarly: false, releasedAfterJoin: false });
    const touchingRef = useRef(false);
    const joinedRef = useRef(false);
    const touchElapsedRef = useRef(0);
    const approachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const contactTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const finishToChatRef = useRef<() => Promise<void>>(async () => undefined);
    const bgm = useQixiBGM(game.stage, game.sceneIndex);
    const activeBundle = memoryBundle || fallbackBundle;
    const sessionUserLayerColor = ['cover', 'colorSelect'].includes(game.stage)
        ? selectedUserLayerColor
        : game.userLayerColor || selectedUserLayerColor;
    const sessionCharLayerColor = activeBundle.charLayerColor || QIXI_FALLBACK_CHAR_LAYER_COLOR;
    const charPerformance = activeBundle.charPerformance || { tempo: 'measured', markStyle: 'soft', presence: 'careful' };
    const currentSceneId = QIXI_SCENE_IDS[Math.max(0, Math.min(QIXI_SCENE_IDS.length - 1, game.sceneIndex))];
    const sceneMeta = SCENES[currentSceneId];
    const scenePayload = activeBundle.scenes[currentSceneId];
    const requiredMaterialPhase: MaterialPhaseReady = game.sceneIndex < 2 ? 1 : game.sceneIndex < 5 ? 2 : 3;
    const currentSceneMaterialReady = sessionMode === 'replay' || materialPhaseReady >= requiredMaterialPhase;
    const sceneDecisions = game.decisions[currentSceneId] || [];
    const selectedSceneOption = scenePayload.options.find(option => sceneDecisions.includes(option.id));
    const sceneCompleted = game.completedScenes.includes(currentSceneId);
    const portraitPlan = useMemo(() => resolveQixiPortraitPlan(char), [char]);
    const sceneFragments = useMemo(() => {
        const selected = scenePayload.artifactIds
            .map(id => activeBundle.artifacts.find(item => item.id === id))
            .filter((item): item is QixiMemoryArtifact => Boolean(item));
        const fill = activeBundle.artifacts.filter(item => !selected.some(existing => existing.id === item.id));
        const combined = [...selected, ...fill];
        return combined.slice(0, 6);
    }, [activeBundle.artifacts, scenePayload.artifactIds]);

    const wordArtifacts = useMemo(() => resolveQixiWordArtifacts(
        scenePayload.artifactIds,
        scenePayload.charSelectionIds,
        activeBundle.artifacts,
        scenePayload.options.map(option => ({
            id: option.id,
            label: option.label,
            kind: 'trait',
            evidenceIds: option.evidenceIds,
        })),
    ), [activeBundle.artifacts, scenePayload.artifactIds, scenePayload.charSelectionIds, scenePayload.options]);
    const wordPickTarget = qixiWordPickTarget(wordArtifacts.length, WORD_PICK_COUNT);

    const charWordSelections = useMemo(() => {
        return resolveQixiWordSelectionIds(scenePayload.charSelectionIds, wordArtifacts, WORD_PICK_COUNT);
    }, [scenePayload.charSelectionIds, wordArtifacts]);
    const visibleCharWordSelections = charWordSelections.slice(0, game.wordCloudCharRevealed);
    const wordTurnWaiting = currentSceneId === 'wordCloud'
        && game.sceneBeat === 'idle'
        && sceneDecisions.length > game.wordCloudCharRevealed;
    const sceneCharQuips = qixiCharQuips(currentSceneId, scenePayload);
    const activeWordCloudQuip = currentSceneId === 'wordCloud' && game.wordCloudCharRevealed > 0
        ? sceneCharQuips[Math.min(game.wordCloudCharRevealed - 1, sceneCharQuips.length - 1)]
        : '';
    const visibleVisualCharQuips = currentSceneId === 'wordCloud'
        ? (activeWordCloudQuip && !wordTurnWaiting ? [activeWordCloudQuip] : [])
        : (game.sceneBeat === 'char' || game.sceneBeat === 'complete' ? sceneCharQuips.slice(0, 2) : []);

    const generatePart3 = useCallback(async (bundle: QixiMemoryBundle): Promise<QixiReunionBundle | null> => {
        if (reunionResultRef.current) {
            const reunion = reunionResultRef.current;
            setGame(current => ({ ...current, reunion }));
            setGenerationStatus(current => ({ ...current, part3: 'ready' }));
            return reunion;
        }
        if (reunionGenerationRef.current) return reunionGenerationRef.current;
        setGenerationStatus(current => ({ ...current, part3: 'generating' }));
        setGenerationError(current => current?.part === 'part3' ? null : current);
        const plannedJourney = createPlannedJourney(bundle);
        reunionGenerationRef.current = prepareQixiReunion(char, user, apiConfig, bundle, plannedJourney, portraitPlan)
            .then(reunion => {
                reunionResultRef.current = reunion;
                setGame(current => ({ ...current, reunion }));
                setGenerationStatus(current => ({ ...current, part3: 'ready' }));
                return reunion;
            })
            .catch((error: any) => {
                setGenerationStatus(current => ({ ...current, part3: 'error' }));
                setGenerationError({ part: 'part3', message: error?.message || '最终见面生成失败。' });
                return null;
            })
            .finally(() => { reunionGenerationRef.current = null; });
        return reunionGenerationRef.current;
    }, [apiConfig, char, portraitPlan, user]);

    const generatePart2And3 = useCallback(async (bundle: QixiMemoryBundle): Promise<QixiBridgeBundle | null> => {
        if (bridgeResultRef.current) {
            const bridge = bridgeResultRef.current;
            setGame(current => ({ ...current, bridge }));
            setGenerationStatus(current => ({ ...current, part2: 'ready' }));
            if (!reunionResultRef.current) void generatePart3(bundle);
            return bridge;
        }
        if (bridgeGenerationRef.current) return bridgeGenerationRef.current;
        setGenerationStatus(current => ({ ...current, part2: 'generating', part3: 'idle' }));
        setGenerationError(current => current?.part === 'part2' ? null : current);
        bridgeGenerationRef.current = prepareQixiBridge(user, bundle)
            .then(async bridge => {
                bridgeResultRef.current = bridge;
                setGame(current => ({ ...current, bridge, bridgePlaced: [], bridgeFinalState: 'idle' }));
                setGenerationStatus(current => ({ ...current, part2: 'ready' }));
                await generatePart3(bundle);
                return bridge;
            })
            .catch((error: any) => {
                setGenerationStatus(current => ({ ...current, part2: 'error', part3: 'idle' }));
                setGenerationError({ part: 'part2', message: error?.message || '记忆鹊生成失败。' });
                return null;
            })
            .finally(() => { bridgeGenerationRef.current = null; });
        return bridgeGenerationRef.current;
    }, [generatePart3, user]);

    const ensureMaterials = useCallback(async (forceRegenerate = false, onRecallComplete?: () => void): Promise<QixiMemoryBundle> => {
        if (materialGenerationRef.current) return materialGenerationRef.current;
        setMemoryStatus('loading');
        setGenerationStatus({ part1: 'generating', part2: 'idle', part3: 'idle' });
        setGenerationError(null);
        setMemoryNotice(`正在整理你和 ${char.name} 的聊天与共同记忆，这一步可能需要稍长时间。`);
        materialGenerationRef.current = prepareQixiMemoryBundle(char, user, apiConfig, {
            forceRegenerate,
            strict: true,
            onRecallComplete,
            onPhaseReady: (phase, bundle) => {
                const readyPhase: MaterialPhaseReady = phase === 'first' ? 1 : phase === 'second' ? 2 : 3;
                setMemoryBundle(bundle);
                setMemoryStatus('memory');
                setMaterialPhaseReady(current => Math.max(current, readyPhase) as MaterialPhaseReady);
                if (phase === 'first') {
                    setLoadingReady(true);
                    setGenerationStatus({ part1: 'ready', part2: 'generating', part3: 'idle' });
                    setMemoryNotice(`开场与前两处空间已经整理完成；${char.name} 正在后台继续寻找后面的路。`);
                    return;
                }
                if (phase === 'second') {
                    setGenerationStatus({ part1: 'ready', part2: 'generating', part3: 'idle' });
                    setMemoryNotice('中段空间已经抵达；下一段仍在后台继续生成。');
                    return;
                }
                setGenerationStatus({ part1: 'ready', part2: 'ready', part3: 'generating' });
                setMemoryNotice('七处空间与鹊桥剧情已经全部生成。');
                void generatePart2And3(bundle);
            },
            userLayerColor: selectedUserLayerColor,
        })
            .then(prepared => {
                setMemoryBundle(prepared.bundle);
                setMemoryStatus('memory');
                return prepared.bundle;
            })
            .catch((error: any) => {
                setMemoryStatus('idle');
                setGenerationStatus(current => ({ ...current, part1: 'error' }));
                setGenerationError({ part: 'part1', message: error?.message || '记忆与开场生成失败。' });
                throw error;
            })
            .finally(() => { materialGenerationRef.current = null; });
        return materialGenerationRef.current;
    }, [apiConfig, char, generatePart2And3, selectedUserLayerColor, user]);

    const startFresh = useCallback(async () => {
        setApiConfirmationOpen(false);
        finishRef.current = false;
        runIdRef.current = createRunId();
        bridgeResultRef.current = null;
        reunionResultRef.current = null;
        setLoadingReady(false);
        setMaterialPhaseReady(0);
        setGame({ ...freshGame(selectedUserLayerColor), stage: 'colorSelect' });
        try {
            await ensureMaterials(true, () => setGame({ ...freshGame(selectedUserLayerColor), stage: 'loading' }));
            setLoadingReady(true);
        } catch {
            setLoadingReady(false);
        }
    }, [ensureMaterials, selectedUserLayerColor]);

    const confirmApiAndStart = useCallback(() => {
        setApiConfirmationOpen(false);
        void startFresh();
    }, [startFresh]);

    useEffect(() => {
        if (!apiConfirmationOpen) return;
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setApiConfirmationOpen(false);
        };
        window.addEventListener('keydown', closeOnEscape);
        return () => window.removeEventListener('keydown', closeOnEscape);
    }, [apiConfirmationOpen]);

    const openColorSelect = useCallback(() => {
        setMemoryNotice('');
        setGame(current => ({ ...current, stage: 'colorSelect' }));
    }, []);

    const startReplay = useCallback(() => {
        finishRef.current = false;
        const source = replayGameAtOpen.current;
        bridgeResultRef.current = source?.bridge || null;
        reunionResultRef.current = source?.reunion || null;
        if (!memoryBundle) setMemoryBundle(replaySnapshot?.bundle || loadQixiMemoryBundle(char.id) || fallbackBundle);
        const replayColor = source?.userLayerColor || selectedUserLayerColor;
        setSelectedUserLayerColor(replayColor);
        setGame({ ...freshGame(replayColor), stage: 'fakeChat', attitude: source?.attitude });
    }, [char.id, fallbackBundle, memoryBundle, replaySnapshot?.bundle, selectedUserLayerColor]);

    const continueAfterLoading = useCallback(() => {
        setGame(current => ({ ...current, stage: 'fakeChat' }));
    }, []);

    const resume = useCallback(() => {
        if (!savedAtOpen.current) return;
        const bundle = memoryBundle || loadQixiMemoryBundle(char.id) || fallbackBundle;
        bridgeResultRef.current = savedAtOpen.current.bridge || bridgeResultRef.current;
        reunionResultRef.current = savedAtOpen.current.reunion || reunionResultRef.current;
        if (!memoryBundle) setMemoryBundle(bundle);
        setGame(savedAtOpen.current);
        if (!savedAtOpen.current.bridge || !savedAtOpen.current.reunion) void generatePart2And3(bundle);
    }, [char.id, fallbackBundle, generatePart2And3, memoryBundle]);

    const retryGeneration = useCallback(async () => {
        const part = generationError?.part;
        if (!part) return;
        setGenerationError(null);
        if (part === 'part1') {
            setLoadingReady(false);
            setMaterialPhaseReady(0);
            setGame({ ...freshGame(selectedUserLayerColor), stage: 'colorSelect' });
            try {
                const bundle = await ensureMaterials(true, () => setGame({ ...freshGame(selectedUserLayerColor), stage: 'loading' }));
                setLoadingReady(true);
                return bundle;
            } catch { return null; }
        }
        if (part === 'part2') return generatePart2And3(activeBundle);
        return generatePart3(activeBundle);
    }, [activeBundle, ensureMaterials, generatePart2And3, generatePart3, generationError?.part, selectedUserLayerColor]);

    const enterInterlayer = useCallback((attitude: EntryAttitude) => {
        // Preserve bridge/reunion generated during Flappy and the opening. The
        // previous full-state replacement silently discarded both results.
        setGame(current => ({ ...enterQixiInterlayerState(current, attitude), stage: 'sceneTransition' }));
    }, []);

    const chooseOption = useCallback((optionId: string, result: string) => {
        if (sceneCompleted || game.sceneBeat !== 'idle') return;
        setGame(current => ({
            ...current,
            sceneBeat: 'user',
            decisions: { ...current.decisions, [currentSceneId]: [optionId] },
            results: { ...current.results, [currentSceneId]: [result] },
        }));
    }, [currentSceneId, game.sceneBeat, sceneCompleted]);

    const toggleWord = useCallback((artifactId: string) => {
        if (sceneCompleted || game.sceneBeat !== 'idle') return;
        setGame(current => {
            const selected = current.decisions.wordCloud || [];
            const next = selectQixiWordTurn(selected, current.wordCloudCharRevealed, artifactId, wordPickTarget);
            if (next === selected) return current;
            return {
                ...current,
                wordCloudCharRevealed: Math.min(current.wordCloudCharRevealed, next.length),
                decisions: { ...current.decisions, wordCloud: next },
                results: { ...current.results, wordCloud: next.map(id => wordArtifacts.find(item => item.id === id)?.label || id) },
            };
        });
    }, [game.sceneBeat, sceneCompleted, wordArtifacts, wordPickTarget]);

    const continueEmptyWordCloud = useCallback(() => {
        setGame(current => current.stage === 'scene' && current.sceneBeat === 'idle'
            ? { ...current, sceneBeat: 'char' }
            : current);
    }, []);

    useEffect(() => {
        if (game.stage !== 'scene' || currentSceneId !== 'wordCloud' || game.sceneBeat !== 'idle') return;
        if (wordPickTarget <= 0) return;
        if (sceneDecisions.length >= wordPickTarget && game.wordCloudCharRevealed >= wordPickTarget) {
            setGame(current => current.stage === 'scene' && current.sceneBeat === 'idle'
                ? { ...current, sceneBeat: 'char' }
                : current);
            return;
        }
        if (sceneDecisions.length <= game.wordCloudCharRevealed) return;
        const timer = window.setTimeout(() => setGame(current => {
            const selected = current.decisions.wordCloud || [];
            if (current.stage !== 'scene' || current.sceneBeat !== 'idle' || selected.length <= current.wordCloudCharRevealed) return current;
            const revealed = Math.min(wordPickTarget, current.wordCloudCharRevealed + 1);
            return {
                ...current,
                wordCloudCharRevealed: revealed,
                sceneBeat: selected.length >= wordPickTarget && revealed >= wordPickTarget ? 'char' : 'idle',
            };
        }), 720);
        return () => window.clearTimeout(timer);
    }, [currentSceneId, game.sceneBeat, game.stage, game.wordCloudCharRevealed, sceneDecisions.length, wordPickTarget]);

    const advanceSceneBeat = useCallback(() => {
        setGame(current => {
            if (current.stage !== 'scene') return current;
            if (current.sceneBeat === 'user') {
                return { ...current, sceneBeat: 'char' };
            }
            if (current.sceneBeat === 'char') {
                return { ...current, sceneBeat: 'complete', completedScenes: unique([...current.completedScenes, currentSceneId]) };
            }
            return current;
        });
    }, [currentSceneId]);

    const nextScene = useCallback(() => {
        setGame(current => current.sceneIndex >= QIXI_SCENE_IDS.length - 1
            ? { ...current, stage: 'bridgeLoading' }
            : { ...current, stage: 'sceneTransition', sceneIndex: current.sceneIndex + 1, sceneBeat: 'idle' });
    }, []);

    const journey = useMemo((): QixiJourneyBeat[] => QIXI_SCENE_IDS.map(sceneId => {
        const payload = activeBundle.scenes[sceneId];
        const decisionIds = game.decisions[sceneId] || [];
        const words = sceneId === 'wordCloud'
            ? decisionIds.map(id => wordArtifacts.find(item => item.id === id)?.label || id)
            : decisionIds.map(id => payload.options.find(option => option.id === id)?.label || id);
        return {
            sceneId,
            sceneName: SCENES[sceneId].title,
            sharedObject: payload.sharedObject,
            userChoices: words,
            userResults: game.results[sceneId] || [],
            charAction: payload.charAction,
        };
    }), [activeBundle.scenes, game.decisions, game.results, wordArtifacts]);

    useEffect(() => {
        if (game.stage !== 'bridgeLoading') return;
        const preparedBridge = game.bridge || bridgeResultRef.current;
        if (preparedBridge) {
            setGame(current => ({ ...current, bridge: preparedBridge, stage: 'bridge', bridgeFinalState: 'idle' }));
            return;
        }
        if (sessionMode !== 'replay') return;
        const replayBridge = normalizeQixiBridgeBundle(replayGameAtOpen.current?.bridge, activeBundle, user.name);
        setGame(current => ({ ...current, bridge: replayBridge, bridgePlaced: [], bridgeFinalState: 'idle', stage: 'bridge' }));
    }, [activeBundle, game.bridge, game.stage, sessionMode, user.name]);

    const placeBridgeNode = useCallback((nodeId: string) => {
        setGame(current => {
            if (current.stage !== 'bridge' || !current.bridge) return current;
            if (!current.bridge.userMagpies.some(item => item.id === nodeId) || current.bridgePlaced.includes(nodeId)) return current;
            return { ...current, bridgePlaced: [...current.bridgePlaced, nodeId] };
        });
        navigator.vibrate?.(14);
    }, []);

    useEffect(() => {
        if (game.stage !== 'bridge' || !game.bridge || game.bridgeFinalState !== 'idle') return;
        if (game.bridgePlaced.length < game.bridge.userMagpies.length) return;
        const timer = window.setTimeout(() => setGame(current => current.stage === 'bridge'
            ? { ...current, bridgeFinalState: 'flying' }
            : current), 800);
        return () => window.clearTimeout(timer);
    }, [game.bridge, game.bridgeFinalState, game.bridgePlaced.length, game.stage]);

    useEffect(() => {
        if (game.stage !== 'bridge' || game.bridgeFinalState !== 'flying') return;
        const timer = window.setTimeout(() => setGame(current => current.stage === 'bridge'
            ? { ...current, bridgeFinalState: 'connected' }
            : current), 1450);
        return () => window.clearTimeout(timer);
    }, [game.bridgeFinalState, game.stage]);

    useEffect(() => {
        if (game.stage !== 'bridge' || game.bridgeFinalState !== 'connected') return;
        const timer = window.setTimeout(() => setGame(current => current.stage === 'bridge'
            ? { ...current, stage: 'bridgeCrossing' }
            : current), 1750);
        return () => window.clearTimeout(timer);
    }, [game.bridgeFinalState, game.stage]);

    useEffect(() => {
        if (game.stage !== 'bridgeCrossing') return;
        const timer = window.setTimeout(() => {
            if (sessionMode === 'replay') {
                const reunion = replayGameAtOpen.current?.reunion || createQixiReunionFallback(char, user, portraitPlan);
                setGame(current => ({ ...current, reunion, reunionPage: 0, reunionLineIndex: 0, stage: 'reunion' }));
                return;
            }
            setGame(current => {
                const reunion = current.reunion || reunionResultRef.current || undefined;
                return { ...current, reunion, reunionPage: 0, reunionLineIndex: 0, stage: reunion ? 'reunion' : 'reunionLoading' };
            });
        }, 1700);
        return () => window.clearTimeout(timer);
    }, [char, game.stage, portraitPlan, sessionMode, user]);

    useEffect(() => {
        if (game.stage !== 'reunionLoading') return;
        const reunion = game.reunion || reunionResultRef.current;
        if (!reunion) return;
        setGame(current => ({ ...current, reunion, reunionPage: 0, reunionLineIndex: 0, stage: 'reunion' }));
    }, [game.reunion, game.stage]);

    useEffect(() => {
        if (['cover', 'loading', 'bridgeLoading', 'reunionLoading'].includes(game.stage)) return;
        try { localStorage.setItem(`${STORAGE_PREFIX}${char.id}`, JSON.stringify(game)); } catch { /* optional resume */ }
    }, [char.id, game]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key.toLowerCase() !== 'f') return;
            if (!document.fullscreenElement) rootRef.current?.requestFullscreen?.();
            else document.exitFullscreen?.();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    useEffect(() => () => {
        if (approachTimerRef.current) clearTimeout(approachTimerRef.current);
        if (contactTimerRef.current) clearTimeout(contactTimerRef.current);
    }, []);

    const completeTouch = useCallback(() => {
        joinedRef.current = true;
        touchElapsedRef.current = CONTACT_DURATION_MS;
        if (contactTimerRef.current) clearTimeout(contactTimerRef.current);
        setTouch(current => ({ ...current, active: true, approaching: true, joined: true, releasedEarly: false, releasedAfterJoin: false }));
        navigator.vibrate?.([22, 42, 22]);
    }, []);

    const beginTouch = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
        if (joinedRef.current) return;
        if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
        event.preventDefault();
        try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* Safari may already own/release capture */ }
        touchingRef.current = true;
        joinedRef.current = false;
        touchElapsedRef.current = 0;
        setTouch({ x: 50, y: 64, active: true, approaching: false, joined: false, releasedEarly: false, releasedAfterJoin: false });
        if (approachTimerRef.current) clearTimeout(approachTimerRef.current);
        if (contactTimerRef.current) clearTimeout(contactTimerRef.current);
        approachTimerRef.current = setTimeout(() => { if (touchingRef.current) setTouch(current => ({ ...current, approaching: true })); }, 260);
        contactTimerRef.current = setTimeout(() => { if (touchingRef.current) completeTouch(); }, CONTACT_DURATION_MS);
    }, [completeTouch]);

    const endTouch = useCallback((event?: React.PointerEvent<HTMLButtonElement>) => {
        event?.preventDefault();
        if (!touchingRef.current) return;
        touchingRef.current = false;
        try {
            if (event?.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        } catch { /* cancellation can release capture before React receives it */ }
        if (contactTimerRef.current) clearTimeout(contactTimerRef.current);
        if (approachTimerRef.current) clearTimeout(approachTimerRef.current);
        if (joinedRef.current) {
            setTouch(current => ({ ...current, active: false, approaching: false, releasedAfterJoin: true }));
            return;
        }
        setTouch(current => ({ ...current, active: false, approaching: false, releasedEarly: true }));
    }, []);

    useEffect(() => {
        if (game.stage !== 'touch' || !touch.joined || !touch.releasedAfterJoin) return;
        const timer = window.setTimeout(() => setGame(current => current.stage === 'touch' ? { ...current, stage: 'ending' } : current), 1800);
        return () => window.clearTimeout(timer);
    }, [game.stage, touch.joined, touch.releasedAfterJoin]);

    const finishToChat = useCallback(async () => {
        if (finishRef.current) return;
        finishRef.current = true;
        if (sessionMode === 'replay') {
            onClose();
            return;
        }
        const message = game.reunion?.returnMessage || `七夕快乐，${user.name}。`;
        try {
            const reunion = game.reunion;
            const card = createQixiEventChatCard({
                runId: runIdRef.current,
                charName: char.name,
                charAvatar: char.avatar || '',
                userName: user.name,
                timestamp: Date.now(),
                openingChat: activeBundle.openingChat,
                entryAttitude: game.attitude,
                scenes: QIXI_SCENE_IDS.map(sceneId => ({
                    id: sceneId,
                    title: SCENES[sceneId].title,
                    sharedObject: activeBundle.scenes[sceneId].sharedObject,
                    userActions: journey.find(item => item.sceneId === sceneId)?.userChoices || [],
                    userResults: game.results[sceneId] || [],
                    charAction: activeBundle.scenes[sceneId].charAction,
                    memoryLine: activeBundle.scenes[sceneId].memoryLine,
                })),
                bridgeNodes: (game.bridge?.nodes || []).map(node => ({ name: node.name, artifactLabel: node.visualHint, memoryLine: node.memory })),
                reunionLines: reunion?.reunion.lines || [],
                metaReflection: reunion?.metaReflection || [],
                companionshipReflection: reunion?.companionshipReflection || [],
                blessing: reunion?.blessing || [],
                promiseInvitation: reunion?.touch.invitation || [],
                promiseComplete: reunion?.touch.complete || '……约好了。',
            });
            const replaySnapshotValue: QixiReplaySnapshot = {
                version: 8,
                bundle: activeBundle,
                game: { ...game, stage: 'ending' },
            };
            if (onReturnToChat) await onReturnToChat({ message, card, replaySnapshot: replaySnapshotValue });
            else onClose();
        } catch {
            finishRef.current = false;
        }
    }, [activeBundle, char.avatar, char.name, game, journey, onClose, onReturnToChat, sessionMode, user.name]);

    useEffect(() => {
        finishToChatRef.current = finishToChat;
    }, [finishToChat]);

    const visibleActions = useMemo(() => {
        if (apiConfirmationOpen) return ['确认 API 配置并开始', '先不开始'];
        if (game.stage === 'cover') {
            if (sessionMode === 'replay') return ['重看上一次梦境'];
            return savedAtOpen.current ? ['进入梦境', '继续上次探索'] : ['进入梦境'];
        }
        if (game.stage === 'colorSelect') return memoryStatus === 'loading' ? ['正在辨认共同记忆'] : QIXI_USER_LAYER_COLORS.map(color => color.label);
        if (game.stage === 'loading') return loadingReady ? ['等待落地', '记忆整理完成后继续'] : ['点击或触摸使角色上升'];
        if (game.stage === 'entry') return ['探索附近', '喊 ta 的名字', '留在原地'];
        if (game.stage === 'sceneTransition') return currentSceneMaterialReady ? ['继续'] : ['等待这一段生成完成'];
        if (game.stage === 'scene') {
            if (game.sceneBeat === 'user') return [currentSceneId === 'lostLayer' ? '看看另一层的反应' : '继续'];
            if (game.sceneBeat === 'char') return ['继续'];
            if (currentSceneId === 'wordCloud' && !sceneCompleted) {
                if (wordPickTarget === 0) return ['继续'];
                return wordTurnWaiting ? ['等待另一边选择'] : wordArtifacts.map(item => item.label);
            }
            if (!sceneCompleted) return scenePayload.options.map(option => option.label);
            return [game.sceneIndex === QIXI_SCENE_IDS.length - 1 ? '让痕迹汇成桥' : '沿星线继续'];
        }
        if (game.stage === 'bridgeLoading') return ['正在把真实记忆整理成桥面'];
        if (game.stage === 'bridge') {
            const remaining = game.bridge?.userMagpies.filter(item => !game.bridgePlaced.includes(item.id)) || [];
            return remaining.length ? remaining.map(item => `想起：${item.name}`) : ['等待最后一只鹊从对岸飞来'];
        }
        if (game.stage === 'bridgeCrossing') return ['沿双方织出的星线走向对岸'];
        if (game.stage === 'reunion') return ['继续'];
        if (game.stage === 'touch') {
            const invitationCount = game.reunion?.touch.invitation.length || 0;
            if (game.reunionLineIndex < invitationCount) return ['继续听约定'];
            return [touch.joined ? '松手，留下约定' : '按住发光圆圈'];
        }
        if (game.stage === 'ending') return ['点击任意处结束'];
        return [];
    }, [apiConfirmationOpen, currentSceneId, currentSceneMaterialReady, game.bridge, game.bridgePlaced, game.reunion?.touch.invitation.length, game.reunionLineIndex, game.sceneBeat, game.sceneIndex, game.stage, loadingReady, memoryStatus, sceneCompleted, scenePayload.options, sessionMode, touch.joined, wordArtifacts, wordPickTarget, wordTurnWaiting]);

    useEffect(() => {
        const renderState = () => JSON.stringify({
            game: 'qixi-dual-layer-v8',
            sessionMode,
            coordinateSystem: 'full-screen story surface; touch coordinates are percentages from top-left',
            stage: game.stage,
            apiConfirmationOpen,
            scene: ['sceneTransition', 'scene'].includes(game.stage) ? { id: currentSceneId, title: sceneMeta.title, index: game.sceneIndex + 1, beat: game.sceneBeat, completed: sceneCompleted } : undefined,
            transitionLines: game.stage === 'sceneTransition' && currentSceneMaterialReady ? qixiTransitionLines(currentSceneId, scenePayload) : undefined,
            material: { status: memoryStatus, readyPhase: materialPhaseReady, currentSceneReady: currentSceneMaterialReady, evidence: activeBundle.evidence.length, artifacts: activeBundle.artifacts.length, personalizedScenes: activeBundle.personalizedSceneIds },
            layerIdentity: { userColor: sessionUserLayerColor, charColor: sessionCharLayerColor, charPerformance },
            bgm: { group: bgm.group, muted: bgm.muted },
            flappy: game.stage === 'loading' ? flappyRef.current?.state() : undefined,
            selected: game.stage === 'scene' ? sceneDecisions : undefined,
            wordCloudTurns: game.stage === 'scene' && currentSceneId === 'wordCloud' ? { user: sceneDecisions.length, char: game.wordCloudCharRevealed, waiting: wordTurnWaiting } : undefined,
            charRemark: game.stage === 'scene' && visibleVisualCharQuips.length ? visibleVisualCharQuips : undefined,
            charReply: game.stage === 'scene' && currentSceneId === 'lostLayer' ? selectedSceneOption?.charReply : undefined,
            charContribution: game.stage === 'scene' && ['offerings', 'nightMarket'].includes(currentSceneId) ? scenePayload.charContribution : undefined,
            completedScenes: game.completedScenes,
            generation: generationStatus,
            preparedParts: { part2: Boolean(game.bridge || bridgeResultRef.current), part3: Boolean(game.reunion || reunionResultRef.current) },
            generationError: generationError?.part,
            bridge: game.stage === 'bridge' ? {
                userMagpies: game.bridge?.userMagpies.length || 0,
                userPlaced: game.bridgePlaced.length,
                charMagpies: game.bridge?.charMagpies.length || 0,
                finalState: game.bridgeFinalState,
            } : undefined,
            reunionPage: game.stage === 'reunion' ? { page: game.reunionPage, line: game.reunionLineIndex } : undefined,
            portrait: game.reunion?.portrait.resourceType,
            touch: game.stage === 'touch' ? touch : undefined,
            visibleActions,
        });
        const advanceTime = (ms: number) => {
            if (game.stage === 'loading') {
                flappyRef.current?.advanceTime(ms);
                return;
            }
            if (game.stage !== 'touch' || !touchingRef.current || joinedRef.current) return;
            touchElapsedRef.current += Math.max(0, ms);
            if (touchElapsedRef.current >= CONTACT_DURATION_MS) completeTouch();
        };
        window.render_game_to_text = renderState;
        window.advanceTime = advanceTime;
        return () => {
            if (window.render_game_to_text === renderState) delete window.render_game_to_text;
            if (window.advanceTime === advanceTime) delete window.advanceTime;
        };
    }, [activeBundle, apiConfirmationOpen, bgm.group, bgm.muted, completeTouch, currentSceneId, currentSceneMaterialReady, game, generationError?.part, generationStatus, materialPhaseReady, memoryStatus, sceneCompleted, sceneDecisions, sceneMeta.title, scenePayload.charContribution, selectedSceneOption?.charReply, sessionMode, touch, visibleActions, wordTurnWaiting]);

    const renderCover = () => (
        <main className="q7-cover">
            <CelestialBackdrop /><ExitButton onClose={onClose} />
            <div className="q7-cover-frame" aria-hidden="true"><i /><i /><i /><i /></div>
            <section>
                <div className="q7-season"><i>✦</i><span>2026 · 七夕限定梦境</span><i>✦</i></div>
                <div className="q7-moons" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div>
                <h1><small>星月</small>梦境童话</h1>
                <em>THE TALE BENEATH A MESSAGE</em>
                <blockquote>沿着一条没有送达的消息，<br />捡回从聊天里漏掉的小事。</blockquote>
                <button type="button" data-qixi-action="enter-dream" className="q7-primary" onClick={sessionMode === 'replay' ? startReplay : openColorSelect}><span>{sessionMode === 'replay' ? '重看这次梦境' : '进入梦境'}</span><small>{sessionMode === 'replay' ? 'REPLAY THE SAME MEMORY' : 'ENTER REVERIE'}</small></button>
                {sessionMode === 'replay' ? <p className="q7-notice is-memory">沿用上一次生成的完整剧情、鹊桥与最终约定，不会再次调用模型，也不会重复写入私聊。</p> : memoryNotice && <p className={`q7-notice is-${memoryStatus}`}>{memoryNotice}</p>}
                {sessionMode === 'fresh' && savedAtOpen.current && <button type="button" data-qixi-action="resume" className="q7-resume" onClick={resume}>继续上次掉下去的地方</button>}
            </section>
        </main>
    );

    const renderFakeChat = () => (
        <main className="q7-chat"><ExitButton onClose={onClose} /><header><button>‹</button><i>{char.name.trim().charAt(0)}</i><span><b>{char.name}</b><small>在线</small></span></header><section><time>七夕 · 23:57</time>{activeBundle.openingChat.map((line, index) => <p key={index}><AnimatedText text={line} /></p>)}<em><i /> 输入状态反复消失</em></section><footer><button>＋</button><button type="button" className="q7-glitch-input" data-qixi-action="send-code" onClick={() => setGame(current => ({ ...current, stage: 'distort' }))}><span>点一下异常的输入框</span><i>│</i></button><button>↑</button></footer></main>
    );

    const renderDistort = () => (
        <main className="q7-distort"><ExitButton onClose={onClose} /><div className="q7-tunnel" aria-hidden="true"><i /><i /><i /><i /><span className="rabbit"><i /></span></div><header><small>CHAT / CONTEXT LEAK</small>{char.name}<span>正在输入　正在输入　正＿</span></header>{[...sceneFragments, ...activeBundle.artifacts].slice(0, 6).map((item, index) => <div key={`${item.id}-${index}`} className={`shard s${index + 1}`}>{item.label}</div>)}<button type="button" data-qixi-action="fall" className="q7-door" onClick={() => setGame(current => ({ ...current, stage: 'entry' }))}><small>输入框底下露出了一层不该出现的文字</small><b>空白正在向下裂开。</b><span>碰一下 ↓</span></button></main>
    );

    const renderEntry = () => (
        <main className="q7-story q7-entry"><CelestialBackdrop /><ExitButton onClose={onClose} /><div className="q7-entry-fragments" aria-hidden="true">{sceneFragments.slice(0, 5).map((item, index) => <i key={item.id} style={{ '--fragment-index': index } as React.CSSProperties}>{item.label}</i>)}</div><section><p className="q7-kicker">上下文夹层 · 坐标同时丢失</p><h2>你和那条消息<br />一起掉了下来。</h2><p>聊天界面在头顶合拢。半句话、日期、物件名和一块褪色的 [图片] 痕迹还在继续往下落。</p><aside>没有路标。白兔只是从裂缝里长出来的一小块错觉。</aside><button data-qixi-action="entry-explore" onClick={() => enterInterlayer('explore')}>先碰最近的那句话 <i>→</i></button><button data-qixi-action="entry-shout" onClick={() => enterInterlayer('shout')}>对着裂缝喊 {char.name} <i>→</i></button><button data-qixi-action="entry-stay" onClick={() => enterInterlayer('stay')}>不动，等一秒看看 <i>→</i></button></section></main>
    );

    const renderSceneTransition = () => {
        const lines = currentSceneMaterialReady ? qixiTransitionLines(currentSceneId, scenePayload) : [];
        return <main className={`q7-scene-transition is-${currentSceneId}`} style={{ '--user-color': sessionUserLayerColor, '--char-color': sessionCharLayerColor } as React.CSSProperties}>
            <CelestialBackdrop /><ExitButton onClose={onClose} />
            <div className="q7-transition-orbit" aria-hidden="true"><i className="is-user" /><i className="is-char" /><span /></div>
            <div className={`q7-transition-emblem is-${currentSceneId}`} aria-hidden="true"><i /><i /><i /><span /><b /></div>
            <section>
                <small>前往 {String(game.sceneIndex + 1).padStart(2, '0')} · {sceneMeta.title}</small>
                <div>{currentSceneMaterialReady
                    ? lines.map((line, index) => <p key={`${line}-${index}`}><AnimatedText text={line} /></p>)
                    : <p><AnimatedText text="这一段还在从另一层赶来。" /></p>}</div>
                <button type="button" data-qixi-action="enter-scene" disabled={!currentSceneMaterialReady} onClick={() => setGame(current => currentSceneMaterialReady ? ({ ...current, stage: 'scene' }) : current)}>{currentSceneMaterialReady ? '继续' : '正在等待'} <i>{currentSceneMaterialReady ? '→' : '···'}</i></button>
            </section>
        </main>;
    };

    const attitudeLine = game.attitude === 'shout'
        ? '你喊出的名字在字缝里弹了一下，几句还没发出的日常话题跟着亮起。'
        : game.attitude === 'stay'
            ? '你等了一秒，输入框把几句还没说的话推到面前。'
            : '第一步落下时，几件还想继续聊的小事在远处亮起。';

    const wishCardText = currentSceneId === 'doubleWish'
        ? selectedSceneOption?.label.replace(/^(?:写|许愿)[：:]\s*/, '')
        : undefined;
    const sceneObjectUserText = currentSceneId === 'offerings' || currentSceneId === 'nightMarket'
        ? selectedSceneOption?.label
        : wishCardText;
    const sceneChoicePrompt: Partial<Record<QixiSceneId, string>> = {
        doubleWish: '选一个你真想和 ta 一起抵达的以后',
        threadNeedle: '决定这一轮怎么和另一边配合',
        offerings: '选一件你想先放上供桌的东西',
        reflection: '决定要在水面留下什么',
        nightMarket: '从摊位上挑一件你真的想买的商品',
    };

    const renderScene = () => (
        <main className={`q7-story q7-scene is-${currentSceneId}`} style={{ '--user-color': sessionUserLayerColor, '--char-color': sessionCharLayerColor } as React.CSSProperties}>
            <CelestialBackdrop /><ExitButton onClose={onClose} />
            <div className="q7-route" aria-label="七夕星路">{QIXI_SCENE_IDS.map((id, index) => <i key={id} className={`${index === game.sceneIndex ? 'is-current' : ''} ${game.completedScenes.includes(id) ? 'is-done' : ''}`}><span>{String(index + 1).padStart(2, '0')}</span></i>)}<b className="bridge-dot">∞</b></div>
            <header><p className="q7-kicker">{String(game.sceneIndex + 1).padStart(2, '0')} · {sceneMeta.intention}</p><h2>{sceneMeta.title}</h2><em>{sceneMeta.ritual}</em>{game.sceneIndex === 0 && <small>{attitudeLine}</small>}</header>
            <section className="q7-scene-grid">
                <div className="q7-visual"><SceneObject sceneId={currentSceneId} label={scenePayload.sharedObject} beat={game.sceneBeat} visualQuips={visibleVisualCharQuips} userText={sceneObjectUserText} charText={['lostLayer', 'doubleWish'].includes(currentSceneId) ? qixiCharVisibleText(currentSceneId, scenePayload) : undefined} charMutter={currentSceneId === 'lostLayer' ? qixiCharMutter(scenePayload) : undefined} charReply={currentSceneId === 'lostLayer' ? selectedSceneOption?.charReply : undefined} charContribution={['offerings', 'nightMarket'].includes(currentSceneId) ? scenePayload.charContribution : undefined} topicOptions={currentSceneId === 'lostLayer' ? scenePayload.options : undefined} selectedTopicId={currentSceneId === 'lostLayer' ? sceneDecisions[0] : undefined} onTopicSelect={optionId => { const option = scenePayload.options.find(item => item.id === optionId); if (option) chooseOption(option.id, option.result); }} /><p><AnimatedText text={scenePayload.memoryLine} /></p></div>
                <div className="q7-interaction">
                    {!sceneCompleted && game.sceneBeat === 'idle' && currentSceneId === 'lostLayer' && <div className="q7-lost-instruction"><small>选择一个想和 ta 聊的话题</small><p>从输入框里挑一句现在想说的话。</p></div>}
                    {!sceneCompleted && game.sceneBeat === 'idle' && !['lostLayer', 'wordCloud'].includes(currentSceneId) && <><small>{sceneChoicePrompt[currentSceneId] || '选一种做法'}</small>{scenePayload.options.map(option => <button key={option.id} type="button" data-qixi-action={`choose-${currentSceneId}-${option.id}`} onClick={() => chooseOption(option.id, option.result)}>{option.label}<i>→</i></button>)}</>}
                    {!sceneCompleted && game.sceneBeat === 'idle' && currentSceneId === 'wordCloud' && (wordPickTarget > 0 ? <><small>选 {wordPickTarget} 个词：你想到的那个人是什么性格 · {Math.min(sceneDecisions.length, wordPickTarget)} / {wordPickTarget}</small><div className={`q7-words is-turn-taking ${wordTurnWaiting ? 'is-waiting' : ''}`}>{wordArtifacts.map(item => <button key={item.id} type="button" disabled={wordTurnWaiting || sceneDecisions.includes(item.id)} className={`${sceneDecisions.includes(item.id) ? 'is-user' : ''} ${visibleCharWordSelections.includes(item.id) ? 'is-char' : ''}`} data-qixi-action={`word-${item.id}`} onClick={() => toggleWord(item.id)}>{item.label}</button>)}</div><p className={`q7-word-turn-status ${wordTurnWaiting ? 'is-char' : 'is-user'}`}><i />{wordTurnWaiting ? '另一层也正在选一个词……' : game.wordCloudCharRevealed ? '再选一个你想到 ta 时会用的性格词。' : '先选一个最像 ta 的性格词。'}</p></> : <div className="q7-word-cloud-recovery"><small>散落的词没有完全显形</small><button type="button" data-qixi-action="continue-empty-word-cloud" onClick={continueEmptyWordCloud}>继续 <i>→</i></button></div>)}
                    {!sceneCompleted && game.sceneBeat === 'user' && currentSceneId === 'lostLayer' && <div className="q7-beat-prompt is-user is-error-beat"><small>这句话没有送达</small><p>{(game.results[currentSceneId] || [])[0]}</p><button type="button" data-qixi-action="scene-reveal-char" onClick={advanceSceneBeat}>看看另一层的反应 <i>→</i></button></div>}
                    {!sceneCompleted && game.sceneBeat === 'user' && currentSceneId !== 'lostLayer' && <div className="q7-beat-prompt is-user"><small>你碰过以后</small><p>{(game.results[currentSceneId] || [])[0]}</p><button type="button" data-qixi-action="scene-reveal-char" onClick={advanceSceneBeat}>继续 <i>→</i></button></div>}
                    {!sceneCompleted && game.sceneBeat === 'char' && <div className="q7-beat-prompt is-char"><small>{currentSceneId === 'lostLayer' ? '另一层挤了进来' : '另一层传来'}</small><p className="q7-char-stage-direction">{scenePayload.charAction}</p>{currentSceneId === 'wordCloud' && <div className="q7-words is-reveal">{wordArtifacts.map((item, index) => <span key={item.id} style={{ '--word-index': index } as React.CSSProperties} className={`${sceneDecisions.includes(item.id) ? 'is-user' : ''} ${visibleCharWordSelections.includes(item.id) ? 'is-char' : ''}`}>{item.label}</span>)}</div>}<button type="button" data-qixi-action="scene-complete-beat" onClick={advanceSceneBeat}>继续 <i>→</i></button></div>}
                    {sceneCompleted && <div className="q7-result">{currentSceneId === 'wordCloud' && <div className="q7-words is-reveal">{wordArtifacts.map((item, index) => <span key={item.id} style={{ '--word-index': index } as React.CSSProperties} className={`${sceneDecisions.includes(item.id) ? 'is-user' : ''} ${visibleCharWordSelections.includes(item.id) ? 'is-char' : ''}`}>{item.label}</span>)}</div>}<button type="button" data-qixi-action="next-scene" className="q7-next" onClick={nextScene}>继续 <i>→</i></button></div>}
                </div>
            </section>
        </main>
    );

    const renderBridgeLoading = () => (
        <main className="q7-reunion-loading"><CelestialBackdrop /><ExitButton onClose={onClose} /><div><i /><span /><i /></div><p>记忆已经抵达星河。<br />正在等两岸的鹊飞来……</p></main>
    );

    const renderBridge = () => {
        const bridge = game.bridge!;
        const allUserPlaced = game.bridgePlaced.length >= bridge.userMagpies.length;
        const visibleCharCount = allUserPlaced
            ? bridge.charMagpies.length
            : Math.min(bridge.charMagpies.length, Math.max(0, game.bridgePlaced.length - 1));
        const latest = [...bridge.userMagpies].reverse().find(item => game.bridgePlaced.includes(item.id));
        return <main className={`q7-magpie-bridge is-${game.bridgeFinalState || 'idle'}`}>
            <CelestialBackdrop /><ExitButton onClose={onClose} />
            <header><small>08 · 星河两岸</small><h2>想起一件事。</h2></header>
            <div className="q7-river" aria-label="双方从两岸召来记忆鹊，细线正在织成道路">
                <div className="q7-bank is-user"><i /><span>{user.name}</span></div>
                <div className="q7-bank is-char"><i /><span>{char.name}</span></div>
                <svg className="q7-woven-lines" viewBox="0 0 1000 520" preserveAspectRatio="none" aria-hidden="true">
                    {bridge.userMagpies.map((magpie, index) => game.bridgePlaced.includes(magpie.id) && <path key={magpie.id} className="is-user" style={{ '--thread-index': index } as React.CSSProperties} d={`M 40 ${440 - index * 24} C 260 ${330 - index * 16}, 410 ${310 + index * 9}, 510 ${260 + index * 3}`} />)}
                    {bridge.charMagpies.slice(0, visibleCharCount).map((magpie, index) => <path key={magpie.id} className="is-char" style={{ '--thread-index': index } as React.CSSProperties} d={`M 960 ${76 + index * 24} C 760 ${145 + index * 18}, 620 ${205 - index * 8}, 490 ${260 - index * 3}`} />)}
                </svg>
                <div className="q7-magpies is-user">{bridge.userMagpies.map((magpie, index) => game.bridgePlaced.includes(magpie.id) && <QixiBird key={magpie.id} style={{ '--magpie-index': index } as React.CSSProperties} />)}</div>
                <div className="q7-magpies is-char">{bridge.charMagpies.slice(0, visibleCharCount).map((magpie, index) => <QixiBird key={magpie.id} style={{ '--magpie-index': index } as React.CSSProperties} />)}</div>
                {latest && game.bridgeFinalState === 'idle' && <div key={latest.id} className="q7-memory-unfold"><b>「{latest.name}」</b><span>{latest.memory}</span><i>{latest.visualHint}</i></div>}
                {game.bridgeFinalState !== 'idle' && <div className="q7-final-magpie"><QixiBird /><strong>「{bridge.finalMagpie.name}」</strong><p>{bridge.finalMagpie.line}</p></div>}
                <div className="q7-thread-knot" />
            </div>
            {!allUserPlaced && <section className="q7-memory-choices" aria-label="选择一段真实记忆">
                {bridge.userMagpies.map(magpie => {
                    const placed = game.bridgePlaced.includes(magpie.id);
                    return <button type="button" key={magpie.id} disabled={placed} className={placed ? 'is-placed' : ''} data-qixi-action={`bridge-${magpie.id}`} onClick={() => placeBridgeNode(magpie.id)}><b>「{magpie.name}」</b><span>{magpie.memory}</span></button>;
                })}
            </section>}
        </main>;
    };

    const renderBridgeCrossing = () => (
        <main className="q7-bridge-crossing"><CelestialBackdrop /><div className="q7-crossing-thread is-user" /><div className="q7-crossing-thread is-char" /><div className="q7-crossing-stars">{Array.from({ length: 12 }, (_, index) => <i key={index} style={{ '--star-index': index } as React.CSSProperties} />)}</div></main>
    );

    const renderReunionLoading = () => (
        <main className="q7-reunion-loading"><CelestialBackdrop /><ExitButton onClose={onClose} /><div><i /><span /><i /></div><p>桥的另一端正在成为<br />你熟悉的那个 ta……</p></main>
    );

    const renderReunion = () => {
        const reunion = game.reunion!;
        const pages: Array<{ label: string; lines: string[]; portraitStage: QixiPortraitStage; expressionGroup: 'reunion' | 'metaReflection' | 'companionshipReflection' | 'blessing' }> = [
            { label: '终于看见', lines: reunion.reunion.lines, portraitStage: 'arrival', expressionGroup: 'reunion' },
            ...(reunion.metaReflection.length ? [{ label: '隔层回声', lines: reunion.metaReflection, portraitStage: 'reflection' as QixiPortraitStage, expressionGroup: 'metaReflection' as const }] : []),
            { label: '想起彼此', lines: reunion.companionshipReflection, portraitStage: 'reflection', expressionGroup: 'companionshipReflection' },
            { label: '七夕祝愿', lines: reunion.blessing, portraitStage: 'blessing', expressionGroup: 'blessing' },
        ];
        const page = pages[Math.min(game.reunionPage, pages.length - 1)];
        const lineIndex = Math.min(game.reunionLineIndex, Math.max(0, page.lines.length - 1));
        const line = page.lines[lineIndex] || '……';
        const lineExpression = reunion.portrait.lineExpressions?.[page.expressionGroup]?.[lineIndex] || null;
        const lastLine = lineIndex >= page.lines.length - 1;
        const lastPage = game.reunionPage >= pages.length - 1;
        const memoryEchoes = activeBundle.evidence.filter(item => line.includes(item.object)).slice(0, 2);
        const advance = () => setGame(current => {
            if (current.reunionLineIndex < page.lines.length - 1) return { ...current, reunionLineIndex: current.reunionLineIndex + 1 };
            if (current.reunionPage < pages.length - 1) return { ...current, reunionPage: current.reunionPage + 1, reunionLineIndex: 0 };
            return { ...current, stage: 'touch', reunionLineIndex: 0 };
        });
        return <main className={`q7-reunion q7-galgame is-${page.portraitStage} ${page.label === '想起彼此' ? 'is-companionship' : ''}`}>
            <CelestialBackdrop /><ExitButton onClose={onClose} />
            <div className="q7-reunion-bridge-echo"><i className="is-user" /><i className="is-char" /><QixiBird /></div>
            {memoryEchoes.length > 0 && <div className="q7-reunion-memory-echo">{memoryEchoes.map(item => <span key={item.id}>「{item.object}」</span>)}</div>}
            <QixiPortrait char={char} reunion={reunion} stage={page.portraitStage} meetingExpression={lineExpression} adjustable onMeetingConfigSave={onPortraitConfigSave} />
            <button type="button" className="q7-galgame-dialogue" data-qixi-action={lastPage && lastLine ? 'begin-touch' : 'reunion-next'} onClick={advance}>
                <header><small>{page.label}</small><b>{char.name}</b></header>
                <p key={`${game.reunionPage}-${lineIndex}`}><AnimatedText text={line} /></p>
                <footer><span>{lastPage && lastLine ? '听 ta 说最后一个约定' : '点击继续'}</span><i>⌄</i></footer>
            </button>
        </main>;
    };

    const renderTouch = () => {
        const reunion = game.reunion!;
        const touchLine = touch.joined ? reunion.touch.complete : reunion.touch.hold;
        const invitationIndex = Math.min(game.reunionLineIndex, Math.max(0, reunion.touch.invitation.length - 1));
        const invitationReady = game.reunionLineIndex >= reunion.touch.invitation.length;
        const invitationExpression = reunion.portrait.lineExpressions?.invitation?.[invitationIndex] || null;
        return <main className={`q7-touch ${touch.releasedAfterJoin ? 'is-released' : ''}`}>
            <ExitButton onClose={onClose} />
            <QixiPortrait char={char} reunion={reunion} stage="promise" meetingExpression={invitationReady ? reunion.portrait.stages.promise.meetingExpression : invitationExpression} />
            {!invitationReady && <button type="button" className="q7-promise-dialogue" data-qixi-action="promise-next" onClick={() => setGame(current => ({ ...current, reunionLineIndex: current.reunionLineIndex + 1 }))}>
                <small>{char.name}</small>
                <p key={invitationIndex}><AnimatedText text={reunion.touch.invitation[invitationIndex] || '……'} /></p>
                <span>点击继续　⌄</span>
            </button>}
            <div className={`q7-touch-surface ${invitationReady ? 'is-ready' : 'is-waiting'} ${touch.active ? 'is-active' : ''} ${touch.approaching ? 'is-approaching' : ''} ${touch.joined ? 'is-joined' : ''}`} style={{ '--touch-x': touch.x, '--touch-y': touch.y } as React.CSSProperties}>
                <div className="q7-touch-name">{char.name}</div>
                {touch.active && <blockquote>“{touchLine}”</blockquote>}
                {touch.releasedAfterJoin && <blockquote className="q7-touch-complete">“{reunion.touch.complete}”</blockquote>}
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path className="user-trace" d={`M -4 98 C 18 84, ${Math.max(7, touch.x - 22)} ${Math.min(96, touch.y + 24)}, ${touch.x} ${touch.y}`} /><path className="char-trace" d={`M 104 4 C 85 18, ${Math.min(94, touch.x + 22)} ${Math.max(10, touch.y - 22)}, ${touch.x} ${touch.y}`} /></svg>
                {invitationReady && <button
                    type="button"
                    className="q7-touch-orb"
                    data-qixi-action="hold-glowing-orb"
                    aria-label="按住发光圆圈完成约定"
                    onPointerDown={beginTouch}
                    onPointerUp={endTouch}
                    onPointerCancel={endTouch}
                    onLostPointerCapture={endTouch}
                    onContextMenu={event => event.preventDefault()}
                    onDragStart={event => event.preventDefault()}
                ><i className="q7-touch-orb-ring is-user" /><i className="q7-touch-orb-ring is-char" /><b className="q7-touch-orb-core">✦</b><span><strong>快来碰碰这里</strong><small>{touch.releasedEarly && !touch.active ? '再按久一点' : touch.joined ? '可以松开了' : '轻轻按住'}</small></span></button>}
            </div>
        </main>;
    };

    const renderEnding = () => (
        <main
            className="q7-returning"
            role="button"
            tabIndex={0}
            aria-label="结束七夕活动"
            data-qixi-action="finish-event"
            onClick={() => void finishToChatRef.current()}
            onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') void finishToChatRef.current();
            }}
        ><CelestialBackdrop /><div className="q7-returning-knot"><i /><b /></div><section><small>THE MOMENT REMAINS</small><p>七夕快乐，{user.name}。</p><span>{char.name}</span></section></main>
    );

    const renderColorSelect = () => (
        <main className="q7-story q7-color-select">
            <CelestialBackdrop /><ExitButton onClose={onClose} />
            <section>
                <header className="q7-color-select-copy">
                    <p className="q7-kicker">01 · DEFINE YOUR TRACE</p>
                    <h2><span>先为这一边</span><strong>留下颜色。</strong></h2>
                    <p>进入夹层后，它会标记你碰过的文字与星线。{char.name} 会拥有属于自己的另一种颜色。</p>
                </header>
                <div className="q7-layer-color-picker">
                    <small><span>你的星线</span><b className="q7-layer-color-current"><i style={{ '--swatch': selectedUserLayerColor } as React.CSSProperties} />{QIXI_USER_LAYER_COLORS.find(color => color.value === selectedUserLayerColor)?.label || '已选择'}</b></small>
                    <div>{QIXI_USER_LAYER_COLORS.map(color => <button
                        key={color.value}
                        type="button"
                        aria-label={color.label}
                        aria-pressed={selectedUserLayerColor === color.value}
                        title={color.label}
                        disabled={memoryStatus === 'loading'}
                        style={{ '--swatch': color.value } as React.CSSProperties}
                        onClick={() => setSelectedUserLayerColor(color.value)}
                    ><i /><span>{color.label}</span></button>)}</div>
                </div>
                <button type="button" data-qixi-action="confirm-layer-color" className="q7-primary" onClick={() => setApiConfirmationOpen(true)} disabled={memoryStatus === 'loading'}><span>{memoryStatus === 'loading' ? '正在辨认两条星线' : '就用这个颜色'}</span><small>{memoryStatus === 'loading' ? 'TRACING MEMORIES' : 'CONFIRM YOUR SIDE'}</small></button>
                {memoryNotice && <p className={`q7-notice is-${memoryStatus}`}>{memoryNotice}</p>}
                {memoryStatus !== 'loading' && <button type="button" className="q7-color-select-back" onClick={() => setGame(current => ({ ...current, stage: 'cover' }))}>返回封面</button>}
            </section>
        </main>
    );

    const renderApiConfirmation = () => (
        <div className="q7-api-confirm" role="alertdialog" aria-modal="true" aria-labelledby="q7-api-confirm-title">
            <div className="q7-api-confirm__veil" />
            <section>
                <div className="q7-api-confirm__orbit" aria-hidden="true"><i /><i /><b>✦</b></div>
                <small>BEFORE GENERATION · 生成前确认</small>
                <h2 id="q7-api-confirm-title">检查一下 API 配置</h2>
                <div className="q7-api-confirm__count"><strong>{QIXI_MODEL_API_CALL_COUNT}</strong><span>次模型 API</span></div>
                <p>本次旅程共会调用 {QIXI_MODEL_API_CALL_COUNT} 次模型 API，请确认当前 API 配置与额度合适。</p>
                <p className="q7-api-confirm__note">确认后才会开始整理记忆；取消不会发起任何一次生成调用。</p>
                <div className="q7-api-confirm__actions">
                    <button type="button" data-qixi-action="confirm-api-and-start" onClick={confirmApiAndStart}>配置没问题，开始</button>
                    <button type="button" data-qixi-action="cancel-api-confirmation" className="is-quiet" onClick={() => setApiConfirmationOpen(false)}>先不开始</button>
                </div>
            </section>
        </div>
    );

    return createPortal(
        <div ref={rootRef} className={`qixi-v7-root is-tempo-${charPerformance.tempo} is-mark-${charPerformance.markStyle} is-presence-${charPerformance.presence}`} style={{ '--user-color': sessionUserLayerColor, '--char-color': sessionCharLayerColor, '--rose': sessionUserLayerColor, '--blue': sessionCharLayerColor } as React.CSSProperties}>
            <QixiBGMToggle muted={bgm.muted} onToggle={bgm.toggleMuted} />
            {apiConfirmationOpen && renderApiConfirmation()}
            {generationError && <div className="q7-generation-error" role="alertdialog" aria-modal="true">
                <div className="q7-generation-error__veil" />
                <section>
                    <small>{generationError.part.toUpperCase()} · GENERATION STOPPED</small>
                    <h2>这一段没有生成成功</h2>
                    <p>{generationError.message}</p>
                    <p>系统没有自动重试，也没有用固定文案冒充生成结果。</p>
                    <button type="button" data-qixi-action={`retry-${generationError.part}`} onClick={() => void retryGeneration()}>重新生成这一部分</button>
                    <button type="button" className="is-quiet" onClick={onClose}>先退出活动</button>
                </section>
            </div>}
            {game.stage === 'cover' && renderCover()}
            {game.stage === 'colorSelect' && renderColorSelect()}
            {game.stage === 'loading' && <QixiFlappyLoader ref={flappyRef} char={char} ready={loadingReady} notice={memoryNotice} onClose={onClose} onContinue={continueAfterLoading} />}
            {game.stage === 'fakeChat' && renderFakeChat()}
            {game.stage === 'distort' && renderDistort()}
            {game.stage === 'entry' && renderEntry()}
            {game.stage === 'sceneTransition' && renderSceneTransition()}
            {game.stage === 'scene' && renderScene()}
            {game.stage === 'bridgeLoading' && renderBridgeLoading()}
            {game.stage === 'bridge' && renderBridge()}
            {game.stage === 'bridgeCrossing' && renderBridgeCrossing()}
            {game.stage === 'reunionLoading' && renderReunionLoading()}
            {game.stage === 'reunion' && game.reunion && renderReunion()}
            {game.stage === 'touch' && game.reunion && renderTouch()}
            {game.stage === 'ending' && renderEnding()}
            <style>{`
                @keyframes q7-sky-drift{to{transform:translate3d(1.5%,-1%,0) scale(1.02)}}@keyframes q7-ring{to{transform:rotate(360deg)}}@keyframes q7-hop{50%{transform:translateY(-15px) rotate(8deg)}}@keyframes q7-card{50%{transform:translateY(-9px) rotate(-1deg)}}@keyframes q7-thread{0%{stroke-dashoffset:410}55%,100%{stroke-dashoffset:0}}@keyframes q7-water{0%{opacity:.8;transform:scale(.3)}100%{opacity:0;transform:scale(1.25)}}@keyframes q7-other{from{opacity:0;transform:translateX(15px)}to{opacity:1;transform:none}}@keyframes q7-bridge-line{to{transform:rotate(calc(-8deg + var(--i) * 4deg)) translateX(-5%)}}@keyframes q7-name{50%{opacity:.6;filter:blur(1px)}}@keyframes q7-loading{50%{transform:scaleX(.35);opacity:.45}}@keyframes q7-portrait{from{opacity:0;transform:translateX(-50%) translateY(24px) scale(.98)}to{opacity:1;transform:translateX(-50%)}}@keyframes q7-ending{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
                @media(max-width:760px){.q7-cover>section{padding:72px 12px 50px}.q7-cover h1{font-size:53px}.q7-cover h1 small{font-size:.43em}.q7-cover blockquote{margin:27px 0 24px;font-size:12px}.q7-primary{min-height:70px}.q7-primary span{font-size:15px}.q7-story{padding:102px 20px 55px}.q7-entry h2{font-size:48px}.q7-route{left:18px;right:66px;top:max(22px,env(safe-area-inset-top));gap:5px}.q7-route>i{width:23px;height:23px}.q7-route>i.is-current{width:29px;height:29px}.q7-route>i span{font-size:6px}.q7-scene>header{margin-bottom:28px}.q7-scene>header h2{font-size:42px}.q7-scene-grid{display:block}.q7-object{width:min(270px,72vw)}.q7-visual>p{margin-top:17px}.q7-interaction{margin-top:34px}.q7-interaction>button{font-size:13px}.q7-result>p{font-size:13px}.q7-other-layer{margin-top:23px}.q7-words{gap:8px}.q7-words button,.q7-words span{padding:8px 10px;font-size:10px}.q7-distort header{top:12%;font-size:45px}.q7-door{bottom:10%;width:82vw}.q7-chat section p{font-size:13px}}
                @media(max-height:700px) and (max-width:760px){.q7-cover>section{padding-top:42px}.q7-moons{margin:16px 0}.q7-cover h1{font-size:44px}.q7-cover blockquote{margin:18px 0}.q7-primary{min-height:60px}.q7-object{width:220px}.q7-scene>header{margin-bottom:18px}.q7-scene>header h2{font-size:36px}}
                @media(prefers-reduced-motion:reduce){.qixi-v7-root *{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
            `}</style>
        </div>,
        document.body,
    );
};

declare global {
    interface Window {
        render_game_to_text?: () => string;
        advanceTime?: (ms: number) => void;
    }
}
