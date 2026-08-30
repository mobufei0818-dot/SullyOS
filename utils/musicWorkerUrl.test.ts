/**
 * 音乐服务地址跟随中心代理 —— 回归守卫
 *
 * 音乐 App 的服务地址是独立持久化的（`sully_music_cfg_v1`），跟「设置 → 网络代理」
 * 那个中心地址不是同一份存储。这里钉住两件事，别再退化：
 *   1. 没在播放器里单独填过地址的，永远跟着中心走 —— 中心改了、改回默认了，都立刻跟上；
 *   2. 在播放器里手填过地址的，中心怎么改都不动它。
 *
 * 「跟随」现在存成空串（一个意图），不是把当时的中心地址抄一份存下来（一个快照）。
 * 快照的问题是事后分不清「用户敲的」和「当时抄的」，中心一改就留下打不通的幽灵地址。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MusicCfg,
  loadMusicCfgStandalone,
  musicApi,
  resolveMusicWorkerUrl,
} from '../context/MusicContext';
import { DEFAULT_PROXY_WORKER, setProxyWorkerUrl } from './proxyWorker';

const LS_CFG_KEY = 'sully_music_cfg_v1';

/** 直接往 localStorage 里塞一份音乐配置（模拟存量数据） */
const seedMusicCfg = (workerUrl: string) => {
  localStorage.setItem(LS_CFG_KEY, JSON.stringify({ workerUrl, cookie: '', quality: 'exhigh' }));
};

const storedWorkerUrl = (): string => JSON.parse(localStorage.getItem(LS_CFG_KEY) || '{}').workerUrl;

describe('音乐服务地址：跟随中心代理', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('没单独设过 → 用中心地址，中心改了立刻跟上', () => {
    expect(resolveMusicWorkerUrl(loadMusicCfgStandalone())).toBe(DEFAULT_PROXY_WORKER);

    setProxyWorkerUrl('https://my-proxy.example.com');
    expect(resolveMusicWorkerUrl(loadMusicCfgStandalone())).toBe('https://my-proxy.example.com');

    setProxyWorkerUrl('');
    expect(resolveMusicWorkerUrl(loadMusicCfgStandalone())).toBe(DEFAULT_PROXY_WORKER);
  });

  it('存量地址跟当前中心一样 → 收敛成「跟随」，中心改回默认后跟着回默认', () => {
    // 老版本会把当时的中心地址抄进音乐配置。之后中心改回默认，那份快照纹丝不动，
    // 请求继续打已经不用了的地址 —— 正是这条测试要挡住的退化。
    setProxyWorkerUrl('https://old-proxy.example.com');
    seedMusicCfg('https://old-proxy.example.com');

    expect(loadMusicCfgStandalone().workerUrl).toBe('');

    setProxyWorkerUrl('');
    expect(resolveMusicWorkerUrl(loadMusicCfgStandalone())).toBe(DEFAULT_PROXY_WORKER);
  });

  it('存量地址是公共默认实例 / 已死的历史实例 → 都当成跟随中心', () => {
    for (const stale of [
      DEFAULT_PROXY_WORKER,
      'https://sully-n.qegj567.workers.dev',
      'https://sullymeow.ccwu213.cc',
    ]) {
      seedMusicCfg(stale);
      expect(loadMusicCfgStandalone().workerUrl).toBe('');
    }
  });

  it('迁移结果落盘，不是每次读都现算', () => {
    seedMusicCfg('https://sully-n.qegj567.workers.dev');
    loadMusicCfgStandalone();
    expect(storedWorkerUrl()).toBe('');
  });

  it('在播放器里手填过的地址 → 中心怎么改都不动', () => {
    seedMusicCfg('https://my-own-music.example.com');
    expect(loadMusicCfgStandalone().workerUrl).toBe('https://my-own-music.example.com');

    setProxyWorkerUrl('https://another-proxy.example.com');
    expect(resolveMusicWorkerUrl(loadMusicCfgStandalone())).toBe('https://my-own-music.example.com');
  });

  it('地址结尾的斜杠和空格不影响拼出来的 URL', () => {
    const cfg = { workerUrl: '  https://my-own-music.example.com//  ', cookie: '', quality: 'exhigh' } as MusicCfg;
    expect(resolveMusicWorkerUrl(cfg)).toBe('https://my-own-music.example.com');
  });

  it('发请求时才解析地址 —— 同一份 cfg，中心改了就打到新地址', async () => {
    const hit: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      hit.push(url);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    // 组件挂载时快照进 state 的那份 cfg（跟随中心），中途不会重新构造
    const cfg = loadMusicCfgStandalone();
    await musicApi._raw(cfg, '/login/qr/key');

    setProxyWorkerUrl('https://my-proxy.example.com');
    await musicApi._raw(cfg, '/login/qr/key');

    expect(hit).toEqual([
      `${DEFAULT_PROXY_WORKER}/netease/login/qr/key`,
      'https://my-proxy.example.com/netease/login/qr/key',
    ]);
  });
});
