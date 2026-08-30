import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    CaretLeft,
    CaretRight,
    ChatCircleDots,
    Image,
    Pause,
    Play,
    Star,
    Trash,
    Waveform,
    X,
} from '@phosphor-icons/react';
import {
    CONTENT_FAVORITES_CHANGED_EVENT,
    listContentFavorites,
    removeContentFavoriteById,
    resolveContentFavorite,
    type ContentFavorite,
    type ResolvedContentFavorite,
} from '../../utils/contentFavorites';
import {
    VOICE_FAVORITES_CHANGED_EVENT,
    getVoiceFavoriteBlob,
    listVoiceFavorites,
    removeVoiceFavoriteById,
    voiceFavoriteSourceLabel,
    type VoiceFavorite,
    type VoiceFavoriteSource,
} from '../../utils/voiceFavorites';

const PAGE_SIZE = 10;
type FavoriteTab = 'chat' | 'voice' | 'image';
type VoiceSourceFilter = 'all' | VoiceFavoriteSource;

interface FavoritesPortalProps {
    onClose: () => void;
    onJumpToMessage?: (charId: string, messageId: number) => void;
}

const voiceFilters: Array<{ value: VoiceSourceFilter; label: string }> = [
    { value: 'all', label: '全部' },
    { value: 'chat', label: '聊天' },
    { value: 'call', label: '通话' },
    { value: 'date', label: '见面' },
];

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
});

const formatTime = (timestamp: number) => timeFormatter.format(new Date(timestamp));

const messageTypeLabel = (type?: string): string => ({
    text: '文字',
    voice: '语音消息',
    emoji: '表情',
    transfer: '转账',
    social_card: '动态卡片',
    xhs_card: '小红书卡片',
    music_card: '音乐卡片',
    webpage_card: '网页卡片',
    life_card: '生活记录',
}[type || ''] || '聊天消息');

