import React from 'react';

// SAME_SPACE_CHAT: only messages carrying metadata.sameSpaceAction use this presentation.
const SameSpaceActionBubble: React.FC<{ content: string; isUser: boolean }> = ({ content, isUser }) => (
    <div
        className={`same-space-action max-w-[72vw] rounded-2xl border px-3.5 py-2.5 text-[13px] italic leading-relaxed shadow-sm ${
            isUser
                ? 'border-violet-200/70 bg-violet-50/90 text-violet-900'
                : 'border-slate-200/80 bg-white/80 text-slate-600'
        }`}
    >
        （{String(content || '').trim().replace(/^[（(]|[）)]$/g, '')}）
    </div>
);

export default SameSpaceActionBubble;
