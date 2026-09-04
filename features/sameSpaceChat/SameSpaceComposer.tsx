import React, { useEffect, useState } from 'react';
import { Clock, PersonSimpleWalk, Pause, Play, X } from '@phosphor-icons/react';
import type { SameSpaceChatState } from './model';
import {
    advanceSameSpaceTime,
    formatSameSpaceSceneTime,
    pauseSameSpaceTime,
    resumeSameSpaceTime,
} from './model';

// SAME_SPACE_CHAT: self-contained composer chrome; removing the feature deletes this component wholesale.
export interface SameSpaceComposerProps {
    state: SameSpaceChatState;
    actionDraft: string;
    setActionDraft: (value: string) => void;
    onStateChange: (state: SameSpaceChatState) => void;
    onEnd: () => void;
    dark?: boolean;
    pixel?: boolean;
}

const SameSpaceComposer: React.FC<SameSpaceComposerProps> = ({
    state,
    actionDraft,
    setActionDraft,
    onStateChange,
    onEnd,
    dark = false,
    pixel = false,
}) => {
    const [editingAction, setEditingAction] = useState(false);
    const [showClock, setShowClock] = useState(false);
    const [, refreshClock] = useState(0);

    useEffect(() => {
        if (state.timeMode !== 'realtime') return;
        const timer = window.setInterval(() => refreshClock(value => value + 1), 30_000);
        return () => window.clearInterval(timer);
    }, [state.timeMode]);

    const surface = pixel
        ? 'border-[#8f674a]/35 bg-[#fff7ed] text-[#6a4c35] rounded-[4px]'
        : dark
          ? 'border-white/10 bg-slate-800 text-slate-200'
          : 'border-violet-100 bg-violet-50/70 text-slate-600';

    return (
        <div className={`same-space-composer mx-4 mt-2 overflow-hidden rounded-2xl border ${surface}`}>
            <div className="flex items-center gap-2 px-3 py-2">
                <PersonSimpleWalk className="h-4 w-4 shrink-0 text-violet-500" weight="bold" />
                <button type="button" onClick={() => setEditingAction(value => !value)} className="min-w-0 flex-1 text-left">
                    <span className="block text-[11px] font-bold">同处聊天</span>
                    <span className="block truncate text-[10px] opacity-65">
                        {actionDraft ? `动作：${actionDraft}` : '点这里补充你的动作（可不填）'}
                    </span>
                </button>
                <button type="button" onClick={() => setShowClock(value => !value)} className="flex items-center gap-1 rounded-full bg-white/60 px-2 py-1 text-[10px] font-medium">
                    <Clock className="h-3.5 w-3.5" />
                    {formatSameSpaceSceneTime(state)}
                </button>
                <button type="button" onClick={onEnd} aria-label="结束同处聊天" className="grid h-7 w-7 place-items-center rounded-full bg-white/60 text-slate-400">
                    <X className="h-3.5 w-3.5" weight="bold" />
                </button>
            </div>
            {editingAction && (
                <div className="border-t border-current/10 px-3 py-2">
                    <textarea
                        rows={2}
                        value={actionDraft}
                        onChange={event => setActionDraft(event.target.value)}
                        placeholder="只写你的动作，例如：把热咖啡推到他手边"
                        className="w-full resize-none rounded-xl border border-current/10 bg-white/75 px-3 py-2 text-[13px] text-slate-700 outline-none placeholder:text-slate-400"
                    />
                    <div className="mt-1 text-[9px] opacity-55">发送时会和台词分成两个气泡，但只让角色回复一次。</div>
                </div>
            )}
            {showClock && (
                <div className="flex items-center gap-2 border-t border-current/10 px-3 py-2 text-[10px]">
                    <button type="button" onClick={() => onStateChange(state.timeMode === 'paused' ? resumeSameSpaceTime(state) : pauseSameSpaceTime(state))} className="flex items-center gap-1 rounded-full bg-white/70 px-2.5 py-1.5 font-bold">
                        {state.timeMode === 'paused' ? <Play className="h-3 w-3" weight="fill" /> : <Pause className="h-3 w-3" weight="fill" />}
                        {state.timeMode === 'paused' ? '继续' : '暂停'}
                    </button>
                    <button type="button" onClick={() => onStateChange(advanceSameSpaceTime(state, 5))} className="rounded-full bg-white/70 px-2.5 py-1.5 font-bold">+5 分钟</button>
                    <button type="button" onClick={() => onStateChange(advanceSameSpaceTime(state, 10))} className="rounded-full bg-white/70 px-2.5 py-1.5 font-bold">+10 分钟</button>
                </div>
            )}
        </div>
    );
};

export default SameSpaceComposer;
