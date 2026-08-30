import { describe, expect, it, vi } from 'vitest';
import {
    extractPdfDocumentText,
    isPdfFile,
    pdfItemsToText,
    type PdfDocumentLike,
} from './pdfText';

describe('PDF 文本提取', () => {
    it('同时识别 MIME 和扩展名', () => {
        expect(isPdfFile({ name: 'novel.bin', type: 'application/pdf' })).toBe(true);
        expect(isPdfFile({ name: 'novel.PDF', type: '' })).toBe(true);
        expect(isPdfFile({ name: 'novel.txt', type: 'text/plain' })).toBe(false);
    });

    it('合并中文 PDF 的视觉折行，不在半句话中留下换行或空格', () => {
        expect(pdfItemsToText([
            { str: '她抬头看向窗外，夜色正' },
            { str: '', hasEOL: true },
            { str: '一点点漫进房间。', hasEOL: true },
        ])).toBe('她抬头看向窗外，夜色正一点点漫进房间。');
    });

    it('合并英文软换行并去掉行末断词连字符', () => {
        expect(pdfItemsToText([
            { str: 'The sentence was inter-', hasEOL: true },
            { str: 'rupted by a visual line break.', hasEOL: true },
        ])).toBe('The sentence was interrupted by a visual line break.');
    });

    it('保留显式空行和明显的版面段间距', () => {
        expect(pdfItemsToText([
            { str: '第一段。' },
            { str: '', hasEOL: true },
            { str: '', hasEOL: true },
            { str: '第二段。', hasEOL: true },
        ])).toBe('第一段。\n\n第二段。');

        expect(pdfItemsToText([
            { str: '同一段的第一行', hasEOL: true, transform: [12, 0, 0, 12, 40, 700], height: 12 },
            { str: '继续这一段。', hasEOL: true, transform: [12, 0, 0, 12, 40, 686], height: 12 },
            { str: '新的自然段。', hasEOL: true, transform: [12, 0, 0, 12, 40, 650], height: 12 },
        ])).toBe('同一段的第一行继续这一段。\n\n新的自然段。');
    });

    it('页眉或页码更靠左时，仍以正文常用左边界判断软折行', () => {
        expect(pdfItemsToText([
            { str: '夏以星×你 sweet talk', hasEOL: true, transform: [10, 0, 0, 10, 8, 790], height: 10 },
            { str: '但今天你心里想着事情，懒得同他计较，只是抬', hasEOL: true, transform: [12, 0, 0, 12, 42, 720], height: 12 },
            { str: '手拍了拍肩膀上的魅魔大狗狗，', hasEOL: true, transform: [12, 0, 0, 12, 42.2, 706], height: 12 },
            { str: '示意他安分点。', hasEOL: true, transform: [12, 0, 0, 12, 42, 692], height: 12 },
        ])).toBe('夏以星×你 sweet talk\n\n但今天你心里想着事情，懒得同他计较，只是抬手拍了拍肩膀上的魅魔大狗狗，示意他安分点。');
    });

    it('正文左边界不受杂项干扰时，仍保留真正的首行缩进', () => {
        expect(pdfItemsToText([
            { str: '上一段的第一行', hasEOL: true, transform: [12, 0, 0, 12, 42, 720], height: 12 },
            { str: '上一段的续行。', hasEOL: true, transform: [12, 0, 0, 12, 42, 706], height: 12 },
            { str: '新段落缩进开头，', hasEOL: true, transform: [12, 0, 0, 12, 66, 680], height: 12 },
            { str: '然后回到正文左边界。', hasEOL: true, transform: [12, 0, 0, 12, 42, 666], height: 12 },
        ])).toBe('上一段的第一行上一段的续行。\n\n新段落缩进开头，然后回到正文左边界。');
    });

    it('逐页提取全文、报告进度并释放页面资源', async () => {
        const cleanup = vi.fn();
        const progress = vi.fn();
        const pdf: PdfDocumentLike = {
            numPages: 2,
            getPage: vi.fn(async pageNumber => ({
                getTextContent: async () => ({ items: [{ str: `第 ${pageNumber} 页`, hasEOL: true }] }),
                cleanup,
            })),
        };

        const result = await extractPdfDocumentText(pdf, { onProgress: progress });

        expect(result).toEqual({ text: '第 1 页\n\n第 2 页', pageCount: 2, extractedPages: 2 });
        expect(progress).toHaveBeenNthCalledWith(1, { page: 1, totalPages: 2 });
        expect(progress).toHaveBeenNthCalledWith(2, { page: 2, totalPages: 2 });
        expect(cleanup).toHaveBeenCalledTimes(2);
    });

    it('为学习 App 保留可配置的页数上限', async () => {
        const getPage = vi.fn(async (pageNumber: number) => ({
            getTextContent: async () => ({ items: [{ str: `P${pageNumber}` }] }),
        }));
        const result = await extractPdfDocumentText({ numPages: 80, getPage }, { maxPages: 50 });

        expect(result.extractedPages).toBe(50);
        expect(result.pageCount).toBe(80);
        expect(getPage).toHaveBeenCalledTimes(50);
        expect(getPage).toHaveBeenLastCalledWith(50);
    });
});
