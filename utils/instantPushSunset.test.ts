/**
 * Instant Push 下线通知的两条硬规矩，都是「错了没人会来报」的那种：
 *  1. 只对现在开着 Instant Push 的人弹 —— 弹给没开的人就是纯骚扰，而且他们根本不知道
 *     这弹窗在说什么。
 *  2. 每天最多一次 —— 关掉只记当天日期，第二天照弹。写成「永久已读」的话，一批人
 *     点完就再也想不起来迁移，14 天窗口白给。
 *
 * 顺带钉住 Instant Push 设置面板那道「停止接入」的门：还没开的人一律勾不上，
 * 已经开着的人照常能取消。
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { saveInstantConfig, clearInstantConfig } from './instantPushClient';
import {
  shouldShowInstantPushSunsetNotice,
  markInstantPushSunsetNoticeShown,
  INSTANT_PUSH_SUNSET_DATE,
  INSTANT_PUSH_MIGRATION_GUIDE_URL,
} from '../components/InstantPushSunsetEvent';

const here = dirname(fileURLToPath(import.meta.url));
const settingsSrc = readFileSync(
  resolve(here, '../components/settings/InstantPushSettingsModal.tsx'),
  'utf8',
);

const WORKER_URL = 'https://ip.example.workers.dev';
const enableInstantPush = () => saveInstantConfig({ enabled: true, workerUrl: WORKER_URL });

describe('Instant Push 下线通知弹不弹', () => {
  beforeEach(() => {
    localStorage.clear();
    clearInstantConfig();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('没配 Instant Push 的人不弹', () => {
    expect(shouldShowInstantPushSunsetNotice()).toBe(false);
  });

  it('配了但没开的人也不弹（这批人本来就没在用它）', () => {
    saveInstantConfig({ enabled: false, workerUrl: WORKER_URL });
    expect(shouldShowInstantPushSunsetNotice()).toBe(false);
  });

  it('现在开着的人要弹', () => {
    enableInstantPush();
    expect(shouldShowInstantPushSunsetNotice()).toBe(true);
  });

  it('当天关掉之后不再弹', () => {
    enableInstantPush();
    markInstantPushSunsetNoticeShown();
    expect(shouldShowInstantPushSunsetNotice()).toBe(false);
  });

  it('第二天重新弹（不是「永久已读」）', () => {
    enableInstantPush();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 14, 10, 0, 0));
    markInstantPushSunsetNoticeShown();
    expect(shouldShowInstantPushSunsetNotice()).toBe(false);

    vi.setSystemTime(new Date(2026, 7, 15, 10, 0, 0));
    expect(shouldShowInstantPushSunsetNotice()).toBe(true);
  });

  it('用户自己把 Instant Push 关掉之后就彻底不打扰了', () => {
    enableInstantPush();
    markInstantPushSunsetNoticeShown();
    saveInstantConfig({ enabled: false, workerUrl: WORKER_URL });
    expect(shouldShowInstantPushSunsetNotice()).toBe(false);
  });
});

describe('设置面板停止接入这道门', () => {
  it('锁的依据是存档里的状态，不是界面上的实时勾选（否则手滑取消一下就再也勾不回来）', () => {
    expect(settingsSrc).toContain('setEnableLocked(!cfg.enabled)');
    expect(settingsSrc).not.toContain('setEnableLocked(!enabled)');
  });

  it('勾选框 disabled 走的是合并后的 enableBlocked，两道门都算数', () => {
    expect(settingsSrc).toContain('const enableBlocked = enableLocked || enableBlockedByInstantChat');
    expect(settingsSrc).toContain('disabled={enableBlocked}');
  });

  it('落盘层挡的是 off→on 而不是「有没有开即时对话」（界面锁死不等于存不进去）', () => {
    const handleSave = settingsSrc.slice(settingsSrc.indexOf('const handleSave'));
    expect(handleSave).toContain('const turningOn = !loadInstantConfig().enabled && cfg.enabled');
    expect(handleSave).toContain('if (turningOn) {');
    // 反向互斥门还在：即时对话开着时提示词要说得更具体。
    expect(handleSave).toContain('raceBlocked');
  });

  it('面板里的下线日期和迁移链接跟弹窗共用同一份常量', () => {
    expect(settingsSrc).toContain('INSTANT_PUSH_SUNSET_DATE');
    expect(settingsSrc).toContain('INSTANT_PUSH_MIGRATION_GUIDE_URL');
    expect(INSTANT_PUSH_SUNSET_DATE).toBe('2026-08-27');
    expect(INSTANT_PUSH_MIGRATION_GUIDE_URL).toContain('discord.com');
  });
});
