export type ChatHistoryWindowRange = {
    start: number;
    end: number;
};

export const createChatHistoryWindow = (
    total: number,
    targetIndex: number,
    radius: number,
): ChatHistoryWindowRange => ({
    start: Math.max(0, targetIndex - radius),
    end: Math.min(Math.max(0, total), targetIndex + radius + 1),
});

export const expandChatHistoryWindow = (
    range: ChatHistoryWindowRange,
    total: number,
    direction: 'older' | 'newer',
    batchSize: number,
): ChatHistoryWindowRange => {
    const safeTotal = Math.max(0, total);
    return direction === 'older'
        ? { start: Math.max(0, range.start - batchSize), end: Math.min(safeTotal, range.end) }
        : { start: Math.max(0, range.start), end: Math.min(safeTotal, range.end + batchSize) };
};
