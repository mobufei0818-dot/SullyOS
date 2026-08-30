import React, { useEffect } from 'react';
import type { ScheduleChangeEventDetail } from '../../utils/scheduleChange';

interface ScheduleChangeNoticeProps {
    detail: ScheduleChangeEventDetail;
    onDone: () => void;
}

/** ChatApp 顶部短暂浮出的日程修订回执；全部零件都有稳定白框 CSS 钩子。 */
const ScheduleChangeNotice: React.FC<ScheduleChangeNoticeProps> = ({ detail, onDone }) => {
    useEffect(() => {
        const timer = window.setTimeout(onDone, 4300);
        return () => window.clearTimeout(timer);
    }, [detail.eventId, onDone]);

    return (
        <>
            <style>{`
                @keyframes sullyScheduleChangeInOut {
                    0% { opacity:0; transform:translate3d(-50%,-14px,0) scale(.96); }
                    11%,82% { opacity:1; transform:translate3d(-50%,0,0) scale(1); }
                    100% { opacity:0; transform:translate3d(-50%,-6px,0) scale(.985); }
                }
                @keyframes sullyScheduleChangeShine {
                    0%,14% { transform:translateX(-130%) skewX(-18deg); opacity:0; }
                    28% { opacity:.7; }
                    45%,100% { transform:translateX(240%) skewX(-18deg); opacity:0; }
                }
                :where(.sully-schedule-change) {
                    position:absolute; z-index:185; top:calc(var(--safe-top) + 66px); left:50%;
                    width:min(340px,calc(100% - 28px)); overflow:hidden; pointer-events:none;
                    padding:11px 13px 12px; border:1px solid rgba(255,255,255,.78); border-radius:18px;
                    color:#243047; background:rgba(255,255,255,.92);
                    box-shadow:0 14px 34px -18px rgba(15,23,42,.48),0 0 0 1px hsla(var(--primary-hue),70%,55%,.10);
                    backdrop-filter:blur(14px); animation:sullyScheduleChangeInOut 4.2s cubic-bezier(.2,.8,.2,1) both;
                }
                :where(.sully-schedule-change-head) { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
                :where(.sully-schedule-change-mark) {
                    display:grid; place-items:center; width:23px; height:23px; flex:none; border-radius:8px;
                    color:white; background:hsla(var(--primary-hue),68%,54%,1); font-size:12px; font-weight:900;
                    box-shadow:0 5px 12px -7px hsla(var(--primary-hue),75%,35%,.8);
                }
                :where(.sully-schedule-change-kicker) { font-size:11px; font-weight:750; letter-spacing:.08em; }
                :where(.sully-schedule-change-count) { margin-left:auto; color:#94a3b8; font-size:9px; }
                :where(.sully-schedule-change-list) { display:grid; gap:6px; }
                :where(.sully-schedule-change-row) {
                    display:grid; grid-template-columns:40px minmax(0,1fr) 15px minmax(0,1.15fr); align-items:center; gap:5px;
                    min-height:27px; padding:5px 7px; border-radius:11px; background:hsla(var(--primary-hue),72%,55%,.065);
                }
                :where(.sully-schedule-change-time) { color:hsla(var(--primary-hue),55%,42%,1); font-size:10px; font-weight:800; }
                :where(.sully-schedule-change-before), :where(.sully-schedule-change-after) {
                    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px;
                }
                :where(.sully-schedule-change-before) { color:#94a3b8; text-decoration:line-through; text-decoration-thickness:1px; }
                :where(.sully-schedule-change-arrow) { color:hsla(var(--primary-hue),62%,52%,.72); text-align:center; font-size:11px; }
                :where(.sully-schedule-change-after) { color:#334155; font-weight:760; }
                :where(.sully-schedule-change-shine) {
                    position:absolute; inset:-30% auto -30% -22%; width:18%; pointer-events:none;
                    background:linear-gradient(90deg,transparent,rgba(255,255,255,.72),transparent);
                    animation:sullyScheduleChangeShine 2.4s ease-out both;
                }
                @media (prefers-reduced-motion: reduce) {
                    :where(.sully-schedule-change) { animation:none; }
                    :where(.sully-schedule-change-shine) { display:none; animation:none; }
                }
            `}</style>
            <div className="sully-schedule-change" role="status" aria-live="polite" aria-label="未来日程已调整">
                <div className="sully-schedule-change-shine" aria-hidden="true" />
                <div className="sully-schedule-change-head">
                    <span className="sully-schedule-change-mark" aria-hidden="true">✓</span>
                    <span className="sully-schedule-change-kicker">未来日程已调整</span>
                    {detail.changes.length > 1 && (
                        <span className="sully-schedule-change-count">{detail.changes.length} 项</span>
                    )}
                </div>
                <div className="sully-schedule-change-list">
                    {detail.changes.slice(0, 3).map((change) => (
                        <div className="sully-schedule-change-row" key={change.startTime}>
                            <span className="sully-schedule-change-time">{change.startTime}</span>
                            <span className="sully-schedule-change-before">{change.before}</span>
                            <span className="sully-schedule-change-arrow" aria-hidden="true">→</span>
                            <span className="sully-schedule-change-after">{change.after}</span>
                        </div>
                    ))}
                </div>
            </div>
        </>
    );
};

export default ScheduleChangeNotice;
