import React, { useCallback, useEffect, useRef, useState } from 'react';
import { attachAudioMirrorFallback } from '../../../utils/assetUrl';

export type QixiBGMGroup = 'fall' | 'explore' | 'otherSide' | 'bridge';

export const QIXI_BGM_GROUPS: Record<QixiBGMGroup, string[]> = {
    fall: [
        'bgm/qixi/01/02_0_褪色客厅.mp3',
        'bgm/qixi/01/1_0_褪色客厅.mp3',
    ],
    explore: [
        'bgm/qixi/02/01_0_旧钟房间.mp3',
        'bgm/qixi/02/02_0_旧钟房间.mp3',
    ],
    otherSide: [
        'bgm/qixi/03/01_0_鹊桥月色.mp3',
        'bgm/qixi/03/03_0_月下双向.mp3',
    ],
    bridge: [
        'bgm/qixi/04/01_0_鹊桥释然.mp3',
        'bgm/qixi/04/02_0_鹊桥释然.mp3',
        'bgm/qixi/04/03_0_风铃之约.mp3',
    ],
};

const MUTED_KEY = 'sullyos_qixi_bgm_muted';
const TARGET_VOLUME = 0.32;
const FADE_MS = 1100;

type QixiAudioTrack = Pick<HTMLAudioElement, 'currentTime' | 'pause' | 'volume'>;

// The activity can briefly mount more than one view while a scene is changing.
// Keep one module-wide owner so an outgoing view can never keep playing under
// the incoming room's track.
let activeQixiBGMTrack: QixiAudioTrack | null = null;

export const stopQixiBGMTrack = (audio: QixiAudioTrack): void => {
    audio.pause();
    audio.volume = 0;
    try { audio.currentTime = 0; } catch { /* unloaded audio may not be seekable yet */ }
};

export const claimQixiBGMTrack = (audio: QixiAudioTrack): void => {
    if (activeQixiBGMTrack && activeQixiBGMTrack !== audio) stopQixiBGMTrack(activeQixiBGMTrack);
    activeQixiBGMTrack = audio;
};

export const releaseQixiBGMTrack = (audio: QixiAudioTrack): void => {
    if (activeQixiBGMTrack === audio) activeQixiBGMTrack = null;
};

const ownsQixiBGM = (audio: QixiAudioTrack): boolean => activeQixiBGMTrack === audio;

export const prepareQixiBGMFadeIn = (audio: Pick<HTMLAudioElement, 'volume'>): void => {
    audio.volume = 0;
};

export const qixiStageToBGMGroup = (stage: string, sceneIndex: number): QixiBGMGroup | null => {
    if (['fakeChat', 'distort', 'entry'].includes(stage)) return 'fall';
    if (stage === 'scene' || stage === 'sceneTransition') {
        if (sceneIndex <= 0) return 'fall';
        if (sceneIndex <= 3) return 'explore';
        return 'otherSide';
    }
    if (['bridgeLoading', 'bridge', 'bridgeCrossing', 'reunionLoading', 'reunion', 'touch', 'ending'].includes(stage)) return 'bridge';
    return null;
};

const pickOne = <T,>(items: T[]): T | undefined => items[Math.floor(Math.random() * items.length)];

