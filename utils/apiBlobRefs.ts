// 令牌不出门：发往模型的请求体里不该出现 `blobref:<id>`。
//
// 图片改存 Blob 之后，字段里躺的是一个只有本机认得的短令牌（见 utils/blobRef.ts）。
// 渲染那头有 useBlobRefUrl 兜着，漏改一处顶多是「这里不显示图」，看得见也改得回来；
// 送模型这头没有对应的东西——令牌原样发出去，对面只会看到一串它读不懂的字符，
// 然后一本正经地说「我没看到图片」。没有报错、没有破图，从外面完全看不出哪里坏了。
//
// 所以在网络出口统一处理：请求体里凡是令牌，一律在发出去之前换掉。这样各处构造
// 请求的代码（聊天、群聊、相册看图、活动、通用识图）不用各记一遍这件事，将来新加的
// 出口也自动被覆盖。
//
// 换成什么，取决于令牌出现在哪：
//
//   · 整个字段值就是一个令牌（`"url": "blobref:xxx"`）——这是「这里要放一张图」，
//     换成 data URL，对面就能看到图。
//   · 令牌嵌在一段文本中间（`"[用户引用了「blobref:xxx」]"`）——这是构造 prompt 时
//     把一条图片消息的原始值当文字拼进去了。这种位置对面根本不会当图片解析，把它
//     撑成几 MB 的 base64 只是白白多花一次钱，而且这段文本在上下文里待多久就每轮
//     重发多久。换成占位符，对面读到的语义也更准。
//
// 这条分界同时是一道保险：prompt 那边将来再漏一处没做媒体判断，代价也只是模型看到
// 一个「[图片]」，不会变成账单上的一笔。
//
// 三条实现边界：
//   · 只认字符串 body（模型请求都是 JSON 文本）。FormData / stream 原样放行。
//   · 先 indexOf 探一下有没有令牌，没有就一个字节都不动——绝大多数请求走这条路。
//   · 替换后的 data URL 只含 base64 字母表和 `:;,/=+`，在 JSON 字符串里无需转义，
//     所以直接做文本替换是安全的，不必把整个请求体 parse 一遍再 stringify
//     （聊天历史动辄几 MB，来回一趟纯属浪费）。反过来 data URL 里也拼不出 `blobref:`，
//     base64 正文中不会出现冒号，替换结果不会被二次命中。
//
// 图已经丢了的令牌换成空串，跟 resolveBlobRefsDeep 的既有语义一致：宁可发一个空 url
// 让对面明确报错，也不要把内部令牌泄漏给第三方。

import { BLOBREF_PREFIX } from './blobRef';

/** 令牌嵌在文本里时的替身。跟 prompt 各处对媒体值的措辞保持一致。 */
const INLINE_TOKEN_PLACEHOLDER = '[图片]';

/** 令牌的字面形态：前缀 + SDK 的 id 字符集。与 utils/blobDedupe.ts 的同名常量同源。 */
const TOKEN_BODY = `${BLOBREF_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[A-Za-z0-9_]+`;

/**
 * 带引号的整串令牌优先匹配（JSON 里「这个字段的值就是一张图」），
 * 匹配不上才退到裸令牌（嵌在某段文本中间）。交替分支的顺序决定了这个优先级，别调换。
 */
const TOKEN_PATTERN = new RegExp(`"${TOKEN_BODY}"|${TOKEN_BODY}`, 'g');

/** 去掉整串匹配两侧的引号，拿到令牌本身。 */
const unquote = (m: string) => m.slice(1, -1);

/**
 * 把请求体里的 blobref 令牌换掉：整串是令牌的换成 data URL，嵌在文本里的换成占位符。
 * 非字符串 body / 不含令牌的 body 原样返回（同一个引用，调用方可以直接判等）。
 */
export async function resolveBlobRefsInRequestBody<T extends BodyInit | null | undefined>(
    body: T,
): Promise<T | string> {
    if (typeof body !== 'string') return body;
    if (!body.includes(BLOBREF_PREFIX)) return body;

    const matches = body.match(TOKEN_PATTERN) ?? [];
    if (matches.length === 0) return body;

    // 只有「整串是令牌」的才值得去读二进制；嵌在文本里的直接换占位符，一次库都不用查。
    const wholeValueTokens = new Set(matches.filter(m => m.startsWith('"')).map(unquote));

    const resolved = new Map<string, string>();
    if (wholeValueTokens.size > 0) {
        const { resolveRefToDataUrl } = await import('./blobRef');
        for (const token of wholeValueTokens) {
            try {
                resolved.set(token, await resolveRefToDataUrl(token));
            } catch {
                resolved.set(token, ''); // 读不出来就当图丢了，别把令牌发出去
            }
        }
    }

    return body.replace(TOKEN_PATTERN, m =>
        m.startsWith('"')
            ? `"${resolved.get(unquote(m)) ?? ''}"`
            : INLINE_TOKEN_PLACEHOLDER,
    );
}
