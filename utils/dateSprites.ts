// 见面模式（DateApp）立绘兜底选择：角色没给当前情绪配图时，挑一张还能看的顶上。
//
// char.sprites 是个混装袋——除了见面情绪立绘（normal/happy/…/角色自定义的），还装着
// 小小窝的房间立绘 sprites['chibi']。chibi 是 Q 版小人，和见面模式的半身立绘不是一回事，
// 拿它顶见面立绘会很出戏，所以兜底时整个跳过这个键。
//
// 兜底顺序：normal/default → 见面情绪键 → 其它杂项键（跳过 chibi）→ 头像。
//
// 返回值是「图片字段值」而不是「能直接加载的地址」：它可能是 blobref 令牌
// （见 utils/blobRef.ts），也可能是 data: / http(s)。消费方一律用 TokenImg 渲染，
// 或用 useBlobRefUrl 解析后再拼 CSS url()，别直接塞进 <img src>。

export function pickDateFallbackSprite(
    sprites: Record<string, string> | undefined | null,
    dateEmotionKeys: string[],
    avatar?: string,
): string | undefined {
    const s = sprites || {};
    const direct = s['normal'] || s['default'];
    if (direct) return direct;
    const emoKey = dateEmotionKeys.find(k => s[k]);
    if (emoKey) return s[emoKey];
    const stray = Object.entries(s).find(([k, v]) => v && k !== 'chibi');
    if (stray) return stray[1];
    return avatar;
}
