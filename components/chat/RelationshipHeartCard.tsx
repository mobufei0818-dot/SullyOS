import React from 'react';
import type { CharacterProfile, RelationshipPulse } from '../../types';

interface RelationshipHeartCardProps {
  char: CharacterProfile;
  pulse: RelationshipPulse;
  onClose: () => void;
  onManualUpdate: (values: { longing: number; nextThreshold: number }) => Promise<RelationshipPulse | null>;
}

const Metric: React.FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => (
  <div className="min-w-0 flex-1 rounded-2xl bg-white/70 px-2.5 py-2 text-center shadow-sm ring-1 ring-white/80">
    <div className="text-[10px] font-bold tracking-[0.08em] text-slate-400">{label}</div>
    <div className="mt-0.5 text-[18px] font-black tabular-nums" style={{ color }}>{value}</div>
  </div>
);

const formatTime = (value?: number) => value
  ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', month: 'numeric', day: 'numeric', hour12: false }).format(new Date(value))
  : '—';

const RelationshipHeartCard: React.FC<RelationshipHeartCardProps> = ({ char, pulse, onClose, onManualUpdate }) => {
  const [voiceExpanded, setVoiceExpanded] = React.useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = React.useState(false);
  const [manualOpen, setManualOpen] = React.useState(false);
  const [manualLonging, setManualLonging] = React.useState(String(pulse.baselineLonging));
  const [manualThreshold, setManualThreshold] = React.useState(String(pulse.nextThreshold ?? 30));
  const [manualSaving, setManualSaving] = React.useState(false);
  const [manualMessage, setManualMessage] = React.useState('');
  const voice = pulse.innerVoice || '把想说的话先悄悄留在心里。';
  React.useEffect(() => {
    if (manualOpen) return;
    setManualLonging(String(pulse.baselineLonging));
    setManualThreshold(String(pulse.nextThreshold ?? 30));
  }, [pulse.baselineLonging, pulse.nextThreshold, manualOpen]);
  const saveManualValues = async () => {
    const longing = Number(manualLonging);
    const nextThreshold = Number(manualThreshold);
    if (!Number.isFinite(longing) || !Number.isFinite(nextThreshold) || longing < 0 || longing > 100 || nextThreshold < 0 || nextThreshold > 100) {
      setManualMessage('请输入 0–100 之间的数字。');
      return;
    }
    setManualSaving(true);
    setManualMessage('');
    try {
      const next = await onManualUpdate({ longing, nextThreshold });
      if (!next) throw new Error('后端没有返回校正后的状态。');
      setManualLonging(String(next.baselineLonging));
      setManualThreshold(String(next.nextThreshold ?? nextThreshold));
      setManualMessage('已同步到后端。');
    } catch (error) {
      setManualMessage(error instanceof Error ? error.message : '校正失败，请稍后重试。');
    } finally {
      setManualSaving(false);
    }
  };
  return (
  <div className="fixed inset-0 z-[120] flex items-end justify-center bg-slate-900/20 px-4 pb-[calc(env(safe-area-inset-bottom)+18px)] backdrop-blur-[1px]" onClick={onClose}>
    <section
      className="w-full max-w-md overflow-hidden rounded-[28px] border border-white/80 bg-gradient-to-br from-rose-50 via-white to-violet-50 shadow-2xl"
      onClick={event => event.stopPropagation()}
      role="dialog"
      aria-label={`${char.name}的关系状态`}
    >
      <div className="flex items-start justify-between px-5 pb-3 pt-5">
        <div className="min-w-0">
          <div className="text-[10px] font-extrabold tracking-[0.22em] text-rose-400">RELATION PULSE</div>
          <h2 className="mt-1 text-lg font-black text-slate-700">{char.name} 此刻的心意</h2>
        </div>
        <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-full bg-white/80 text-lg text-slate-400 shadow-sm active:scale-95" aria-label="关闭">×</button>
      </div>
      <div className="mx-5 flex gap-2.5">
        <Metric label="思念值" value={pulse.baselineLonging} color="#e8798f" />
        <Metric label="好感度" value={pulse.affection} color="#8b6fc7" />
        <Metric label="醋意值" value={pulse.jealousy} color="#d28a56" />
      </div>
      <div className="mx-5 mb-5 mt-4 rounded-2xl border border-rose-100 bg-white/65 px-4 py-3">
        <div className="text-[10px] font-bold tracking-[0.12em] text-rose-400">TA 的心声</div>
        <p className={`mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-slate-600 ${voiceExpanded ? '' : 'line-clamp-3'}`}>{voice}</p>
        {voice.length > 72 && (
          <button type="button" onClick={() => setVoiceExpanded(value => !value)} className="mt-2 text-[11px] font-bold text-rose-400">
            {voiceExpanded ? '收起心声' : '展开完整心声'}
          </button>
        )}
      </div>
      {pulse.diagnostics && (
        <div className="mx-5 mb-4 rounded-2xl border border-slate-200/80 bg-white/55 px-3.5 py-2.5">
          <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setDiagnosticsOpen(value => !value)}>
            <span className="text-[11px] font-bold text-slate-500">排程诊断</span>
            <span className="text-[11px] font-bold text-rose-400">{diagnosticsOpen ? '收起' : '查看'}</span>
          </button>
          {diagnosticsOpen && (
            <div className="mt-2.5 space-y-1.5 break-all text-[10px] leading-relaxed text-slate-500">
              <p><span className="font-bold text-slate-600">当前状态：</span>{pulse.diagnostics.status || '等待后端状态回传。'}</p>
              <p><span className="font-bold text-slate-600">pendingTaskUuid：</span>{pulse.diagnostics.pendingTaskUuid || '无'}</p>
              <p><span className="font-bold text-slate-600">lastDispatchAt：</span>{formatTime(pulse.diagnostics.lastDispatchAt)}</p>
              <p><span className="font-bold text-slate-600">lastTickAt：</span>{formatTime(pulse.diagnostics.lastTickAt)}</p>
              <p><span className="font-bold text-slate-600">next_tick_at：</span>{formatTime(pulse.diagnostics.nextTickAt)}</p>
              <p><span className="font-bold text-slate-600">任务创建失败：</span>{pulse.diagnostics.lastScheduleError || '无'}{pulse.diagnostics.lastScheduleErrorAt ? `（${formatTime(pulse.diagnostics.lastScheduleErrorAt)}）` : ''}</p>
            </div>
          )}
        </div>
      )}
      <div className="mx-5 mb-4 rounded-2xl border border-violet-100 bg-violet-50/45 px-3.5 py-2.5">
        <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => { setManualOpen(value => !value); setManualMessage(''); }}>
          <span className="text-[11px] font-bold text-slate-500">手动校正</span>
          <span className="text-[11px] font-bold text-violet-500">{manualOpen ? '收起' : '修改数值'}</span>
        </button>
        {manualOpen && (
          <div className="mt-2.5">
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">直接写入后端关系账本；思念值和下一阈值均限制为 0–100。</p>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[10px] font-bold text-slate-500">思念值
                <input inputMode="numeric" type="number" min="0" max="100" value={manualLonging} onChange={event => setManualLonging(event.target.value)} className="mt-1 block w-full rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-sm font-bold text-slate-700 outline-none focus:border-violet-300" />
              </label>
              <label className="text-[10px] font-bold text-slate-500">下一阈值
                <input inputMode="numeric" type="number" min="0" max="100" value={manualThreshold} onChange={event => setManualThreshold(event.target.value)} className="mt-1 block w-full rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-sm font-bold text-slate-700 outline-none focus:border-violet-300" />
              </label>
            </div>
            <button type="button" disabled={manualSaving} onClick={() => void saveManualValues()} className="mt-2.5 w-full rounded-xl bg-violet-500 px-3 py-2 text-[11px] font-bold text-white disabled:opacity-50 active:scale-[0.99]">
              {manualSaving ? '正在同步…' : '保存到后端'}
            </button>
            {manualMessage && <p className={`mt-2 text-[10px] ${manualMessage === '已同步到后端。' ? 'text-emerald-600' : 'text-rose-500'}`}>{manualMessage}</p>}
          </div>
        )}
      </div>
      <div className="border-t border-white/80 bg-white/40 px-5 py-2.5 text-center text-[10px] text-slate-400">
        仅供查看 · {pulse.nextThreshold ? `下一次阈值 ${pulse.nextThreshold}` : '数值会随聊天与时间自然变化'}
      </div>
    </section>
  </div>
  );
};

export default RelationshipHeartCard;
