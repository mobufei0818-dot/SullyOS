import { describe, expect, it } from 'vitest';
import type { MomentsProfile } from '../types';
import { selectActiveMomentsNpcProfiles } from './momentsIdentity';

const npc = (patch: Partial<MomentsProfile>): MomentsProfile => ({
  id: 'npc-1', actorType: 'npc', displayName: '楚辞', parentCharacterId: 'source-1',
  friendshipState: 'temporary', updatedAt: 1, ...patch,
});

describe('朋友圈明确 NPC 身份收敛', () => {
  it('does not schedule the old NPC marker after promotion', () => {
    expect(selectActiveMomentsNpcProfiles([
      npc({ characterId: 'character-1', friendshipState: 'friend' }),
    ])).toEqual([]);
  });

  it('does not resurrect an old NPC when a promoted character has the same provenance', () => {
    const promoted: MomentsProfile = {
      id: 'moments:character:character-1', actorType: 'character', characterId: 'character-1',
      displayName: '楚 辞', parentCharacterId: 'source-1', friendshipState: 'friend', updatedAt: 3,
    };
    expect(selectActiveMomentsNpcProfiles([npc({})], [promoted])).toEqual([]);
  });

  it('keeps only the newest duplicate extracted for the same source identity', () => {
    const result = selectActiveMomentsNpcProfiles([
      npc({ id: 'older', updatedAt: 1 }),
      npc({ id: 'newer', displayName: '楚·辞', updatedAt: 2 }),
      npc({ id: 'other-source', parentCharacterId: 'source-2', updatedAt: 1 }),
    ]);
    expect(result.map(profile => profile.id).sort()).toEqual(['newer', 'other-source']);
  });
});