const FavoritesPortal: React.FC<FavoritesPortalProps> = ({ onClose, onJumpToMessage }) => {
    const [tab, setTab] = useState<FavoriteTab>('chat');
    const [contentItems, setContentItems] = useState<ContentFavorite[]>([]);
    const [voiceItems, setVoiceItems] = useState<VoiceFavorite[]>([]);
    const [resolvedItems, setResolvedItems] = useState<Record<string, ResolvedContentFavorite>>({});
    const [voiceFilter, setVoiceFilter] = useState<VoiceSourceFilter>('all');
    const [page, setPage] = useState(0);
    const [loading, setLoading] = useState(true);
    const [resolving, setResolving] = useState(false);
    const [playingId, setPlayingId] = useState<string | null>(null);
    const [audioError, setAudioError] = useState<string | null>(null);
    const [previewImage, setPreviewImage] = useState<string | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const objectUrlRef = useRef<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            const [content, voices] = await Promise.all([
                listContentFavorites(),
                listVoiceFavorites(),
            ]);
            setContentItems(content);
            setVoiceItems(voices);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
        window.addEventListener(CONTENT_FAVORITES_CHANGED_EVENT, refresh);
        window.addEventListener(VOICE_FAVORITES_CHANGED_EVENT, refresh);
        return () => {
            window.removeEventListener(CONTENT_FAVORITES_CHANGED_EVENT, refresh);
            window.removeEventListener(VOICE_FAVORITES_CHANGED_EVENT, refresh);
        };
    }, [refresh]);

    useEffect(() => () => {
        audioRef.current?.pause();
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    }, []);

    const chatItems = useMemo(() => contentItems.filter(item => item.kind === 'chat'), [contentItems]);
    const imageItems = useMemo(() => contentItems.filter(item => item.kind === 'image'), [contentItems]);
    const filteredVoices = useMemo(
        () => voiceFilter === 'all' ? voiceItems : voiceItems.filter(item => item.source === voiceFilter),
        [voiceFilter, voiceItems],
    );
    const activeItems = tab === 'chat' ? chatItems : tab === 'image' ? imageItems : filteredVoices;
    const pageCount = Math.max(1, Math.ceil(activeItems.length / PAGE_SIZE));
    const visibleItems = activeItems.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

    useEffect(() => {
        setPage(0);
        setAudioError(null);
    }, [tab, voiceFilter]);

    useEffect(() => {
        if (page >= pageCount) setPage(Math.max(0, pageCount - 1));
    }, [page, pageCount]);

    useEffect(() => {
        if (tab === 'voice') return;
        const favorites = visibleItems as ContentFavorite[];
        let cancelled = false;
        setResolving(true);
        Promise.all(favorites.map(resolveContentFavorite)).then(results => {
            if (cancelled) return;
            setResolvedItems(previous => {
                const next = { ...previous };
                results.forEach(result => { next[result.favorite.id] = result; });
                return next;
            });
        }).finally(() => {
            if (!cancelled) setResolving(false);
        });
        return () => { cancelled = true; };
    }, [tab, page, visibleItems.map(item => item.id).join('|')]);

    const stopPlayback = useCallback(() => {
        audioRef.current?.pause();
        setPlayingId(null);
        if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = null;
        }
    }, []);

    const playVoice = async (item: VoiceFavorite) => {
        setAudioError(null);
        if (playingId === item.id) {
            stopPlayback();
            return;
        }
        stopPlayback();
        const blob = await getVoiceFavoriteBlob(item.id);
        if (!blob) {
            setAudioError('这条收藏的音频文件缺失，请回到来源重新收藏。');
            return;
        }
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        const audio = audioRef.current || new Audio();
        audioRef.current = audio;
        audio.src = url;
        audio.onended = stopPlayback;
        audio.onerror = () => {
            stopPlayback();
            setAudioError('音频暂时无法播放。');
        };
        try {
            await audio.play();
            setPlayingId(item.id);
        } catch {
            stopPlayback();
            setAudioError('浏览器阻止了播放，请再点一次。');
        }
    };

    const removeVoice = async (item: VoiceFavorite) => {
        if (playingId === item.id) stopPlayback();
        await removeVoiceFavoriteById(item.id);
        setVoiceItems(previous => previous.filter(candidate => candidate.id !== item.id));
    };

    const removeContent = async (item: ContentFavorite) => {
        await removeContentFavoriteById(item.id);
        setContentItems(previous => previous.filter(candidate => candidate.id !== item.id));
        setResolvedItems(previous => {
            const next = { ...previous };
            delete next[item.id];
            return next;
        });
    };

    const tabs: Array<{ value: FavoriteTab; label: string; count: number; icon: React.ReactNode }> = [
        { value: 'chat', label: '聊天', count: chatItems.length, icon: <ChatCircleDots size={16} weight="fill" /> },
        { value: 'voice', label: '语音', count: voiceItems.length, icon: <Waveform size={16} weight="bold" /> },
        { value: 'image', label: '图片', count: imageItems.length, icon: <Image size={16} weight="fill" /> },
    ];

    const renderChat = () => (visibleItems as ContentFavorite[]).map(item => {
        if (item.kind !== 'chat') return null;
        const resolved = resolvedItems[item.id];
        const message = resolved && 'message' in resolved ? resolved.message : null;
        const sourceAvailable = !!(resolved && 'sourceAvailable' in resolved && resolved.sourceAvailable);
        const missing = !!resolved && !message;
        return (
            <article key={item.id} className="favorite-row flex gap-3 py-4 border-b border-slate-900/10">
                <button
                    type="button"
                    disabled={!sourceAvailable || !onJumpToMessage}
                    onClick={() => sourceAvailable && onJumpToMessage?.(item.charId, item.messageId)}
                    className="min-w-0 flex-1 text-left disabled:cursor-default"
                >
                    <div className="flex items-center gap-2 text-[10px] text-slate-500">
                        <span className="font-bold text-slate-700">{item.charName}</span>
                        <span className="px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">{messageTypeLabel(message?.type)}</span>
                        <time>{formatTime(item.sourceTimestamp)}</time>
                    </div>
                    {message ? (
                        <p className="mt-2 text-[14px] leading-6 text-slate-800 whitespace-pre-wrap break-words line-clamp-4">
                            {message.content || '（无文字内容）'}
                        </p>
                    ) : missing ? (
                        <p className="mt-2 text-[12px] text-rose-500">旧版收藏没有可恢复的内容</p>
                    ) : (
                        <p className="mt-2 text-[12px] text-slate-400">正在读取原消息…</p>
                    )}
                    {message && !sourceAvailable && <p className="mt-2 text-[10px] font-bold text-amber-700">原消息已删除 · 内容由收藏保留</p>}
                    {sourceAvailable && onJumpToMessage && <p className="mt-2 text-[10px] font-bold text-violet-600">点按跳回原聊天</p>}
                </button>
                <button type="button" onClick={() => void removeContent(item)} className="self-start shrink-0 w-9 h-9 grid place-items-center rounded-full text-slate-400 active:bg-rose-50 active:text-rose-500" aria-label="取消收藏">
                    <Trash size={16} />
                </button>
            </article>
        );
    });

    const renderVoice = () => (visibleItems as VoiceFavorite[]).map(item => {
        const secondary = item.translation || item.spokenText;
        const showSecondary = !!secondary && secondary.trim() !== item.originalText.trim();
        const active = playingId === item.id;
        return (
            <article key={item.id} className="favorite-row flex gap-3 py-4 border-b border-slate-900/10">
                <button type="button" onClick={() => void playVoice(item)} className={`mt-0.5 shrink-0 w-11 h-11 grid place-items-center rounded-full transition-colors ${active ? 'bg-amber-500 text-white' : 'bg-slate-800 text-white active:bg-slate-700'}`} aria-label={active ? '暂停' : '播放'}>
                    {active ? <Pause size={17} weight="fill" /> : <Play size={17} weight="fill" className="ml-0.5" />}
                </button>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[10px] text-slate-500">
                        <span className="font-bold text-slate-700">{item.charName}</span>
                        <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{voiceFavoriteSourceLabel(item.source)}</span>
                        <time>{formatTime(item.sourceTimestamp)}</time>
                    </div>
                    <p className="mt-2 text-[14px] leading-6 text-slate-800 whitespace-pre-wrap break-words">{item.originalText || item.spokenText || '（无文字）'}</p>
                    {showSecondary && <p className="mt-1 text-[12px] leading-5 text-slate-500 whitespace-pre-wrap break-words"><span className="mr-1.5 text-[10px] font-bold text-amber-700">{item.translation ? '翻译' : '语音'}</span>{secondary}</p>}
                </div>
                <button type="button" onClick={() => void removeVoice(item)} className="self-start shrink-0 w-9 h-9 grid place-items-center rounded-full text-slate-400 active:bg-rose-50 active:text-rose-500" aria-label="取消收藏">
                    <Trash size={16} />
                </button>
            </article>
        );
    });

    const renderImages = () => (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 py-3">
            {(visibleItems as ContentFavorite[]).map(item => {
                if (item.kind !== 'image') return null;
                const resolved = resolvedItems[item.id];
                const imageUrl = resolved && 'imageUrl' in resolved ? resolved.imageUrl : null;
                const reference = resolved && 'reference' in resolved ? resolved.reference : null;
                const ready = !!resolved;
                return (
                    <article key={item.id} className="relative rounded-2xl overflow-hidden bg-white border border-slate-900/10 shadow-sm">
                        <button type="button" disabled={!imageUrl} onClick={() => imageUrl && setPreviewImage(imageUrl)} className="block w-full aspect-square bg-slate-100 disabled:cursor-default">
                            {imageUrl ? (
                                <img src={imageUrl} alt="收藏图片" className="w-full h-full object-cover" loading="lazy" />
                            ) : (
                                <span className="h-full grid place-items-center px-4 text-center text-[11px] leading-5 text-slate-400">
                                    {ready ? '原图片已删除或未随备份恢复' : '正在读取原图片…'}
                                </span>
                            )}
                        </button>
                        <div className="p-2.5 pr-10">
                            <div className="truncate text-[11px] font-bold text-slate-700">{item.charName}</div>
                            <div className="mt-0.5 text-[9px] text-slate-400">{formatTime(item.sourceTimestamp)} · {reference?.source === 'gallery' ? '相册引用' : reference?.source === 'chat' ? '聊天引用' : '收藏保留'}</div>
                            {reference?.source === 'chat' && onJumpToMessage && (
                                <button type="button" onClick={() => onJumpToMessage(reference.charId, reference.messageId)} className="mt-1.5 text-[10px] font-bold text-violet-600">查看原聊天</button>
                            )}
                        </div>
                        <button type="button" onClick={() => void removeContent(item)} className="absolute right-1.5 bottom-1.5 w-8 h-8 grid place-items-center rounded-full bg-white/90 text-slate-400 shadow-sm active:text-rose-500" aria-label="取消收藏">
                            <Trash size={14} />
                        </button>
                    </article>
                );
            })}
        </div>
    );

    const emptyText = tab === 'chat'
        ? '长按有意义的聊天消息，就能收藏到这里。'
        : tab === 'voice'
            ? '在聊天、通话或见面里长按语音，就能收藏到这里。'
            : '在聊天或相册里收藏图片；这里只保存引用，不复制图片。';

    const portal = (
        <div className="favorites-root">
            <style>{`
                .favorites-root { position: fixed; inset: 0; z-index: 1650; overflow: hidden; color: #172033; background: #f4f1eb; font-family: ui-sans-serif, system-ui, -apple-system, "PingFang SC", sans-serif; animation: favoritesEnter .22s ease-out both; }
                .favorites-shell { height: 100%; max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; }
                .favorites-list { scrollbar-width: none; }
                .favorites-list::-webkit-scrollbar { display: none; }
                .favorite-row { animation: favoriteRowEnter .18s ease both; }
                @keyframes favoritesEnter { from { opacity: 0; } to { opacity: 1; } }
                @keyframes favoriteRowEnter { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
                @media (prefers-reduced-motion: reduce) { .favorites-root, .favorite-row { animation: none !important; } }
            `}</style>
            <div className="favorites-shell px-4 sm:px-7">
                <header className="shrink-0 pt-[max(16px,env(safe-area-inset-top))] pb-3 border-b border-slate-900/10">
                    <div className="flex items-center justify-between gap-4 h-12">
                        <button type="button" onClick={onClose} className="w-10 h-10 -ml-1 grid place-items-center rounded-full text-slate-600 active:bg-black/5" aria-label="关闭收藏">
                            <X size={21} weight="bold" />
                        </button>
                        <div className="min-w-0 text-center">
                            <h1 className="text-[17px] font-bold tracking-[.12em]">收藏</h1>
                            <p className="mt-0.5 text-[10px] text-slate-500">聊天 {chatItems.length} · 语音 {voiceItems.length} · 图片 {imageItems.length}</p>
                        </div>
                        <Star size={20} weight="fill" className="w-10 text-amber-500" />
                    </div>
                    <div className="grid grid-cols-3 gap-1.5 mt-2 rounded-2xl bg-slate-900/5 p-1" role="tablist" aria-label="收藏分类">
                        {tabs.map(option => (
                            <button key={option.value} type="button" onClick={() => setTab(option.value)} className={`h-9 rounded-xl flex items-center justify-center gap-1.5 text-[11px] font-bold transition-colors ${tab === option.value ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'}`}>
                                {option.icon}<span>{option.label}</span><span className="text-[9px] opacity-60">{option.count}</span>
                            </button>
                        ))}
                    </div>
                    {tab === 'voice' && (
                        <div className="flex items-center justify-center gap-1 mt-2" role="tablist" aria-label="按语音来源筛选">
                            {voiceFilters.map(option => (
                                <button type="button" key={option.value} onClick={() => setVoiceFilter(option.value)} className={`px-2.5 py-1 rounded-full text-[10px] font-bold transition-colors ${voiceFilter === option.value ? 'bg-slate-800 text-white' : 'text-slate-500 active:bg-black/5'}`}>{option.label}</button>
                            ))}
                        </div>
                    )}
                </header>

                <main className="favorites-list flex-1 min-h-0 overflow-y-auto">
                    {loading ? (
                        <div className="h-full grid place-items-center text-sm text-slate-400">正在整理收藏…</div>
                    ) : visibleItems.length === 0 ? (
                        <div className="h-full min-h-64 grid place-items-center text-center px-8">
                            <div>
                                {tab === 'chat' ? <ChatCircleDots size={34} className="mx-auto text-slate-300" /> : tab === 'voice' ? <Waveform size={34} className="mx-auto text-slate-300" /> : <Image size={34} className="mx-auto text-slate-300" />}
                                <p className="mt-4 text-sm font-bold text-slate-500">这里还没有{tab === 'chat' ? '聊天收藏' : tab === 'voice' ? '语音' : '图片'}</p>
                                <p className="mt-1.5 text-xs leading-5 text-slate-400">{emptyText}</p>
                            </div>
                        </div>
                    ) : tab === 'chat' ? renderChat() : tab === 'voice' ? renderVoice() : renderImages()}
                    {resolving && tab !== 'voice' && <div className="py-2 text-center text-[10px] text-slate-400">正在核对原始内容…</div>}
                </main>

                {audioError && <div className="shrink-0 py-2 text-center text-[11px] text-rose-600">{audioError}</div>}
                <footer className="shrink-0 min-h-[62px] pb-[max(12px,env(safe-area-inset-bottom))] pt-2 border-t border-slate-900/10 flex items-center justify-between">
                    <button type="button" disabled={page === 0} onClick={() => setPage(value => Math.max(0, value - 1))} className="w-10 h-10 grid place-items-center rounded-full text-slate-600 disabled:opacity-20 active:bg-black/5" aria-label="上一页"><CaretLeft size={18} weight="bold" /></button>
                    <span className="text-[11px] tabular-nums text-slate-500">第 {page + 1} / {pageCount} 页 · 每页 {PAGE_SIZE} 条</span>
                    <button type="button" disabled={page >= pageCount - 1} onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))} className="w-10 h-10 grid place-items-center rounded-full text-slate-600 disabled:opacity-20 active:bg-black/5" aria-label="下一页"><CaretRight size={18} weight="bold" /></button>
                </footer>
            </div>

            {previewImage && (
                <div className="absolute inset-0 z-20 bg-black/95 grid place-items-center p-3" onClick={() => setPreviewImage(null)}>
                    <button type="button" onClick={() => setPreviewImage(null)} className="absolute top-[max(16px,env(safe-area-inset-top))] right-4 w-10 h-10 grid place-items-center rounded-full bg-white/10 text-white" aria-label="关闭图片预览"><X size={22} /></button>
                    <img src={previewImage} alt="收藏图片预览" className="max-w-full max-h-full object-contain" onClick={event => event.stopPropagation()} />
                </div>
            )}
        </div>
    );

    return createPortal(portal, document.body);
};

export default FavoritesPortal;
