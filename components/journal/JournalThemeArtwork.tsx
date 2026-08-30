import React from 'react';
import type { JournalAppearancePresetId } from '../../types';

export type JournalScene = 'select' | 'calendar' | 'write';

interface JournalThemeArtworkProps {
    preset?: JournalAppearancePresetId;
    scene: JournalScene;
}

/**
 * 主题自己的“物件层”。这些不是背景图片，而是会随页面一起重排的 SVG / DOM 部件：
 * 邮件路线、星盘、标本页和复古编辑器线路分别拥有独立图形语言。
 */
export const JournalThemeArtwork: React.FC<JournalThemeArtworkProps> = ({ preset = 'original', scene }) => {
    if (preset === 'original') return null;

    if (preset === 'letterpress') {
        return (
            <div className={`sully-journal-theme-art sully-journal-theme-art-letterpress sully-journal-theme-art-${scene}`} aria-hidden="true">
                <svg className="sully-journal-post-route" viewBox="0 0 900 520" preserveAspectRatio="none">
                    <path d="M-24 412C118 278 194 482 326 329S561 81 925 164" />
                    <circle cx="116" cy="332" r="10" /><circle cx="326" cy="329" r="10" /><circle cx="704" cy="128" r="10" />
                    <path className="sully-journal-post-plane" d="m688 106 59 20-68 34 11-25-22-14Z" />
                </svg>
                <div className="sully-journal-postmark"><b>SULLY POST</b><span>EXCHANGE</span><i /></div>
                <div className="sully-journal-envelope-corner" />
                <div className="sully-journal-airmail-stripe" />
            </div>
        );
    }

    if (preset === 'sakura') {
        return (
            <div className={`sully-journal-theme-art sully-journal-theme-art-sakura sully-journal-theme-art-${scene}`} aria-hidden="true">
                <svg className="sully-journal-celestial-map" viewBox="0 0 900 620" preserveAspectRatio="none">
                    <g className="sully-journal-orbits">
                        <ellipse cx="450" cy="305" rx="318" ry="172" transform="rotate(-13 450 305)" />
                        <ellipse cx="450" cy="305" rx="224" ry="290" transform="rotate(24 450 305)" />
                        <path d="M91 415C241 148 540 82 806 274" />
                    </g>
                    <g className="sully-journal-constellation">
                        <path d="m146 203 93 46 68-103 92 78 117-91 82 118 125-57" />
                        {[['146','203'],['239','249'],['307','146'],['399','224'],['516','133'],['598','251'],['723','194']].map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="6" />)}
                    </g>
                </svg>
                <div className="sully-journal-star-medallion"><i /><b>✦</b><span /></div>
                <div className="sully-journal-photo-corners"><i /><i /><i /><i /></div>
                <div className="sully-journal-satin-ribbon">MEMORY / 02</div>
            </div>
        );
    }

    if (preset === 'forest') {
        return (
            <div className={`sully-journal-theme-art sully-journal-theme-art-forest sully-journal-theme-art-${scene}`} aria-hidden="true">
                <svg className="sully-journal-botanical-sheet" viewBox="0 0 900 620" preserveAspectRatio="none">
                    <path className="sully-journal-botanical-stem" d="M716 620C678 479 736 388 686 263S662 89 702-14" />
                    <path d="M697 464c-92-48-104-113-101-158 73 23 108 82 101 158Z" />
                    <path d="M688 328c70-41 93-100 89-145-68 19-94 73-89 145Z" />
                    <path d="M689 249c-65-42-73-93-65-131 59 21 80 70 65 131Z" />
                    <g className="sully-journal-measure-lines"><path d="M96 126h236M96 149h148M96 172h198" /><path d="M125 410h242M125 433h164" /></g>
                    <path className="sully-journal-specimen-arrow" d="M380 230c102-71 175-38 229 20m-20-29 20 29-32 4" />
                </svg>
                <div className="sully-journal-field-rings">{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</div>
                <div className="sully-journal-field-tabs"><i>A</i><i>B</i><i>C</i><i>D</i></div>
                <div className="sully-journal-specimen-seal"><b>FIELD</b><span>No. 0822</span></div>
            </div>
        );
    }

    return (
        <div className={`sully-journal-theme-art sully-journal-theme-art-midnight sully-journal-theme-art-${scene}`} aria-hidden="true">
            <svg className="sully-journal-memory-circuit" viewBox="0 0 900 620" preserveAspectRatio="none">
                <path d="M-20 168h138v-63h139v129h146v-92h128v163h175v-82h215" />
                <path d="M48 511h172v-76h132v61h211v-134h151v84h208" />
                <g>{[[118,168],[257,105],[403,234],[531,142],[706,305],[220,435],[352,496],[563,362],[714,446]].map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="9" />)}</g>
            </svg>
            <div className="sully-journal-window-chrome"><i /><i /><i /><span>MEMORY_EDITOR.EXE</span></div>
            <div className="sully-journal-inspector-ghost"><b>OBJECT</b><i /><i /><i /><span>VER 08.22</span></div>
            <div className="sully-journal-cursor-spark">✣</div>
        </div>
    );
};

