import { describe, expect, it } from 'vitest';
import { planMomentsNpcCharacterProfile, planMomentsStrangerCharacterProfile } from './momentsApi';

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
    for (const section of ['【基础身份】', '【外貌特征】', '【性格核心】', '【与用户关系】', '【沟通风格】', '【互动指南】', '【生活习惯】', '【特殊设定】']) {
      expect(card.systemPrompt).toContain(section);
    }
    expect(card.systemPrompt).not.toMatch(/未知|待补充|禁止一次性编造|不要擅自编造/);
    expect(card.systemPrompt).toMatch(/年龄：\d+岁/);
    expect(card.systemPrompt).toMatch(/生日：\d+月\d+日/);
  });

  it('摇一摇好友在副 API 不可用时也生成完整角色卡', async () => {
    const card = await planMomentsStrangerCharacterProfile({
      config: { source: 'custom', enabled: false, baseUrl: '', apiKey: '', model: '' },
      profile: {
        id: 'moments:stranger:linye', actorType: 'stranger', displayName: '林野',
        bio: '刚下班的摄影师，喜欢城市夜景和小众咖啡店。', friendshipState: 'temporary', updatedAt: 1,
      },
      transcript: [{ sender: 'user', content: '你也喜欢拍夜景吗？' }, { sender: 'stranger', content: '嗯，尤其喜欢雨后的街灯。' }],
    });
    expect(Array.from(card.description).length).toBeLessThanOrEqual(15);
    for (const section of ['【基础身份】', '【外貌特征】', '【性格核心】', '【与用户关系】', '【沟通风格】', '【互动指南】', '【生活习惯】', '【特殊设定】']) {
      expect(card.systemPrompt).toContain(section);
    }
    expect(card.systemPrompt).toContain('摇一摇');
    expect(card.systemPrompt).not.toMatch(/未知|待补充|以资料为准/);
  });
});
