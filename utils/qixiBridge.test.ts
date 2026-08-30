import { describe, expect, it } from 'vitest';
import { buildQixiBridgePrompt, createQixiBridgeFallback, parseQixiBridge, prepareQixiBridge } from './qixiBridge';
import { QixiMemoryBundle, QIXI_MEMORY_BUNDLE_VERSION } from './qixiMemoryBundle';

const bundle = {
    version: QIXI_MEMORY_BUNDLE_VERSION,
    source: 'memory',
    openingChat: ['刚才回我了吗？', '我这里没看到。'],
    charLayerColor: '#82D5B8',
    charPerformance: { tempo: 'measured', markStyle: 'soft', presence: 'careful' },
    evidence: [1, 2, 3, 4].map(index => ({ id: `e${index}`, fact: `第 ${index} 条可以核对的真实记忆。`, object: `物件${index}`, tags: ['日常'] })),
    artifacts: [1, 2, 3, 4].map(index => ({ id: `a${index}`, label: `物件${index}`, kind: 'object', evidenceIds: [`e${index}`] })),
    scenes: {} as QixiMemoryBundle['scenes'],
    personalizedSceneIds: [],
    generatedAt: 1,
    contextSignature: 'ctx',
} as QixiMemoryBundle;

describe('qixi bridge parser', () => {
    it('reuses the bridge embedded in Part 1b without making another model request', async () => {
        const embedded = parseQixiBridge(JSON.stringify({
            userMagpies: [{ evidenceId: 'e1', name: '物件一', memory: '第一条可以核对的真实记忆。', visualHint: '一粒暖色文字' }],
            charMagpies: [{ evidenceId: 'e2', name: '物件二', memory: '第二条可以核对的真实记忆。', visualHint: '一缕冷色细线' }],
            finalMagpie: { name: '条条', line: '总算让我找到你了。', visualHint: '对岸亮起的名字' },
        }), bundle, '条条');
        expect(embedded).not.toBeNull();

        const prepared = await prepareQixiBridge(
            { name: '条条' } as any,
            { ...bundle, bridge: embedded! },
        );
        expect(prepared).toEqual(embedded);
    });

    it('keeps the model bridge intact instead of semantically filtering or rewriting it', () => {
        const parsed = parseQixiBridge(JSON.stringify({
            userMagpies: [
                { evidenceId: 'e1', name: '物件一', memory: '第一条真实记忆的极短说明。', visualHint: '一粒暖色文字' },
                { evidenceId: 'missing', name: '编造节点', memory: '这条不应进入鹊桥。', visualHint: '不存在的剪影' },
            ],
            charMagpies: [
                { evidenceId: 'e2', name: '物件二', memory: '第二条真实记忆的另一侧说明。', visualHint: '一缕冷色细线' },
            ],
            finalMagpie: { name: '错误名字', line: '原来你在这里。', visualHint: '对岸亮起的名字' },
        }), bundle, '条条');
        expect(parsed?.userMagpies.map(node => node.evidenceId)).toEqual(['e1', 'missing']);
        expect(parsed?.charMagpies.map(node => node.evidenceId)).toEqual(['e2']);
        expect(parsed?.nodes.some(node => node.evidenceId === 'missing')).toBe(true);
        expect(parsed?.finalMagpie.name).toBe('错误名字');
    });

    it('splits verified evidence across the two banks without inventing memories', () => {
        const fallback = createQixiBridgeFallback(bundle, '条条');
        expect(fallback.nodes).toHaveLength(4);
        expect(fallback.userMagpies).toHaveLength(2);
        expect(fallback.charMagpies).toHaveLength(2);
        expect(fallback.nodes.every(node => node.evidenceId?.startsWith('e'))).toBe(true);
        expect(fallback.nodes[0].memory).toBe(bundle.evidence[0].fact);
        expect(fallback.finalMagpie.name).toBe('条条');
    });

    it('makes the Part 2 contract explicit about both banks and the named final magpie', () => {
        const prompt = buildQixiBridgePrompt(bundle, [], '条条');
        expect(prompt).toContain('userMagpies');
        expect(prompt).toContain('charMagpies');
        expect(prompt).toContain('finalMagpie.name 固定为“条条”');
        expect(prompt).toContain('不重新发明事实');
        expect(prompt).toContain('尚未亲眼确认');
        expect(prompt).toContain('身份确认留给最终见面');
    });
});
