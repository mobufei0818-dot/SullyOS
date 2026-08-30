export const formatBytes = (bytes?: number): string => {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

/**
 * 金额按「分」收敛：浮点相加会攒出 49.85999999999999 这样的尾巴，
 * 展示或写进文本前都先过这里，保证只到分位。
 */
export const roundMoney = (value: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
};

/** 一串金额求和，结果已收敛到分位 */
export const sumMoney = (values: number[]): number =>
  roundMoney(values.reduce((sum, v) => sum + (Number(v) || 0), 0));

/** 金额显示：整数不带小数点，小数最多两位（49.859999… → 49.86，100 → 100） */
export const formatMoney = (value: number): string => String(roundMoney(value));

/**
 * 分钟按小时显示：界面上给的是整档，但持久化里的值可能是导入的备份、
 * 老版本写进去的任意整数，除以 60 会拖出 1.6666666666666667。
 */
export const formatHours = (minutes: number): string => {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round((n / 60) * 10) / 10);
};
