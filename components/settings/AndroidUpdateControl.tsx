import React, { useState } from 'react';
import {
  downloadAndVerifyAndroidUpdate,
  fetchAndroidUpdateManifest,
  getInstalledAndroidAppInfo,
  installVerifiedAndroidUpdate,
  isAndroidAppUpdateEnabled,
  type AndroidUpdateManifest,
} from '../../utils/androidAppUpdate';
import { trackEvent } from '../../utils/analytics';

type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'permission' | 'installing' | 'latest' | 'error';

const errorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  if (/Failed to fetch|NetworkError|timeout/i.test(message)) return '网络连接失败，请稍后重试';
  return message || '检查更新失败，请稍后重试';
};

const AndroidUpdateControl: React.FC = () => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [manifest, setManifest] = useState<AndroidUpdateManifest | null>(null);
  const [downloadedPath, setDownloadedPath] = useState('');
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');

  if (!isAndroidAppUpdateEnabled()) return null;

  const check = async () => {
    setPhase('checking');
    setMessage('');
    try {
      const [installed, latest] = await Promise.all([
        getInstalledAndroidAppInfo(),
        fetchAndroidUpdateManifest(),
      ]);
      if (latest.versionCode <= installed.versionCode) {
        setManifest(null);
        setPhase('latest');
        setMessage(`当前 ${installed.versionName || installed.versionCode} 已是最新版`);
        trackEvent('Android 检查更新', { result: 'latest', versionCode: installed.versionCode });
        return;
      }
      setManifest(latest);
      setPhase('available');
      setMessage(`发现新版本 ${latest.versionName}`);
      trackEvent('Android 检查更新', { result: 'available', versionCode: latest.versionCode });
    } catch (error) {
      setPhase('error');
      setMessage(errorMessage(error));
      trackEvent('Android 检查更新', { result: 'failed' });
    }
  };

  const install = async (path: string, target: AndroidUpdateManifest) => {
    setPhase('installing');
    const result = await installVerifiedAndroidUpdate(path, target);
    if (result.status === 'permission_required') {
      setPhase('permission');
      setMessage('请允许“安装未知应用”，返回后点“继续安装”');
      return;
    }
    setMessage('已打开 Android 系统安装器');
  };

  const download = async () => {
    if (!manifest) return;
    setPhase('downloading');
    setProgress(0);
    setMessage('正在下载并校验正式安装包');
    try {
      const path = await downloadAndVerifyAndroidUpdate(manifest, setProgress);
      setDownloadedPath(path);
      await install(path, manifest);
      trackEvent('Android 下载更新', { result: 'installer-opened', versionCode: manifest.versionCode });
    } catch (error) {
      setPhase('error');
      setMessage(errorMessage(error));
      trackEvent('Android 下载更新', { result: 'failed', versionCode: manifest.versionCode });
    }
  };

  const continueInstall = async () => {
    if (!manifest || !downloadedPath) return;
    try {
      await install(downloadedPath, manifest);
    } catch (error) {
      setPhase('error');
      setMessage(errorMessage(error));
    }
  };

  const busy = phase === 'checking' || phase === 'downloading' || phase === 'installing';
  const label = phase === 'checking'
    ? '检查中…'
    : phase === 'downloading'
      ? `下载中 ${Math.round(progress * 100)}%`
      : phase === 'installing'
        ? '正在打开安装器…'
        : phase === 'available'
          ? `下载并安装 ${manifest?.versionName || '新版本'}`
          : phase === 'permission'
            ? '继续安装'
            : '检查更新';
  const onClick = phase === 'available' ? download : phase === 'permission' ? continueInstall : check;

  return (
    <div className="mt-2 flex flex-col items-center gap-1.5">
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={busy}
        className="rounded-full bg-violet-100 px-4 py-2 text-[11px] font-bold text-violet-700 transition-transform active:scale-95 disabled:opacity-60"
      >
        {label}
      </button>
      {phase === 'downloading' && (
        <div className="h-1 w-40 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full bg-violet-400 transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {message && (
        <p className={`max-w-[280px] text-center text-[10px] leading-relaxed ${phase === 'error' ? 'text-rose-500' : 'text-slate-400'}`}>
          {message}
        </p>
      )}
      {phase === 'available' && manifest?.releaseNotes.length ? (
        <ul className="max-w-[300px] list-disc space-y-0.5 pl-5 text-left text-[9px] leading-relaxed text-slate-400">
          {manifest.releaseNotes.map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}
        </ul>
      ) : null}
    </div>
  );
};

export default AndroidUpdateControl;
