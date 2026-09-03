import React, { useEffect, useRef } from 'react';
import { useOS } from '../context/OSContext';
import {
  ensureMomentsRuntime,
  hasPendingMomentsRuntimeResync,
  MOMENTS_RUNTIME_RESYNC_EVENT,
  momentsRuntimeRetryDelay,
} from '../utils/momentsRuntimeRecovery';

/**
 * 朋友圈离线排程的全局守护器。
 *
 * 过去运行表只在 MomentsApp 挂载时上传，更新/重连 Worker 后若用户没再打开朋友圈，
 * 所有角色的开关看似仍开着，云端却没有主体可检查。这里在系统启动时低频核对一次，
 * 更新/重连后立即强制补登记；失败标记保存在本机，联网或回到前台后继续退避重试。
 */
const MomentsRuntimeRecoveryController: React.FC = () => {
  const { apiConfig, isDataLoaded } = useOS();
  const apiConfigRef = useRef(apiConfig);
  apiConfigRef.current = apiConfig;

  useEffect(() => {
    if (!isDataLoaded) return;
    let disposed = false;
    let timer: number | null = null;
    const schedule = (delay: number, force: boolean, verify: boolean) => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (disposed) return;
        void ensureMomentsRuntime(apiConfigRef.current, { force, verify }).catch(() => {
          if (!disposed) schedule(momentsRuntimeRetryDelay(), true, false);
        });
      }, delay);
    };
    const onResync = () => schedule(200, true, false);
    const onOnline = () => {
      if (hasPendingMomentsRuntimeResync()) schedule(300, true, false);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && hasPendingMomentsRuntimeResync()) schedule(500, true, false);
    };
    window.addEventListener(MOMENTS_RUNTIME_RESYNC_EVENT, onResync);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    // 每次系统冷启动只读一次专用角色运行表；不扫描任务/诊断日志，状态一致时也不写 D1。
    schedule(1_200, hasPendingMomentsRuntimeResync(), true);
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener(MOMENTS_RUNTIME_RESYNC_EVENT, onResync);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isDataLoaded]);

  return null;
};

export default MomentsRuntimeRecoveryController;
