import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { resolveBlobRefsInRequestBody } from './apiBlobRefs';
import { putImageBlob, dataUrlToBlob, BLOBREF_PREFIX } from './blobRef';
import { safeFetchJson } from './safeApi';

// 令牌是本机存储的内部形态，发给模型对面读不懂——只会得到「我没看到图片」这种
// 不报错也不破图的静默失败。这组用例钉住网络出口一定会把它还原成 data URL。

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_JPEG = 'data:image/jpeg;base64,AQIDBAUG';

describe('令牌不出门：请求体里的 blobref 还原成 data URL', () => {
    it('image_url 里的令牌换成可用的 data URL，JSON 结构完好', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const body = JSON.stringify({
            model: 'x',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: '看看这张图' },
                    { type: 'image_url', image_url: { url: token } },
                ],
            }],
        });

        const out = await resolveBlobRefsInRequestBody(body);

        expect(out).not.toContain(BLOBREF_PREFIX);
        const parsed = JSON.parse(out as string);   // 替换后仍是合法 JSON
        const url = parsed.messages[0].content[1].image_url.url;
        expect(url.startsWith('data:image/')).toBe(true);
        expect(parsed.messages[0].content[0].text).toBe('看看这张图');
    });

    it('多个不同令牌各换各的，不会串图', async () => {
        const a = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const b = await putImageBlob(dataUrlToBlob(TINY_JPEG));
        const out = await resolveBlobRefsInRequestBody(JSON.stringify({ a, b })) as string;

        const parsed = JSON.parse(out);
        expect(parsed.a).toContain('image/png');
        expect(parsed.b).toContain('image/jpeg');
        expect(parsed.a).not.toBe(parsed.b);
    });

    it('图已经丢了的令牌换成空串——宁可发空 url 也不把令牌泄漏出去', async () => {
        const dead = `${BLOBREF_PREFIX}b_deadbeef_1_zzzzzz`;
        const out = await resolveBlobRefsInRequestBody(JSON.stringify({ url: dead })) as string;

        expect(out).not.toContain(BLOBREF_PREFIX);
        expect(JSON.parse(out).url).toBe('');
    });

    it('不含令牌的请求体一个字节都不动（原样返回同一引用）', async () => {
        const body = JSON.stringify({ messages: [{ role: 'user', content: '普通文字' }] });
        expect(await resolveBlobRefsInRequestBody(body)).toBe(body);
    });

    it('非字符串 body 原样放行', async () => {
        const fd = new FormData();
        expect(await resolveBlobRefsInRequestBody(fd)).toBe(fd);
        expect(await resolveBlobRefsInRequestBody(undefined)).toBeUndefined();
        expect(await resolveBlobRefsInRequestBody(null)).toBeNull();
    });

    it('整串是令牌的字段值，还原后旁边的 JSON 结构完好', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const out = await resolveBlobRefsInRequestBody(
            JSON.stringify({ before: '前面', url: token, after: '后面' }),
        ) as string;

        const parsed = JSON.parse(out);
        expect(parsed.url.startsWith('data:image/')).toBe(true);
        expect(parsed.before).toBe('前面');
        expect(parsed.after).toBe('后面');
    });
});

// 令牌只在「整个字段值就是它」时才代表一张图。嵌在一段文本中间的令牌是构造 prompt 时
// 把图片消息的原始值当文字拼进去了——对面不会把它当图片解析，还原成 base64 只是白花钱，
// 而且这段文本在上下文里待多久就每轮重发多久。这组用例钉住那条分界。
describe('嵌在文本里的令牌换成占位符，不撑成 base64', () => {
    it('文本中间的令牌不还原，也不泄漏令牌本身', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const out = await resolveBlobRefsInRequestBody(
            JSON.stringify({ text: `[用户引用了「${token}」，并回复了 ↓]` }),
        ) as string;

        expect(out).not.toContain('data:image/');   // 没被撑开
        expect(out).not.toContain(BLOBREF_PREFIX);  // 也没原样漏出去
        expect(JSON.parse(out).text).toBe('[用户引用了「[图片]」，并回复了 ↓]');
    });

    it('同一个请求体里，图片字段照常还原、文本里的同一个令牌只换占位符', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const out = await resolveBlobRefsInRequestBody(JSON.stringify({
            messages: [
                { role: 'user', content: `我刚发的 ${token} 你看到了吗` },
                { role: 'user', content: [{ type: 'image_url', image_url: { url: token } }] },
            ],
        })) as string;

        const parsed = JSON.parse(out);
        expect(parsed.messages[0].content).toBe('我刚发的 [图片] 你看到了吗');
        expect(parsed.messages[1].content[0].image_url.url.startsWith('data:image/')).toBe(true);
    });

    it('一段文本里塞了很多个令牌，也不会一个个撑成 base64', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const text = Array.from({ length: 20 }, () => token).join(' / ');
        const out = await resolveBlobRefsInRequestBody(JSON.stringify({ text })) as string;

        // 旧实现在这里会产出 20 份 base64；现在整个请求体应该比原文还短
        expect(out.length).toBeLessThan(JSON.stringify({ text }).length);
        expect(out).not.toContain('data:image/');
    });

    it('图已经丢了的令牌嵌在文本里，同样只换占位符（不会去查库）', async () => {
        const dead = `${BLOBREF_PREFIX}b_deadbeef_1_zzzzzz`;
        const out = await resolveBlobRefsInRequestBody(
            JSON.stringify({ text: `前面 ${dead} 后面` }),
        ) as string;

        expect(JSON.parse(out).text).toBe('前面 [图片] 后面');
    });
});

describe('接线守卫：safeFetchJson 真的发不出令牌', () => {
    let sent: string | null = null;

    beforeEach(() => {
        sent = null;
        vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
            sent = typeof init?.body === 'string' ? init.body : null;
            return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        }));
    });

    afterEach(() => { vi.unstubAllGlobals(); });

    it('带令牌的聊天请求，发到网络上的 body 里已经是 data URL', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await safeFetchJson('https://example.com/v1/chat/completions', {
            method: 'POST',
            body: JSON.stringify({ messages: [{ content: [{ type: 'image_url', image_url: { url: token } }] }] }),
        });

        expect(sent).not.toBeNull();
        expect(sent).not.toContain(BLOBREF_PREFIX);
        expect(sent).toContain('data:image/png;base64,');
    });
});
