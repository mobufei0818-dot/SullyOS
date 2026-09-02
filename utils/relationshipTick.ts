/**
 * 页面同步只能把一次检查提前，不能把已经安排好（包括已经到期）的检查往后推。
 * 只有 Cron 真正完成一轮关系检查后，才有权把游标推进到新时间。
 */
export const resolveRelationshipNextTickAt = (
  previousTickAt: number | undefined,
  requestedTickAt: number,
  tickCompleted: boolean,
): number => {
  if (tickCompleted) return requestedTickAt;
  if (!Number.isFinite(previousTickAt) || Number(previousTickAt) <= 0) return requestedTickAt;
  return Math.min(Number(previousTickAt), requestedTickAt);
};
