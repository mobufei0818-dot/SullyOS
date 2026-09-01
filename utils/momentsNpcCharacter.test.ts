import { describe, expect, it } from 'vitest';
import { planMomentsNpcCharacterProfile } from './momentsApi';

describe('明确 NPC 转正式角色', () => {
  it('副 API 不可用时仍把简短描述和结构化核心指令分开', async () => {
    const card = await planMomentsNpcCharacterProfile({
      config: { source: 'custom', enabled: false, baseUrl: '', apiKey: '', model: '' },
      npc: {
        id: 'moments:npc:xieyou:chuci', actorType: 'npc', displayName: '楚辞',
        bio: '性格直爽，经常沦为谢侑抽象恶搞和段子实验的受害者。',
        relationLabel: '高中同桌兼合租室友', parentCharacterId: 'xieyou', friendshipState: 'temporary', updatedAt: 1,
      },
      sourceCharacter: { name: '谢侑', description: '嘴硬心软的设计师', systemPrompt: '谢侑的完整人设' },
    });

    expect(Array.from(card.description).length).toBeLessThanOrEqual(15);
    expect(card.description).not.toContain('性格直爽，经常');
    expect(card.systemPrompt).toContain('【关联角色】');
    expect(card.systemPrompt).toContain('谢侑');
    expect(card.systemPrompt).toContain('高中同桌兼合租室友');
    expect(card.systemPrompt).toContain('性格直爽');
    expect(card.systemPrompt).not.toContain('现在用户已正式添加你为好友');
  });
});
