import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
    fileURLToPath(new URL('../components/date/story/StoryTheaterSession.tsx', import.meta.url)),
    'utf8',
).replace(/\r\n?/g, '\n');

const archivedBlock = source.slice(
    source.indexOf('const archived = mirrorArchived(message, entry);'),
    source.indexOf("if (message.role === 'user') return <section", source.indexOf('const archived = mirrorArchived(message, entry);')),
);

describe('剧情正常记忆归档原文入口', () => {
    it('真实时间陪伴归档后仍使用可展开原文的 details，而不是不可点击占位', () => {
        expect(archivedBlock).toContain("entry.writesToCharacterMemory\n                                ? '已作为正常记忆归档'");
        expect(archivedBlock).toContain('展开查看原文');
        expect(archivedBlock).toContain('<details key={message.id}');
        expect(archivedBlock).toContain('open={isExpanded}');
        expect(archivedBlock).toContain('{isExpanded && <div');
        expect(archivedBlock).not.toContain('if (entry.writesToCharacterMemory) return <div');
    });

    it('分页、批量展开和完整导出接线不会退化', () => {
        expect(source).toContain('const STORY_PAGE_SIZE = 10;');
        expect(source).toContain('messages.slice(messagePage * STORY_PAGE_SIZE');
        expect(source).toContain("allPageArchivesExpanded ? '全部收起' : '全部展开'");
        expect(source).toContain("title='导出全部剧情原文'");
        expect(source).toContain("<StoryPagination className='mt-8'");
    });
});
