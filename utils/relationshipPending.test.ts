import { describe, expect, it } from 'vitest';
import { planRelationshipTaskLockReconciliation } from './relationshipPending';

describe('planRelationshipTaskLockReconciliation', () => {
  it('keeps a genuinely pending original task locked', () => {
    expect(planRelationshipTaskLockReconciliation(
      { pendingTaskUuid: 'normal-1' },
      [{ uuid: 'normal-1', status: 'pending' }],
    )).toEqual([]);
  });

  it('releases failed and already-cleaned zombie locks without treating them as sent', () => {
    expect(planRelationshipTaskLockReconciliation(
      { pendingTaskUuid: 'failed-1', criticalPendingTaskUuid: 'missing-1' },
      [{ uuid: 'failed-1', status: 'failed' }],
    )).toEqual([
      { uuid: 'failed-1', critical: false, sent: false },
      { uuid: 'missing-1', critical: true, sent: false },
    ]);
  });

  it('recognizes a sent task so normal relationship values can settle exactly once', () => {
    expect(planRelationshipTaskLockReconciliation(
      { pendingTaskUuid: 'sent-1' },
      [{ uuid: 'sent-1', status: 'sent' }],
    )).toEqual([{ uuid: 'sent-1', critical: false, sent: true }]);
  });
});
