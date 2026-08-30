import { describe, expect, it } from 'vitest';
import {
  appendPendingAvatarTouch,
  buildAvatarTouchSystemPrompt,
  applyAvatarTouchForce,
  buildAvatarTouchReactionPackPrompt,
  buildPendingAvatarTouchContext,
  buildImmediateTouchPerformance,
  avatarTouchTargetLabel,
  normalizeCompanionDialogue,
  parseAvatarTouchReactionPack,
  parseAvatarTouchReactionPackPartial,
  consumePendingAvatarTouches,  isAvatarTouchGesture,
  normalizeAvatarTouchZone,
  resolveAvatarTouchRegion,
  resolveAvatarTouchTarget,
  resolveAvatarTouchForce,
  parseAvatarTouchReply,
  type AvatarTouchRecord,
} from './avatarTouch';

describe('角色触碰互动', () => {
  it('优先按模型原生命中区识别语义区域，并在缺失时使用几何回退', () => {
    expect(normalizeAvatarTouchZone(['HitAreaHead'])).toBe('head');
    expect(normalizeAvatarTouchZone(['脸颊'])).toBe('face');
    expect(normalizeAvatarTouchZone(['Arm_L'])).toBe('hand');
    expect(normalizeAvatarTouchZone([], 0.2, 0.5)).toBe('face');
    expect(normalizeAvatarTouchZone([], 0.5, 0.1)).toBe('hand');
    expect(normalizeAvatarTouchZone([], 0.55, 0.5)).toBe('body');
  });

  it('在兼容旧反馈分区的同时细分头发、脸、肩膀、手臂、手和胸口', () => {
    expect(resolveAvatarTouchTarget(['FrontHair'])).toEqual({ zone: 'head', part: 'hair' });
    expect(resolveAvatarTouchTarget(['Face'])).toEqual({ zone: 'face', part: 'face' });
    expect(resolveAvatarTouchTarget(['LeftShoulder'])).toEqual({ zone: 'body', part: 'shoulder' });
    expect(resolveAvatarTouchTarget(['Arm_L'])).toEqual({ zone: 'hand', part: 'arm' });
    expect(resolveAvatarTouchTarget(['RightHand'])).toEqual({ zone: 'hand', part: 'hand' });
    expect(resolveAvatarTouchTarget(['Bust'])).toEqual({ zone: 'body', part: 'chest' });
  });

  it('用模型内坐标拆分只有 Head/Body 粗命中区的 Live2D 模型', () => {
    expect(resolveAvatarTouchTarget(['HitAreaHead'], 0.08, 0.5).part).toBe('hair');
    expect(resolveAvatarTouchTarget(['HitAreaHead'], 0.25, 0.5).part).toBe('face');
    expect(resolveAvatarTouchTarget(['HitAreaBody'], 0.42, 0.3).part).toBe('shoulder');
    expect(resolveAvatarTouchTarget(['HitAreaBody'], 0.58, 0.08).part).toBe('arm');
    expect(resolveAvatarTouchTarget(['HitAreaBody'], 0.58, 0.5).part).toBe('chest');
    expect(avatarTouchTargetLabel({ zone: 'body', part: 'chest' })).toBe('胸口');
  });

  it('优先使用每个模型自己的圈选区域，重叠时选择更小的区域', () => {
    const regions = [
      { id: 'head', zone: 'head' as const, shape: 'ellipse' as const, x: 0.5, y: 0.25, width: 0.5, height: 0.45 },
      { id: 'face', zone: 'face' as const, shape: 'ellipse' as const, x: 0.5, y: 0.3, width: 0.24, height: 0.2 },
    ];

    expect(resolveAvatarTouchRegion(regions, 0.5, 0.3)).toMatchObject({ zone: 'face', part: 'face', regionId: 'face' });
    expect(resolveAvatarTouchRegion(regions, 0.38, 0.2)).toMatchObject({ zone: 'head', part: 'head', regionId: 'head' });
    expect(resolveAvatarTouchRegion(regions, 0.9, 0.9)).toBeNull();
  });

  it('即时本地反馈不会等待模型台词', () => {
    expect(buildImmediateTouchPerformance('face')).toMatchObject({
      emotion: 'surprised',
      gesture: 'shy',
      faces: ['blush'],
    });
    expect(buildImmediateTouchPerformance('hand').gesture).toBe('wave');
  });

  it('只把短距离单指点击视为触碰，拖拽和双指不会误触', () => {
    expect(isAvatarTouchGesture(4, 220, true)).toBe(true);
    expect(isAvatarTouchGesture(18, 220, true)).toBe(false);
    expect(isAvatarTouchGesture(2, 900, true)).toBe(false);
    expect(isAvatarTouchGesture(2, 220, false)).toBe(false);
  });

  it('优先读取触控压力，并用按压时长为无压力设备补出力度', () => {
    const lightMouse = resolveAvatarTouchForce({ pointerType: 'mouse', pressure: 0.5, durationMs: 70 });
    const heldMouse = resolveAvatarTouchForce({ pointerType: 'mouse', pressure: 0.5, durationMs: 560 });
    const firmPen = resolveAvatarTouchForce({ pointerType: 'pen', pressure: 0.9, durationMs: 90 });
    expect(lightMouse).toBeLessThan(heldMouse);
    expect(firmPen).toBeGreaterThan(heldMouse);
    expect(applyAvatarTouchForce(buildImmediateTouchPerformance('face'), {
      pointerType: 'pen', pressure: 0.95, durationMs: 80,
    }).intensity).toBeGreaterThan(buildImmediateTouchPerformance('face').intensity);
    expect(applyAvatarTouchForce({
      ...buildImmediateTouchPerformance('body'), intensity: 0.2,
    }, {
      pointerType: 'mouse', durationMs: 70,
    }).intensity).toBeGreaterThan(0.6);
  });

  it('触碰提示使用完整 ContextBuilder 输入并明确近期关系约束', () => {
    const prompt = buildAvatarTouchSystemPrompt(
      'FULL_CONTEXT_WITH_RECENT_MEMORY',
      'Sully',
      '条条',
      { zone: 'head', rawAreas: ['Head'] },
      [{ id: 'wave-special', name: '专属挥手', kind: 'motion', tags: ['wave', 'happy'] }],
    );
    expect(prompt).toContain('FULL_CONTEXT_WITH_RECENT_MEMORY');
    expect(prompt).toContain('近期对话与记忆');
    expect(prompt).toContain('wave-special');
    expect(prompt).toContain('[motion / wave / happy]');
    expect(prompt).toContain('表情只是叠加层，不是完整演出');
    expect(prompt).toContain('0.68-1.0');
    expect(prompt).not.toContain('表演人格');
  });

  it('静态单图只要求台词，见面立绘只要求五类表情', () => {
    const textPrompt = buildAvatarTouchReactionPackPrompt(
      'CONTEXT', 'Sully', '条条', ['head'], [], 3, '', 'text',
    );
    expect(textPrompt).toContain('只有一张 PNG / GIF');
    expect(textPrompt).toContain('不要输出 performance');
    expect(textPrompt).not.toContain('模型专属动作白名单');

    const expressionPrompt = buildAvatarTouchReactionPackPrompt(
      'CONTEXT', 'Sully', '条条', ['face'], [], 3, '', 'expression',
    );
    expect(expressionPrompt).toContain('normal / happy / angry / sad / shy');
    expect(expressionPrompt).toContain('只需要为每句选择 emotion');
    expect(expressionPrompt).not.toContain('intensity 使用 0.68-1.0');
  });

  it('解析台词和演出指令，并丢弃白名单外动作', () => {
    const allowed = parseAvatarTouchReply({
      content: '[[AVATAR: emotion=happy; gesture=tilt; model_action=wave-special]]\n别把我的头发揉乱啦。',
    }, [{ id: 'wave-special', name: '专属挥手' }]);
    expect(allowed).toMatchObject({
      text: '别把我的头发揉乱啦。',
      performance: { emotion: 'happy', gesture: 'tilt', modelAction: 'wave-special' },
    });

    const blocked = parseAvatarTouchReply({
      content: '[[AVATAR: emotion=angry; model_action=not-allowed]]\n住手。',
    }, [{ id: 'wave-special', name: '专属挥手' }]);
    expect(blocked?.performance.modelAction).toBeUndefined();
  });

  it('只在下一次正常发言里批量描述尚未回应的戳戳', () => {
    const records: AvatarTouchRecord[] = [
      { id: 'touch-1', zone: 'head', part: 'hair', rawAreas: ['Hair'], timestamp: 100 },
      { id: 'touch-2', zone: 'head', part: 'hair', rawAreas: ['Hair'], timestamp: 200 },
      { id: 'touch-3', zone: 'face', rawAreas: ['Face'], timestamp: 300 },
    ];
    const context = buildPendingAvatarTouchContext(records, 'Sully', '条条');
    expect(context).toContain('条条在开口前连续戳了Sully3次');
    expect(context).toContain('头发2次');
    expect(context).toContain('脸颊1次');
    expect(context).toContain('回答用户本轮话语时自然地顺带接住');
    expect(context).toContain('不要把触碰当成一条单独的新消息');
    expect(buildPendingAvatarTouchContext([], 'Sully', '条条')).toBe('');
  });

  it('戳戳队列有上限，并且只消费已经随本轮发出去的快照', () => {
    const first: AvatarTouchRecord = { id: 'touch-1', zone: 'head', rawAreas: [], timestamp: 100 };
    const second: AvatarTouchRecord = { id: 'touch-2', zone: 'face', rawAreas: [], timestamp: 200 };
    const arrivedWhileThinking: AvatarTouchRecord = { id: 'touch-3', zone: 'hand', rawAreas: [], timestamp: 300 };
    const queued = appendPendingAvatarTouch(
      appendPendingAvatarTouch(
        appendPendingAvatarTouch([], first, 2),
        second,
        2,
      ),
      arrivedWhileThinking,
      2,
    );
    expect(queued.map(record => record.id)).toEqual(['touch-2', 'touch-3']);
    expect(consumePendingAvatarTouches([first, second, arrivedWhileThinking], [first, second]))
      .toEqual([arrivedWhileThinking]);
  });

  it('cleans dialogue-only text before the typewriter renders it', () => {
    expect(normalizeCompanionDialogue('**Sully：** “手的......” “呢......”', 'Sully'))
      .toBe('手的……\n呢……');
    expect(normalizeCompanionDialogue('```text\n「别闹......会痒。」\n```'))
      .toBe('别闹……会痒。');
  });

  it('parses one cached reaction pack for every selected zone', () => {
    const pack = parseAvatarTouchReactionPack(JSON.stringify({
      head: [
        '[[AVATAR: emotion=happy; gesture=tilt; gaze=viewer; intensity=0.7]]\n“别把我的头发揉乱啦......”',
        '[[AVATAR: emotion=calm; gesture=nod; gaze=viewer; intensity=0.5]]\n再摸一下也不是不可以。',
      ],
      hand: [
        '[[AVATAR: emotion=surprised; gesture=wave; model_action=wave-special]]\n牵住了就别松开。',
      ],
    }), ['head', 'hand'], [{ id: 'wave-special', name: '专属挥手' }]);

    expect(pack?.head).toHaveLength(2);
    expect(pack?.head?.[0].text).toBe('别把我的头发揉乱啦……');
    expect(pack?.hand?.[0].performance.modelAction).toBe('wave-special');
  });

  it('rejects an incomplete pack instead of falling back to per-tap requests', () => {
    expect(parseAvatarTouchReactionPack('{"head":["摸摸头。"]}', ['head', 'face']))
      .toBeNull();
  });
  it('repairs fenced JSON, trailing commas, aliases, and structured reaction objects', () => {
    const pack = parseAvatarTouchReactionPack({
      content: `Here is the pack:
\`\`\`json
{
  "reactions": {
    "hair": { "items": [
      { "dialogue": "别把我的头发弄乱。", "performance": { "emotion": "happy", "gesture": "tilt", "intensity": 0.7 } }
    ] },
    "arm": [

      { "reply": "牵住了就别松开。", "emotion": "surprised", "gesture": "wave" }
    ],
  },
}
\`\`\`
Thanks!`,
    }, ['head', 'hand']);

    expect(pack?.head?.[0]).toMatchObject({
      text: '别把我的头发弄乱。',
      performance: { emotion: 'happy', gesture: 'tilt' },
    });
    expect(pack?.hand?.[0]).toMatchObject({
      text: '牵住了就别松开。',
      performance: { emotion: 'surprised', gesture: 'wave' },
    });
  });

  it('accepts the exact Chinese labels shown to the model and user', () => {
    const pack = parseAvatarTouchReactionPack({
      choices: [{ message: { content: JSON.stringify({
        '手或手臂': [{ text: '手给你。', performance: { emotion: 'happy', gesture: 'wave', camera: 'medium', gaze: 'viewer', intensity: 0.7 } }],
        '肩膀或身体': [{ text: '别突然靠这么近。', performance: { emotion: 'surprised', gesture: 'lean-back', camera: 'medium', gaze: 'viewer', intensity: 0.7 } }],
        '角色身边': [{ text: '站这里就好。', performance: { emotion: 'calm', gesture: 'idle', camera: 'wide', gaze: 'viewer', intensity: 0.5 } }],
      }) } }],
    }, ['hand', 'body', 'other']);

    expect(pack?.hand?.[0].text).toBe('手给你。');
    expect(pack?.body?.[0].performance.gesture).toBe('lean-back');
    expect(pack?.other?.[0].text).toBe('站这里就好。');
  });

  it('flattens array-style zone groups and content-block responses', () => {
    const content = JSON.stringify([
      {
        zone: 'hand',
        reactions: [{ text: '牵好。', performance: { emotion: 'happy', gesture: 'wave', camera: 'medium', gaze: 'viewer', intensity: 0.6 } }],
      },
      {
        zone: 'body',
        items: [{ text: '轻一点。', performance: { emotion: 'calm', gesture: 'idle', camera: 'medium', gaze: 'viewer', intensity: 0.5 } }],
      },
    ]);
    const pack = parseAvatarTouchReactionPack({
      choices: [{ message: { content: [{ type: 'text', text: content }] } }],
    }, ['hand', 'body']);

    expect(pack?.hand?.[0].text).toBe('牵好。');
    expect(pack?.body?.[0].text).toBe('轻一点。');
  });

  it('asks for structured reaction objects under exact English zone ids', () => {
    const prompt = buildAvatarTouchReactionPackPrompt('FULL_CONTEXT', 'Sully', '条条', ['hand', 'body'], [
      { id: 'body-recoil', name: '身体后缩', kind: 'motion', tags: ['lean-back', 'surprised'] },
    ], 4, 'ja');

    expect(prompt).toContain('顶层键必须逐字使用上面的英文部位 ID');
    expect(prompt).toContain('"text": "第1句角色台词"');
    expect(prompt).toContain('"translation": "第1句日本語口语译文"');
    expect(prompt).toContain('text 是界面显示的原文，必须使用简体中文');
    expect(prompt).toContain('"performance"');
    expect(prompt).toContain('body-recoil: 身体后缩 [motion / lean-back / surprised]');
    expect(prompt).toContain('faces 变化视为不完整');
  });

  it('keeps source text and spoken translation separate for a selected voice language', () => {
    const raw = {
      head: [{
        text: '别把我的头发揉乱。',
        translation: '髪をくしゃくしゃにしないで。',
        performance: { emotion: 'happy', gesture: 'tilt', camera: 'medium', gaze: 'viewer', intensity: 0.7 },
      }],
    };
    const pack = parseAvatarTouchReactionPack(raw, ['head'], [], 'ja');
    expect(pack?.head?.[0]).toMatchObject({
      text: '别把我的头发揉乱。',
      translation: '髪をくしゃくしゃにしないで。',
    });
    expect(parseAvatarTouchReactionPack({
      head: [{ text: '缺少译文。', performance: { emotion: 'calm', gesture: 'idle' } }],
    }, ['head'], [], 'ja')).toBeNull();
  });

  it('keeps valid zones visible to diagnostics without issuing a repair request', () => {
    const pack = parseAvatarTouchReactionPackPartial(`
head:
- [[AVATAR: emotion=happy; gesture=tilt]] 别揉乱我的头发。

face:
1. [[AVATAR: emotion=surprised; gesture=shy]] ……别突然碰脸。
`, ['head', 'face', 'hand']);

    expect(pack.head?.[0].text).toContain('别揉乱');
    expect(pack.face?.[0].performance.gesture).toBe('shy');
    expect(pack.hand).toBeUndefined();
  });
});
