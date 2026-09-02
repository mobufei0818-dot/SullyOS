// 主动消息 2.0 后端 bundle（worker/amsg）代码版本的唯一出处。
//
// worker bundle（worker/amsg/src/index.ts → GET /config-check 的 workerVersion）和
// SullyOS 前端（设置页判断「有没有新版可更」）都从这里 import，所以用户那台 Worker 报回来的
// 版本和 App 里认的版本不会各说各话——除非那台 Worker 贴的是旧 bundle，而那正是要认出来的事。
//
// 什么时候改：worker/amsg/src/* 有了「用户不更新就用不上 / 会出错」的改动时。
// 纯注释、纯重构不用动。新版本统一写成 YYYY-MM-DD.rN.<说明>，同一天每次发布递增 rN。
// 旧版 YYYY-MM-DD.<说明> 没有可比较序号；兼容规则宁可把同日不同旧后缀视为当前，也绝不
// 提示用户把已经更新的 Worker 降级。下一次真正的 Worker 发布从 r1 开始，之后只增不减。
//
// 跟另外两个版本号分清楚：
//   - utils/amsgWorkerVersion.ts 比的是**上游库** @rei-standard/amsg-server 的 semver；
//   - utils/buildInfo.ts 的 APP_VERSION 是整个 SullyOS App 的版本。
//   这里管的只有一样：用户自己那台 Worker 上跑的这份 bundle 是哪天的。
// 2026-09-02 r1：新角色凭据补传后，关系 Cron 下一分钟快速重试；保留此前全部时钟与 D1 修复。
export const AMSG_BUNDLE_VERSION = '2026-09-02.r1.relationship-credential-retry';

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

const readBundleRevision = (value: string): number | null => {
  const match = /^\d{4}-\d{2}-\d{2}\.r(\d+)(?:\.|$)/.exec(value.trim());
  if (!match) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
};

/**
 * 页面和 Worker 不是原子发布：用户可能先更新 Worker，手机上还开着旧网页。
 * 此时线上 Worker 比网页内置目标更新，应视为 current，绝不能提示倒退。
 *
 * 新格式同日按 rN 比较。历史旧格式没有序号，同日不同说明无法安全判断先后，因此按 current
 * 处理；这是一次性兼容边界，后续发布必须使用 rN，不能再靠说明文字猜版本顺序。
 */
export const isAmsgBundleCurrentOrNewer = (deployed: string, expected: string): boolean => {
  if (deployed === expected) return true;
  const deployedDate = readBundleDate(deployed);
  const expectedDate = readBundleDate(expected);
  if (deployedDate === null || expectedDate === null) return false;
  if (deployedDate !== expectedDate) return deployedDate > expectedDate;

  const deployedRevision = readBundleRevision(deployed);
  const expectedRevision = readBundleRevision(expected);
  if (deployedRevision !== null && expectedRevision !== null) {
    return deployedRevision >= expectedRevision;
  }
  if (deployedRevision !== null) return true;
  if (expectedRevision !== null) return false;
  return true;
};
