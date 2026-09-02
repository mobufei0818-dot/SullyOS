// 主动消息 2.0 后端 bundle（worker/amsg）代码版本的唯一出处。
//
// worker bundle（worker/amsg/src/index.ts → GET /config-check 的 workerVersion）和
// SullyOS 前端（设置页判断「有没有新版可更」）都从这里 import，所以用户那台 Worker 报回来的
// 版本和 App 里认的版本不会各说各话——除非那台 Worker 贴的是旧 bundle，而那正是要认出来的事。
//
// 什么时候改：worker/amsg/src/* 有了「用户不更新就用不上 / 会出错」的改动时。
// 纯注释、纯重构不用动。格式 YYYY-MM-DD，同一天发第二版就加 .2/.3 后缀；
// 前端直接按字符串比对，不相等就是「有更新」，不做大小排序。
//
// 跟另外两个版本号分清楚：
//   - utils/amsgWorkerVersion.ts 比的是**上游库** @rei-standard/amsg-server 的 semver；
//   - utils/buildInfo.ts 的 APP_VERSION 是整个 SullyOS App 的版本。
//   这里管的只有一样：用户自己那台 Worker 上跑的这份 bundle 是哪天的。
// 2026-09-02：修复关系 next_tick_at 被页面同步后推，并保留 stale 锁与 D1 降频修复。
export const AMSG_BUNDLE_VERSION = '2026-09-02.relationship-tick-clock-1';

const readBundleDate = (value: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:\.|$)/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return time;
};

/**
 * 页面和 Worker 不是原子发布：用户可能先更新 Worker，手机上还开着旧网页。
 * 此时线上 Worker 的日期比网页内置目标更新，应视为 current，绝不能提示倒退。
 * 同日但后缀不同时无法安全推断先后，仍要求精确一致。
 */
export const isAmsgBundleCurrentOrNewer = (deployed: string, expected: string): boolean => {
  if (deployed === expected) return true;
  const deployedDate = readBundleDate(deployed);
  const expectedDate = readBundleDate(expected);
  return deployedDate !== null && expectedDate !== null && deployedDate > expectedDate;
};
