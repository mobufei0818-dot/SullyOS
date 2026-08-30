import { describe, expect, it } from 'vitest';

import type { Anticipation, MemoryNode } from './types';
import { MemoryNodeDB } from './db';
import { expandAndFormat } from './formatter';

// 便利贴不占召回名额、每轮全量注入，置顶最长 30 天；窗台期盼里的 anchor 更是长期挂着。
// 两处以前都是裸注入——只把事情摆出来，没说该怎么对待它。结果就是角色一旦记下一件事，
// 之后每段结尾都在追问进展、催对方快去办。
//
// 同仓库里 Notion 笔记块（chatPrompts 的「不要每次都提」）和用药提醒（lifeRecords 的
// 「别反复催」）早就配了同类措辞，这两处补齐后别再退回去。

const charId = 'char-pinned-restraint';

const pinnedNode = (id: string, content: string): MemoryNode => ({
    id,
    charId,
    content,
    room: 'user_room',
    tags: [],
    importance: 6,
    mood: 'neutral',
    embedded: true,
    createdAt: Date.now() - 24 * 60 * 60 * 1000,
    lastAccessedAt: Date.now(),
    accessCount: 0,
    eventBoxId: null,
    pinnedUntil: Date.now() + 3 * 24 * 60 * 60 * 1000,
});

const anticipation = (id: string, content: string, status: Anticipation['status']): Anticipation => ({
    id,
    charId,
    content,
    status,
    createdAt: Date.now() - 24 * 60 * 60 * 1000,
} as Anticipation);

describe('便利贴与窗台期盼的分寸措辞', () => {
    it('便利贴摆出来的同时说清「记着不等于要一直说」', async () => {
        await MemoryNodeDB.save(pinnedNode('pin-1', '小明后天要考试'));
        const out = await expandAndFormat([], charId, [], '小明');

        expect(out).toContain('便利贴（近期重要事项）');
        expect(out).toContain('小明后天要考试');
        // 对症的三件事：别每轮都说、别追问进展、别替对方安排时间
        expect(out).toContain('记着不等于要一直说');
        expect(out).toContain('不必每次聊天都追问进展');
        expect(out).toContain('不必替 ta 安排什么时候去做');
    });

    it('窗台期盼同样带分寸，别被当成待办清单', async () => {
        const out = await expandAndFormat(
            [], charId, [anticipation('ant-1', '想一起去看海', 'active')], '小明',
        );

        expect(out).toContain('窗台期盼');
        expect(out).toContain('想一起去看海');
        expect(out).toContain('不是待办清单');
        expect(out).toContain('不必每次都提起来');
    });

    it('没有便利贴也没有期盼时，这两句都不该凭空出现', async () => {
        const out = await expandAndFormat([], 'char-empty-restraint', [], '小明');
        expect(out).toBe('');
    });
});
