import { describe, expect, it } from 'vitest';
import {
    buildQixiMemoryBundlePhasePrompt,
    buildQixiMemoryBundlePrompt,
    normalizeQixiPhaseChunk,
    parseQixiMemoryBundle,
    parseQixiProgressiveMemoryBundle,
    QIXI_MEMORY_BUNDLE_VERSION,
    QIXI_PART1_FIRST_SCENE_IDS,
    QIXI_PART1_SECOND_SCENE_IDS,
    QIXI_PART1_THIRD_SCENE_IDS,
    QIXI_PART1_TIMEOUT_MS,
    QIXI_RECALL_MAX_OUTPUT_ITEMS,
    QIXI_SCENE_IDS,
} from './qixiMemoryBundle';

const evidence = Array.from({ length: 20 }, (_, index) => ({
    id: `e${index + 1}`,
    fact: `第 ${index + 1} 条真实聊天记忆。`,
    object: `物件${index + 1}`,
    tags: ['日常'],
}));

const artifacts = Array.from({ length: 16 }, (_, index) => ({
    id: `a${index + 1}`,
    label: `性格词${index + 1}`,
    kind: 'trait',
    evidenceIds: [`e${index + 1}`],
}));

const makeScene = (sceneId: string, index: number) => ({
    transitionLines: [`第${index + 1}站直接接住上一站的动作。`],
    sharedObject: `第${index + 1}站物件`,
    memoryLine: `第${index + 1}站由模型直接生成的最终演出。`,
    options: sceneId === 'wordCloud' ? [] : [0, 1, 2].map(optionIndex => ({
        id: `${sceneId}-${optionIndex + 1}`,
        label: `模型选项 ${optionIndex + 1}`,
        result: `模型结果 ${optionIndex + 1}`,
        ...(sceneId === 'lostLayer' ? { charReply: `模型回复 ${optionIndex + 1}` } : {}),
        evidenceIds: [`e${index + 1}`],
    })),
    charAction: `模型为第${index + 1}站写下的角色动作。`,
    charVisibleText: sceneId === 'lostLayer' ? '别挡路。' : sceneId === 'doubleWish' ? '这是我自己的愿望。' : '',
    charMutter: sceneId === 'lostLayer' ? '啧。' : undefined,
    charContribution: sceneId === 'offerings' ? '一颗糖' : undefined,
    charQuips: sceneId === 'wordCloud' ? ['第一句', '第二句', '第三句'] : ['模型碎碎念'],
    reveal: `模型为第${index + 1}站写下的结果。`,
    artifactIds: sceneId === 'wordCloud' ? artifacts.map(item => item.id) : [`a${index + 1}`],
    charSelectionIds: sceneId === 'wordCloud' ? ['a1', 'a3', 'a5'] : [],
});

const validBundle = {
    openingChat: ['第一句正常聊天。', '第二句正常聊天。'],
    charLayerColor: '#82D5B8',
    charPerformance: { tempo: 'brisk', markStyle: 'precise', presence: 'direct' },
    evidence,
    artifacts,
    scenes: Object.fromEntries(QIXI_SCENE_IDS.map((sceneId, index) => [sceneId, makeScene(sceneId, index)])),
};

