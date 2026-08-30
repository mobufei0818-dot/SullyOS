// 气泡主题解析 —— 从 apps/Chat.tsx 抽出的共享逻辑（私聊/群聊共用）。
// presets 作参数传入，避免 utils → components 反向依赖。
import { ChatTheme } from '../../types';

/**
 * 按主题 id 解析出完整 ChatTheme：custom 优先 → preset → default 兜底；
 * legacy/导入主题可能缺 user 或 ai 侧（直接用会让 MessageItem 读
 * styleConfig.borderRadius 崩掉），用 default 对应侧补全。
 */
export function resolveChatTheme(
    themeId: string | undefined,
    customThemes: ChatTheme[],
    presets: Record<string, ChatTheme>,
    fallbackId: string = 'default',
): ChatTheme {
    const fallback = presets[fallbackId];
    const id = themeId || fallbackId;
    const found = customThemes.find(t => t.id === id) || presets[id] || fallback;
    return {
        ...found,
        user: { ...fallback.user, ...(found.user || {}) },
        ai: { ...fallback.ai, ...(found.ai || {}) },
    };
}

/**
 * 气泡工坊的 CSS 选择器在私聊里直接作用于整页；群聊允许每个成员使用不同主题，
 * 因此要给每套主题加上消息级作用域，避免 A 的 `.sully-bubble-ai` 串到 B。
 *
 * 编辑器只允许规则以 `.sully-bubble-user` / `.sully-bubble-ai` / `.sully-voice-bar`
 * 开头；这里同时兼容逗号列表和 @media / @supports 内的规则。
 */
export function scopeBubbleThemeCss(css: string | undefined, scopeSelector: string): string {
    if (!css?.trim() || !scopeSelector.trim()) return '';
    return css.replace(
        /(^|[,{])(\s*)(\.sully-(?:bubble-(?:user|ai)|voice-bar)\b)/gmu,
        (_whole, boundary: string, whitespace: string, selector: string) =>
            `${boundary}${whitespace}${scopeSelector} ${selector}`,
    );
}
