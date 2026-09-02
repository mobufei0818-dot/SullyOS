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

/** 凭据补传后应在下一分钟重试，不能再被正常的十分钟关系节流挡住。 */
export const isRelationshipCredentialError = (message?: string): boolean => Boolean(message && (
  message.includes('CREDENTIAL_NOT_FOUND')
  || message.includes('CREDENTIAL_MISSING')
  || message.includes('credRefs 引用的凭据不存在')
  || message.includes('引用的凭据不存在')
));

export const shouldDeferRelationshipTick = (
  lastTickAt: number | undefined,
  now: number,
  lastScheduleError?: string,
  intervalMs = 10 * 60_000,
): boolean => Boolean(
  lastTickAt
  && now - lastTickAt < intervalMs
  && !isRelationshipCredentialError(lastScheduleError)
);
