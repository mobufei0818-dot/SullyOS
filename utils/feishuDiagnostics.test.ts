import { describe, expect, it } from 'vitest';
import { formatFeishuWriteFailure } from './feishuDiagnostics';

describe('formatFeishuWriteFailure', () => {
    it('403 Forbidden 明确区分读取连接与新增记录权限', () => {
        const text = formatFeishuWriteFailure(403, { error: 'Forbidden' });
        expect(text).toContain('读取测试已通过');
        expect(text).toContain('新增记录权限');
        expect(text).toContain('添加文档应用');
    });

    it('普通参数错误保留上游信息', () => {
        expect(formatFeishuWriteFailure(400, { msg: 'Invalid field' })).toBe('写入失败: Invalid field');
    });
});
