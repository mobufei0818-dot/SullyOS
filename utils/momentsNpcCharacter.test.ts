import { afterEach, describe, expect, it, vi } from 'vitest';
import { planMomentsNpcCharacterProfile, planMomentsStrangerCharacterProfile } from './momentsApi';

describe('明确 NPC 转正式角色', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('副 API 不可用时也用协同工作 character-card 原生字段保底', async () => {
    const card = await planMomentsNpcCharacterProfile({
      config: { source: 'custom', enabled: false, baseUrl: '', apiKey: '', model: '' },
      npc: {
        id: 'moments:npc:xieyou:chuci', actorType: 'npc', displayName: '楚辞',
        bio: '性格直爽，经常沦为谢侑抽象恶搞和段子实验的受害者。',
        relationLabel: '高中同桌兼合租室友', parentCharacterId: 'xieyou', friendshipState: 'temporary', updatedAt: 1,
      },
      sourceCharacter: { name: '谢侑', description: '嘴硬心软的设计师', systemPrompt: '谢侑的完整人设', worldview: '现代都市' },
      user: { name: '林焕培', bio: '建筑设计师' },
      relatedMemories: ['谢侑和楚辞高中时是同桌。', '两人现在合租。'],
      collaborationContext: '[System: Focused Collaboration Character Context]\n谢侑的完整人设\n互动对象：林焕培',
    });

    expect(card.name).toBe('楚辞');
    expect(card.description).toContain('性格直爽');
    expect(card.systemPrompt).toContain('谢侑');
    expect(card.systemPrompt).toContain('高中同桌兼合租室友');
    expect(card.systemPrompt).toContain('性格直爽');
    expect(card.systemPrompt).toContain('谢侑和楚辞高中时是同桌');
    expect(card.worldview).toBe('现代都市');
    expect(card.systemPrompt).not.toContain('【基础身份】');
  });

  it('完整复用协同工作角色卡协议，并传入你们是谁、主角色核心人设和最多五条相关记忆', async () => {
    let requestBody: any;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({
        choices: [{ message: { content: `我按既有关系整理好了。\n\n\`\`\`sully-artifact
kind: character-card
title: 楚辞角色卡
---
{"name":"楚辞","description":"直爽护短的合租室友","systemPrompt":"你是楚辞，和谢侑是高中同桌兼合租室友。你说话直接，但会维护自己的边界。","worldview":"现代都市，既有共同经历均真实有效。"}
\`\`\`` } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const card = await planMomentsNpcCharacterProfile({
      config: { source: 'custom', enabled: true, baseUrl: 'https://example.com/v1', apiKey: 'test', model: 'test-model' },
      npc: {
        id: 'moments:npc:xieyou:chuci', actorType: 'npc', displayName: '楚辞', bio: '性格直爽。',
        relationLabel: '高中同桌兼合租室友', parentCharacterId: 'xieyou', friendshipState: 'temporary', updatedAt: 1,
      },
      sourceCharacter: { name: '谢侑', description: '设计师', systemPrompt: '谢侑的核心人设全文', worldview: '现代都市' },
      user: { name: '林焕培', bio: '用户的自我设定' },
      relatedMemories: ['记忆一', '记忆二', '记忆三', '记忆四', '记忆五', '不应发送的第六条'],
      collaborationContext: '[System: Focused Collaboration Character Context]\n谢侑的核心人设全文\n互动对象：林焕培\n用户的自我设定',
    });

    expect(requestBody.messages[0]).toMatchObject({ role: 'system' });
    expect(requestBody.messages[0].content).toContain('Focused Collaboration Character Context');
    expect(requestBody.messages[0].content).toContain('谢侑的核心人设全文');
    expect(requestBody.messages[0].content).toContain('互动对象：林焕培');
    expect(requestBody.messages[1].content).toContain('```sully-artifact');
    expect(requestBody.messages[1].content).toContain('"worldview"');
    expect(requestBody.messages[2].content).toContain('### 制卡对象');
    expect(requestBody.messages[2].content).toContain('5. 记忆五');
    expect(requestBody.messages[2].content).not.toContain('不应发送的第六条');
    expect(card).toEqual({
      name: '楚辞', description: '直爽护短的合租室友',
      systemPrompt: '你是楚辞，和谢侑是高中同桌兼合租室友。你说话直接，但会维护自己的边界。',
      worldview: '现代都市，既有共同经历均真实有效。',
    });
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
    expect(card.name).toBe('林野');
    for (const section of ['【基础身份】', '【外貌特征】', '【性格核心】', '【与用户关系】', '【沟通风格】', '【互动指南】', '【生活习惯】', '【特殊设定】']) {
      expect(card.systemPrompt).toContain(section);
    }
    expect(card.systemPrompt).toContain('摇一摇');
    expect(card.systemPrompt).not.toMatch(/未知|待补充|以资料为准/);
  });
});
