import React from 'react';
import { ArrowSquareOut, BellRinging, CheckCircle } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';

// 这是“打开糯米机时检查一次”的轻量巡查，而非后台服务：网页关闭时不会联网，也不会
// 消耗用户的 API 配额。GitHub 公共 commits 接口支持浏览器跨域读取；失败静默跳过，
// 下次打开再试，避免网络波动打断正常游玩。
const UPSTREAM_COMMITS_URL = 'https://api.github.com/repos/qegj567-cloud/SullyOS/commits?per_page=1';
const STORAGE_KEY = 'nmj_upstream_update_monitor_v1';

type UpstreamCommit = {
    sha: string;
    html_url: string;
    commit?: {
        message?: string;
        author?: { date?: string };
    };
};

type MonitorState = {
    seenSha?: string;
    pending?: UpstreamCommit;
    checkedAt?: number;
};

const readState = (): MonitorState => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
};

const writeState = (state: MonitorState) => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        // 本机存储不可用时仅本次不展示持久提醒，不能影响手机主流程。
    }
};

const summarizeCommit = (commit: UpstreamCommit) => {
    const firstLine = commit.commit?.message?.split('\n')[0]?.trim();
    return firstLine || '原版发布了新的提交';
};

/**
 * 打开手机时检查上游的最新一个提交。首次启用只建立基准，不用历史更新打扰用户；
 * 以后 SHA 改变才以系统卡片提示，并一直保留到用户主动确认。
 */
const UpstreamUpdateMonitor: React.FC = () => {
    const { isDataLoaded, addToast } = useOS();
    const [notice, setNotice] = React.useState<UpstreamCommit | null>(null);
    const addToastRef = React.useRef(addToast);

    React.useEffect(() => {
        addToastRef.current = addToast;
    }, [addToast]);

    React.useEffect(() => {
        if (!isDataLoaded) return;

        const initial = readState();
        if (initial.pending?.sha) setNotice(initial.pending);

        let cancelled = false;
        const check = async () => {
            try {
                const response = await fetch(UPSTREAM_COMMITS_URL, {
                    headers: { Accept: 'application/vnd.github+json' },
                    cache: 'no-store',
                });
                if (!response.ok) return;
                const commits = await response.json() as UpstreamCommit[];
                const latest = commits[0];
                if (!latest?.sha || cancelled) return;

                const saved = readState();
                // 第一次使用只记住当前上游版本；不把用户安装巡查前的历史提交当作新通知。
                if (!saved.seenSha && !saved.pending) {
                    writeState({ ...saved, seenSha: latest.sha, checkedAt: Date.now() });
                    return;
                }
                if (saved.pending?.sha === latest.sha) {
                    writeState({ ...saved, checkedAt: Date.now() });
                    if (!cancelled) setNotice(saved.pending);
                    return;
                }
                if (saved.seenSha !== latest.sha) {
                    const next = { ...saved, pending: latest, checkedAt: Date.now() };
                    writeState(next);
                    if (!cancelled) {
                        setNotice(latest);
                        addToastRef.current('系统更新巡查：发现原版有新更新', 'info');
                    }
                    return;
                }
                writeState({ ...saved, checkedAt: Date.now() });
            } catch {
                // 网络离线、GitHub 临时不可达或遇到速率限制时不弹错误；下次打开会再检查。
            }
        };

        void check();
        return () => { cancelled = true; };
    }, [isDataLoaded]);

    const markRead = () => {
        if (!notice) return;
        const saved = readState();
        writeState({ ...saved, seenSha: notice.sha, pending: undefined, checkedAt: Date.now() });
        setNotice(null);
    };

    const openCommit = () => {
        if (notice?.html_url) window.open(notice.html_url, '_blank', 'noopener,noreferrer');
    };

    if (!notice) return null;
    const date = notice.commit?.author?.date ? new Date(notice.commit.author.date).toLocaleDateString('zh-CN') : '';

    return (
        <aside
            className="fixed inset-x-3 z-[9990] mx-auto w-auto max-w-md rounded-[1.35rem] border border-white/70 bg-white/95 p-4 text-slate-800 shadow-[0_16px_42px_rgba(31,41,55,0.22)] backdrop-blur-xl"
            style={{ bottom: 'max(1rem, calc(env(safe-area-inset-bottom) + 0.7rem))' }}
            role="status"
            aria-live="polite"
        >
            <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-violet-100 text-violet-600">
                    <BellRinging size={21} weight="fill" />
                </div>
                <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-extrabold tracking-[0.14em] text-violet-500">系统更新巡查</p>
                    <h2 className="mt-0.5 text-sm font-black">原版发现一项新更新</h2>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600">{summarizeCommit(notice)}</p>
                    <p className="mt-1 text-[10px] text-slate-400">{date ? `${date} · ` : ''}请在电脑上叫我检查并同步二改。</p>
                </div>
            </div>
            <div className="mt-3 flex gap-2">
                <button
                    type="button"
                    onClick={openCommit}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-violet-50 py-2.5 text-xs font-bold text-violet-700 active:scale-[0.98]"
                >
                    查看原版更新 <ArrowSquareOut size={15} weight="bold" />
                </button>
                <button
                    type="button"
                    onClick={markRead}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-violet-600 py-2.5 text-xs font-bold text-white shadow-sm active:scale-[0.98]"
                >
                    我知道了 <CheckCircle size={15} weight="fill" />
                </button>
            </div>
        </aside>
    );
};

export default UpstreamUpdateMonitor;