export function useQixiBGM(stage: string, sceneIndex: number) {
    const group = qixiStageToBGMGroup(stage, sceneIndex);
    const [muted, setMuted] = useState(() => {
        try { return localStorage.getItem(MUTED_KEY) === '1'; } catch { return false; }
    });
    const audiosRef = useRef<Partial<Record<QixiBGMGroup, HTMLAudioElement>>>({});
    const cleanupRef = useRef<Array<() => void>>([]);
    const fadeTimersRef = useRef<Map<HTMLAudioElement, number>>(new Map());
    const activeGroupRef = useRef<QixiBGMGroup | null>(null);
    const handledInitialMuteRef = useRef(false);
    const mutedRef = useRef(muted);
    mutedRef.current = muted;

    const clearFade = useCallback((audio: HTMLAudioElement) => {
        const timer = fadeTimersRef.current.get(audio);
        if (!timer) return;
        window.clearInterval(timer);
        fadeTimersRef.current.delete(audio);
    }, []);

    const stopImmediately = useCallback((audio: HTMLAudioElement) => {
        clearFade(audio);
        stopQixiBGMTrack(audio);
        releaseQixiBGMTrack(audio);
    }, [clearFade]);

    const fade = useCallback((audio: HTMLAudioElement, target: number, duration = FADE_MS) => {
        clearFade(audio);
        const steps = 14;
        const start = audio.volume;
        let step = 0;
        const timer = window.setInterval(() => {
            if (target > 0 && !ownsQixiBGM(audio)) {
                window.clearInterval(timer);
                fadeTimersRef.current.delete(audio);
                stopQixiBGMTrack(audio);
                return;
            }
            step += 1;
            audio.volume = Math.max(0, Math.min(1, start + (target - start) * (step / steps)));
            if (step < steps) return;
            window.clearInterval(timer);
            fadeTimersRef.current.delete(audio);
            if (target === 0) audio.pause();
        }, duration / steps);
        fadeTimersRef.current.set(audio, timer);
    }, [clearFade]);

    useEffect(() => {
        (Object.keys(QIXI_BGM_GROUPS) as QixiBGMGroup[]).forEach(key => {
            const path = pickOne(QIXI_BGM_GROUPS[key]);
            if (!path) return;
            const audio = new Audio();
            audio.loop = true;
            audio.preload = 'auto';
            audio.volume = 0;
            cleanupRef.current.push(attachAudioMirrorFallback(audio, path));
            audio.load();
            audiosRef.current[key] = audio;
        });
        return () => {
            fadeTimersRef.current.forEach(timer => window.clearInterval(timer));
            fadeTimersRef.current.clear();
            cleanupRef.current.forEach(cleanup => cleanup());
            cleanupRef.current = [];
            Object.values(audiosRef.current).forEach(audio => {
                if (!audio) return;
                stopImmediately(audio);
                audio.removeAttribute('src');
                audio.load();
            });
            audiosRef.current = {};
        };
    }, [stopImmediately]);

    useEffect(() => {
        activeGroupRef.current = group;
        let retry: (() => void) | undefined;
        const playCurrent = (audio: HTMLAudioElement) => {
            if (!group || activeGroupRef.current !== group || mutedRef.current) return;
            claimQixiBGMTrack(audio);
            prepareQixiBGMFadeIn(audio);
            audio.play().then(() => {
                if (activeGroupRef.current !== group || mutedRef.current || !ownsQixiBGM(audio)) {
                    stopImmediately(audio);
                    return;
                }
                fade(audio, TARGET_VOLUME);
            }).catch(error => {
                if (error?.name !== 'NotAllowedError') return;
                retry = () => {
                    if (activeGroupRef.current !== group || mutedRef.current) return;
                    claimQixiBGMTrack(audio);
                    prepareQixiBGMFadeIn(audio);
                    audio.play().then(() => {
                        if (activeGroupRef.current === group && !mutedRef.current && ownsQixiBGM(audio)) fade(audio, TARGET_VOLUME);
                        else stopImmediately(audio);
                    }).catch(() => undefined);
                };
                document.addEventListener('pointerdown', retry, { once: true, passive: true });
                document.addEventListener('keydown', retry, { once: true });
            });
        };
        (Object.keys(audiosRef.current) as QixiBGMGroup[]).forEach(key => {
            const audio = audiosRef.current[key];
            if (!audio) return;
            if (key !== group) stopImmediately(audio);
        });
        const current = group ? audiosRef.current[group] : undefined;
        if (current && !mutedRef.current) playCurrent(current);
        return () => {
            if (!retry) return;
            document.removeEventListener('pointerdown', retry);
            document.removeEventListener('keydown', retry);
        };
    }, [fade, group, stopImmediately]);

    useEffect(() => {
        try { localStorage.setItem(MUTED_KEY, muted ? '1' : '0'); } catch { /* optional */ }
        if (!handledInitialMuteRef.current) {
            handledInitialMuteRef.current = true;
            return;
        }
        const activeGroup = activeGroupRef.current;
        const current = activeGroup ? audiosRef.current[activeGroup] : undefined;
        if (!current) return;
        if (muted) {
            fade(current, 0, 450);
            return;
        }
        claimQixiBGMTrack(current);
        prepareQixiBGMFadeIn(current);
        current.play().then(() => {
            if (!mutedRef.current && activeGroupRef.current === activeGroup && ownsQixiBGM(current)) fade(current, TARGET_VOLUME, 450);
            else stopImmediately(current);
        }).catch(() => undefined);
    }, [fade, muted, stopImmediately]);

    return { group, muted, toggleMuted: useCallback(() => setMuted(value => !value), []) };
}

export const QixiBGMToggle: React.FC<{ muted: boolean; onToggle: () => void }> = ({ muted, onToggle }) => (
    <button type="button" className={`q7-bgm ${muted ? 'is-muted' : ''}`} onClick={onToggle} aria-label={muted ? '播放七夕背景音乐' : '静音七夕背景音乐'} title={muted ? '播放 BGM' : '静音 BGM'}>
        <i>{muted ? '×' : '♪'}</i><span>{muted ? 'BGM OFF' : 'BGM'}</span>
    </button>
);
