
import React from 'react';
import { OSProvider } from './context/OSContext';
import { MusicProvider } from './context/MusicContext';
import PhoneShell from './components/PhoneShell';
import BuildBadge from './components/BuildBadge';
import DevDebugPanel from './components/DevDebugPanel';
import Amsg2DebugPanel from './components/Amsg2DebugPanel';
import VRBroadcast from './components/VRBroadcast';
import WorldBroadcast from './components/WorldBroadcast';
import ChatBroadcast from './components/ChatBroadcast';
import UpstreamUpdateMonitor from './components/UpstreamUpdateMonitor';
import { isIOSStandaloneWebApp } from './utils/iosStandalone';
import { installDevDebugLifecycleCapture } from './utils/devDebug';

const App: React.FC = () => {
  React.useEffect(() => {
    // 常驻监听前后台 / 焦点 / 网络事件；抓不抓由 devDebug 的 lifecycle 类勾选决定
    installDevDebugLifecycleCapture();

    // 外卖模块已移除。清掉旧版本留下的本地业务数据，避免它继续影响聊天上下文或占用存储。
    try {
      [
        'nmj-takeout-orders',
        'nmj-takeout-catalog-v2',
        'nmj-takeout-address-book-v1',
        'nmj-takeout-location',
        'nmj-takeout-api',
        'nmj-takeout-secondary-api',
        'nmj-takeout-role-order-intents',
      ].forEach(key => localStorage.removeItem(key));
    } catch { /* private mode or unavailable storage: no action needed */ }
  }, []);

  const useAbsoluteShell = typeof window !== 'undefined' && isIOSStandaloneWebApp();
  const shellClassName = useAbsoluteShell
    ? 'fixed inset-0 w-full h-full bg-transparent overflow-hidden'
    : 'relative w-full bg-transparent overflow-hidden';
  const shellStyle = useAbsoluteShell
    ? { height: 'var(--app-height, 100lvh)', minHeight: 'var(--app-height, 100lvh)' }
    : { height: 'var(--app-height, 100lvh)', minHeight: 'var(--app-height, 100lvh)' };

  return (
    <>
      <div
        className={shellClassName}
        style={shellStyle}
      >
        <div
          className={`${useAbsoluteShell ? 'absolute' : 'fixed'} inset-0 w-full h-full z-0 bg-transparent`}
          style={{ transform: 'translateZ(0)' }}
        >
          <OSProvider>
            <MusicProvider>
              <PhoneShell />
              <UpstreamUpdateMonitor />
            </MusicProvider>
            {/* 挂在 Provider 里面才能直接读 characters（省掉轮询 IndexedDB），
                面板自身用 portal 渲染到 body，绕开上面那层 transform 对 fixed 定位的影响。 */}
            <Amsg2DebugPanel />
          </OSProvider>
        </div>
      </div>
      <BuildBadge />
      <DevDebugPanel />
      <VRBroadcast />
      <WorldBroadcast />
      <ChatBroadcast />
    </>
  );
};

export default App;
