import { describe, expect, it } from 'vitest';
import type { MomentsRuntimeActorDiagnostic } from '../types';
import type { MomentsRuntimeSyncPayload } from './momentsSync';
import { momentsRuntimeMatchesExpected } from './momentsRuntimeRecovery';

const payload: MomentsRuntimeSyncPayload = {
  userId: 'user-a', enabled: true, autoInteractionEnabled: true,
  credentialId: 'moments/default', replaceAll: true, updatedAt: 1,
  actors: [{
    actorId: 'moments:character:a', actorType: 'character', characterId: 'a',
    displayName: '角色甲', postingMode: 'high', interactionMode: 'normal',
    timezoneId: 'Asia/Shanghai', timezoneOffsetMinutes: 480,
    pack: { persona: '', userRelationship: '', privateChat: '', sharedGroupChat: '', recentPosts: [], galleryOptions: [], privacyCandidates: [] },
  }],
};

const row: MomentsRuntimeActorDiagnostic = {
  actorId: 'moments:character:a', actorType: 'character', displayName: '角色甲',
  postingMode: 'high', enabled: true, nextDecisionAt: 1000, failureCount: 0, updatedAt: 1,
};

describe('朋友圈云端角色运行表核对', () => {
  it('角色、档位、启用状态和下次检查都一致才视为健康', () => {
    expect(momentsRuntimeMatchesExpected(payload, [row])).toBe(true);
    expect(momentsRuntimeMatchesExpected(payload, [])).toBe(false);
    expect(momentsRuntimeMatchesExpected(payload, [{ ...row, postingMode: 'medium' }])).toBe(false);
    expect(momentsRuntimeMatchesExpected(payload, [{ ...row, nextDecisionAt: 0 }])).toBe(false);
  });

  it('云端遗留任何本地不存在的主体时都要求重新同步清理', () => {
    expect(momentsRuntimeMatchesExpected(payload, [row, { ...row, actorId: 'orphan', displayName: '旧角色' }])).toBe(false);
    expect(momentsRuntimeMatchesExpected(payload, [row, { ...row, actorId: 'orphan', displayName: '旧角色', enabled: false }])).toBe(false);
  });
});
