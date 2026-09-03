import type { MomentsProfile } from '../types';

const normalizedMomentsPersonName = (value?: string): string => String(value || '')
  .normalize('NFKC')
  .replace(/[\s·•・._-]+/g, '')
  .toLocaleLowerCase();

const identityKey = (profile: Pick<MomentsProfile, 'parentCharacterId' | 'displayName'>): string =>
  `${profile.parentCharacterId || ''}\u0000${normalizedMomentsPersonName(profile.displayName)}`;

/**
 * 返回仍是独立明确 NPC 的资料。
 *
 * NPC 加为正式好友后，本地会保留一条旧 NPC 资料作为“已经转正”的幂等标记。
 * 这条标记不能再次进入朋友圈运行表；同一来源角色下重复提取出的同名 NPC 也只保留
 * 最新一条。逻辑按稳定身份字段判断，不对任何具体角色名做特判。
 */
export const selectActiveMomentsNpcProfiles = (
  npcProfiles: MomentsProfile[],
  characterProfiles: MomentsProfile[] = [],
): MomentsProfile[] => {
  const promotedIdentities = new Set(characterProfiles
    .filter(profile => profile.actorType === 'character' && profile.parentCharacterId)
    .map(identityKey));
  const latestByIdentity = new Map<string, MomentsProfile>();

  for (const profile of npcProfiles) {
    if (profile.actorType !== 'npc' || profile.friendshipState === 'friend' || profile.characterId) continue;
    const key = identityKey(profile);
    if (promotedIdentities.has(key)) continue;
    const previous = latestByIdentity.get(key);
    if (!previous || profile.updatedAt >= previous.updatedAt) latestByIdentity.set(key, profile);
  }
  return [...latestByIdentity.values()];
};