export const JournalThemeThumbnail: React.FC<{ preset: JournalAppearancePresetId }> = ({ preset }) => {
    if (preset === 'original') {
        return <div className="h-11 overflow-hidden rounded-lg border border-amber-200 bg-amber-50 p-2"><div className="h-full rounded-r-md border-l-4 border-amber-700 bg-white shadow-sm" /></div>;
    }
    if (preset === 'letterpress') {
        return <svg className="h-11 w-full rounded-lg bg-[#e7d7ba]" viewBox="0 0 150 48" aria-hidden="true"><path fill="#f5ead2" stroke="#765746" d="M9 8h132v32H9z"/><path fill="none" stroke="#a84f3d" strokeDasharray="3 2" d="M18 30C49 8 72 43 111 16"/><circle cx="115" cy="15" r="9" fill="none" stroke="#a84f3d" strokeWidth="2"/><path fill="#35565b" d="M18 14h47v4H18zm0 7h31v3H18z"/></svg>;
    }
    if (preset === 'sakura') {
        return <svg className="h-11 w-full rounded-lg bg-[#11182d]" viewBox="0 0 150 48" aria-hidden="true"><path fill="#27315e" stroke="#d5b06d" d="M8 5h134v38H8z"/><path fill="#f1ead8" d="M78 9h51v31H78z"/><path fill="#7587d9" d="M83 14h41v18H83z"/><path fill="none" stroke="#d5b06d" d="M17 34C38 7 58 12 74 27M20 13l16 8 12-12 18 13"/><circle cx="20" cy="13" r="2" fill="#fff"/><circle cx="36" cy="21" r="2" fill="#fff"/><circle cx="48" cy="9" r="2" fill="#fff"/></svg>;
    }
    if (preset === 'forest') {
        return <svg className="h-11 w-full rounded-lg bg-[#c98a57]" viewBox="0 0 150 48" aria-hidden="true"><path fill="#f0d3a2" stroke="#7b482e" d="M9 5h132v38H9z"/><path fill="none" stroke="#7b482e" strokeWidth="3" d="M75 5v38"/>{[12,20,28,36].map(y => <ellipse key={y} cx="75" cy={y} rx="7" ry="2.5" fill="none" stroke="#6d4c3a"/>)}<path fill="none" stroke="#7f8d4f" d="M111 42c-9-17 4-22-1-37m1 22c-11-5-13-10-12-15m12 8c9-4 12-10 11-14"/><path fill="#b55e3d" d="M131 9h13v6h-13zm0 8h16v6h-16zm0 8h12v6h-12z"/></svg>;
    }
    return <svg className="h-11 w-full rounded-lg bg-[#e8edff]" viewBox="0 0 150 48" aria-hidden="true"><path fill="#f9faff" stroke="#7892d7" strokeWidth="2" d="M7 5h136v38H7z"/><path fill="#7892d7" d="M7 5h136v7H7z"/><circle cx="13" cy="8.5" r="2" fill="#fff"/><circle cx="20" cy="8.5" r="2" fill="#fff"/><path fill="none" stroke="#9eb1e7" d="M17 20h72v17H17zm79-6h37v23H96zM22 25h52m-52 5h37"/><path fill="none" stroke="#7892d7" d="M0 31h12v-8h8m114 12h17"/></svg>;
};

export default JournalThemeArtwork;
