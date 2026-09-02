export type RelationshipTaskStatus = 'pending' | 'sent' | 'failed';

export interface RelationshipTaskLocks {
  pendingTaskUuid?: string;
  criticalPendingTaskUuid?: string;
}

export interface RelationshipTaskStatusRow {
  uuid?: string;
  status?: string;
}

export interface RelationshipTaskSettlementPlan {
  uuid: string;
  critical: boolean;
  sent: boolean;
}

/**
 * 原版任务表才是任务是否仍在运行的事实源。关系账本里的 UUID 只是防重复锁：
 * pending 行继续等；sent / failed / 已被清理的行都必须结算并释放锁。
 */
export const planRelationshipTaskLockReconciliation = (
  locks: RelationshipTaskLocks,
  rows: RelationshipTaskStatusRow[],
): RelationshipTaskSettlementPlan[] => {
  const statuses = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.uuid === 'string' && row.uuid) statuses.set(row.uuid, String(row.status || ''));
  }

  const plans: RelationshipTaskSettlementPlan[] = [];
  const append = (uuid: string | undefined, critical: boolean) => {
    if (!uuid) return;
    const status = statuses.get(uuid);
    if (status === 'pending') return;
    plans.push({ uuid, critical, sent: status === 'sent' });
  };
  append(locks.pendingTaskUuid, false);
  append(locks.criticalPendingTaskUuid, true);
  return plans;
};
