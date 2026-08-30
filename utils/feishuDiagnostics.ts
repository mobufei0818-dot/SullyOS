/** 飞书读连接成功但新增记录被拒时，给用户能直接照做的权限诊断。 */
export const formatFeishuWriteFailure = (
    status: number,
    payload: { msg?: unknown; error?: unknown; code?: unknown } | null | undefined,
): string => {
    const raw = String(payload?.msg || payload?.error || status || '写入失败');
    if (status === 403 || /forbidden|permission|access denied|无权限|权限不足/i.test(raw)) {
        return '飞书拒绝写入（403）：读取测试已通过，但应用没有新增记录权限。请在开放平台开通“查看、评论、编辑和管理多维表格”，发布并审批新版本；再到这张多维表格的“添加文档应用”中加入该应用并授予可编辑权限。';
    }
    return `写入失败: ${raw}`;
};