describe('Qixi direct LLM script pipeline', () => {
    it('asks the model for final playable content while keeping the four-call contract', () => {
        const prompt = buildQixiMemoryBundlePrompt({ name: 'Char' } as any, { name: 'User' } as any);
        expect(QIXI_MEMORY_BUNDLE_VERSION).toBe(19);
        expect(QIXI_PART1_TIMEOUT_MS).toBe(600_000);
        expect(QIXI_RECALL_MAX_OUTPUT_ITEMS).toBe(20);
        expect(prompt).toContain('直接生成玩家最终会看见、点击和经历的完整剧本');
        expect(prompt).toContain('不要输出供本地代码二次创作的素材或摘要');
        expect(prompt).toContain('前六站必须各提供恰好 3 个完整 options');
        expect(prompt).toContain('叙事视角必须分开');
        expect(prompt).toContain('面向玩家时，用第二人称“你 / 你的”');
        expect(prompt).toContain('禁止写“User / 用户 / 玩家 / 该用户');
        expect(prompt).toContain('对 Char 本人有意义');
        expect(prompt).toContain('具体【私物】');
        expect(prompt).toContain('不要求来自共同记忆，不要求与 User 有关');
        expect(prompt).toContain('绝不能默认写成特意送给 User 的礼物');
        expect(prompt).toContain('还被迫完成一连串莫名其妙的小游戏');
        expect(prompt).toContain('第七站结束也只到强烈怀疑');
        expect(prompt).toContain('Part 1 中 Char 绝不能说出');
        expect(prompt).toContain('纯粹自己想买的 charContribution');
        expect(prompt).toContain('默认禁止吃醋、嫉妒、情敌、占有欲宣言');
    });

    it('keeps Part 1 serially split into 2 + 3 + 2 rooms', () => {
        const first = buildQixiMemoryBundlePhasePrompt({ name: 'Char' } as any, { name: 'User' } as any, undefined, 'first');
        const second = buildQixiMemoryBundlePhasePrompt({ name: 'Char' } as any, { name: 'User' } as any, undefined, 'second', '{"completedScenes":{}}');
        const third = buildQixiMemoryBundlePhasePrompt({ name: 'Char' } as any, { name: 'User' } as any, undefined, 'third', '{"completedScenes":{}}');
        expect(QIXI_PART1_FIRST_SCENE_IDS).toEqual(['lostLayer', 'doubleWish']);
        expect(QIXI_PART1_SECOND_SCENE_IDS).toEqual(['threadNeedle', 'offerings', 'reflection']);
        expect(QIXI_PART1_THIRD_SCENE_IDS).toEqual(['nightMarket', 'wordCloud']);
        expect(first).toContain('最终可播放内容');
        expect(second).toContain('threadNeedle、offerings、reflection');
        expect(third).toContain('nightMarket、wordCloud');
    });

    it('delivers generated rooms progressively without filling future rooms with local copy', () => {
        const common = {
            openingChat: validBundle.openingChat,
            charLayerColor: validBundle.charLayerColor,
            charPerformance: validBundle.charPerformance,
            evidence,
            artifacts,
        };
        const firstScenes = Object.fromEntries(QIXI_PART1_FIRST_SCENE_IDS.map(id => [id, validBundle.scenes[id]]));
        const firstReady = parseQixiProgressiveMemoryBundle(common, firstScenes, 'ctx');
        expect(firstReady?.personalizedSceneIds).toEqual(QIXI_PART1_FIRST_SCENE_IDS);
        expect(firstReady?.scenes.lostLayer.sharedObject).toBe('第1站物件');
        expect(firstReady?.scenes.threadNeedle.sharedObject).toBe('');
        expect(firstReady?.scenes.threadNeedle.options).toEqual([]);
    });

    it('accepts middle-room scripts wrapped, arrayed, aliased, or returned without a scenes envelope', () => {
        const middleScenes = QIXI_PART1_SECOND_SCENE_IDS.map((id, index) => makeScene(id, index + 2));
        const arrayWrapped = normalizeQixiPhaseChunk({
            result: { rooms: middleScenes },
        }, QIXI_PART1_SECOND_SCENE_IDS);
        expect(Object.keys(arrayWrapped.scenes)).toEqual(QIXI_PART1_SECOND_SCENE_IDS);
        expect(arrayWrapped.scenes.threadNeedle.sharedObject).toBe('第3站物件');

        const aliased = normalizeQixiPhaseChunk({
            part2: {
                scene_3: middleScenes[0],
                供果: middleScenes[1],
                reflection_room: middleScenes[2],
            },
        }, QIXI_PART1_SECOND_SCENE_IDS);
        expect(aliased.scenes.threadNeedle.charAction).toContain('第3站');
        expect(aliased.scenes.offerings.charAction).toContain('第4站');
        expect(aliased.scenes.reflection.charAction).toContain('第5站');

        const third = normalizeQixiPhaseChunk({
            rooms: [makeScene('nightMarket', 5), makeScene('wordCloud', 6)],
            bridgeData: {
                userBirds: [{ name: '用户侧' }],
                charNodes: [{ name: '角色侧' }],
                finalBird: { name: 'User' },
            },
        }, QIXI_PART1_THIRD_SCENE_IDS);
        expect(third.bridge.userMagpies[0].name).toBe('用户侧');
        expect(third.bridge.charMagpies[0].name).toBe('角色侧');
        expect(third.bridge.finalMagpie.name).toBe('User');
    });

    it('preserves model prose and all three choices without semantic filtering or local replacement', () => {
        const raw = structuredClone(validBundle);
        raw.scenes.lostLayer.charAction = '这是一段完全由角色自由决定的古怪动作。';
        raw.scenes.lostLayer.options[0].evidenceIds = ['missing-evidence'];
        raw.scenes.doubleWish.options[0].label = '只祝你今天开心';
        raw.scenes.doubleWish.charVisibleText = '希望我自己变勇敢。';
        raw.scenes.doubleWish.charQuips = ['系统提示也可以是这个角色故意说的话。'];
        const parsed = parseQixiMemoryBundle(JSON.stringify(raw));
        expect(parsed?.scenes.lostLayer.charAction).toBe(raw.scenes.lostLayer.charAction);
        expect(parsed?.scenes.lostLayer.options).toHaveLength(3);
        expect(parsed?.scenes.lostLayer.options[0].evidenceIds).toEqual(['missing-evidence']);
        expect(parsed?.scenes.doubleWish.options[0].label).toBe('只祝你今天开心');
        expect(parsed?.scenes.doubleWish.charVisibleText).toBe('希望我自己变勇敢。');
        expect(parsed?.scenes.doubleWish.charQuips).toEqual(['系统提示也可以是这个角色故意说的话。']);
        expect(parsed?.repairNotes).toBeUndefined();
    });

    it('tolerates harmless shape drift without inventing visible content', () => {
        const raw: any = structuredClone(validBundle);
        raw.openingChat = '第一句正常聊天。\n第二句正常聊天。';
        raw.scenes.lostLayer.transitionLines = '上一句。\n下一句。';
        raw.scenes.lostLayer.charQuips = '碎碎念一。\n碎碎念二。';
        raw.scenes.lostLayer.options = Object.fromEntries(raw.scenes.lostLayer.options.map((item: any, index: number) => [`choice${index}`, item]));
        const parsed = parseQixiMemoryBundle(`\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``);
        expect(parsed?.openingChat).toEqual(['第一句正常聊天。', '第二句正常聊天。']);
        expect(parsed?.scenes.lostLayer.transitionLines).toEqual(['上一句。', '下一句。']);
        expect(parsed?.scenes.lostLayer.charQuips).toEqual(['碎碎念一。', '碎碎念二。']);
        expect(parsed?.scenes.lostLayer.options).toHaveLength(3);
    });

    it('parses the bridge as generated content without rewriting its character line', () => {
        const parsed = parseQixiMemoryBundle(JSON.stringify({
            ...validBundle,
            bridge: {
                userMagpies: [{ evidenceId: 'e1', name: '别针', memory: '那一回的别针。', visualHint: '银色细线' }],
                charMagpies: [{ evidenceId: 'e2', name: '夜灯', memory: '那盏没有关的灯。', visualHint: '暖色光点' }],
                finalMagpie: { name: '条条', line: '原来跑到这里了。', visualHint: '名字发亮' },
            },
        }), '', undefined, '条条');
        expect(parsed?.bridge?.finalMagpie.line).toBe('原来跑到这里了。');
        expect(parsed?.bridge?.finalMagpie.name).toBe('条条');
    });

    it('only fails when the response is not structurally readable at all', () => {
        expect(parseQixiMemoryBundle('这不是 JSON')).toBeNull();
        expect(parseQixiMemoryBundle(JSON.stringify({ openingChat: ['有内容但没有 scenes'] }))).toBeNull();
    });
});
