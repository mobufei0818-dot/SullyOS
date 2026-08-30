import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReplySnapshotContent } from './applyAssistantPostProcessing';
import { isBlobRef } from './blobRef';

// 角色回复里带 [[QUOTE: ...]] 时，会把「被引用的那条」的内容快照写进 replyTo.content。
//
// 这里原来是无脑截前 10 个字。图片改存 `blobref:<id>` 令牌之后，这 10 个字**正好**是
// `blobref:b_` —— 令牌前缀加上 SDK 生成 id 的第一个字符。
//
// messages 表是 Blob 孤儿清理的引用面（utils/blobGc.ts 把每条消息 JSON.stringify 后
// 交给 SDK 扫）。SDK 从这半截前缀提取出来的短 id 是它生成的**每一个** id 的公共前缀，
// 于是它的边界歧义安全阀判定「引用面像是被截断过，不安全」→ 整库豁免，一个 Blob 都不删，
// 而且不报任何错（宿主唯一能察觉的信号是 runGc 返回值里的 keptBoundary）。
//
// 也就是说：一条引用回复落到图片消息上，就能把整个孤儿清理静默关掉。

const BLOB_TOKEN = 'blobref:b_0123456789abcdef';
const DATA_URL = 'data:image/png;base64,' + 'A'.repeat(400);
const HTTP_URL = 'https://cdn.example.com/emoji/aaaaaaaaaaaa.png';

describe('引用回复的内容快照', () => {
    it('fixture 用的确实是 SDK 认的令牌形态', () => {
        expect(isBlobRef(BLOB_TOKEN)).toBe(true);
        // 这就是坑本身：截 10 个字 = 每个 SDK id 的公共前缀
        expect(BLOB_TOKEN.slice(0, 10)).toBe('blobref:b_');
    });

    it('引用一条 blobref 图片消息，写进快照的不是被截断的令牌', () => {
        const snapshot = buildReplySnapshotContent({ type: 'image', content: BLOB_TOKEN });
        expect(snapshot).not.toContain('blobref');
        expect(snapshot).toBe('[图片]');
    });

    it('没标 type、值本身是令牌时也认得出来（兜底分支会取到任意最后一条 user 消息）', () => {
        const snapshot = buildReplySnapshotContent({ content: BLOB_TOKEN });
        expect(snapshot).not.toContain('blobref');
        expect(snapshot).toBe('[图片]');
    });

    it('旧的 data: / 图床 URL 一样不进快照', () => {
        expect(buildReplySnapshotContent({ type: 'image', content: DATA_URL })).toBe('[图片]');
        expect(buildReplySnapshotContent({ content: DATA_URL })).toBe('[图片]');
        expect(buildReplySnapshotContent({ content: HTTP_URL })).toBe('[图片]');
    });

    it('表情包给自己的占位符', () => {
        expect(buildReplySnapshotContent({ type: 'emoji', content: BLOB_TOKEN })).toBe('[表情包]');
    });

    it('普通文字还是老样子：长的截 10 个字，短的原样', () => {
        expect(buildReplySnapshotContent({ type: 'text', content: '今天天气真好我们出去走走吧' })).toBe('今天天气真好我们出去...');
        expect(buildReplySnapshotContent({ type: 'text', content: '好呀' })).toBe('好呀');
    });
});

describe('引用解析的调用点', () => {
    const source = readFileSync(path.resolve(__dirname, './applyAssistantPostProcessing.ts'), 'utf8');

    it('resolveQuoteTarget 走快照函数，不再自己截 10 个字', () => {
        expect(source).toContain('content: buildReplySnapshotContent(targetMsg)');
        expect(source).not.toMatch(/targetMsg\.content\.slice\(0,\s*10\)\s*\+\s*'\.\.\.'/);
    });

    it('文件里没有别的地方往 replyTo 里塞裸截断的 content', () => {
        // replyTo 只有 aiReplyTarget / chunkReplyTarget 两个来源，都出自 resolveQuoteTarget
        const producers = source.match(/=\s*resolveQuoteTarget\(/g) || [];
        expect(producers).toHaveLength(2);
        expect(source).not.toMatch(/replyTo:\s*\{/);
    });
});

// ─── 用户侧：自己引用一条图片消息 ────────────────────────────────────────────
//
// 上面那套只管角色回复。用户在输入框里点「回复」再发出去，走的是各 App 自己的落库代码，
// 一直是把被引用消息的 content 原样抄进快照——图片消息抄进去的就是 `blobref:b_...` 令牌，
// 于是气泡里、相册详情里都会明晃晃印着一串令牌，孤儿清理那边也照样被截断前缀噎住。

const readSource = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

describe('私聊（apps/Chat.tsx）的用户引用', () => {
    const source = readSource('../apps/Chat.tsx');

    it('落库的快照经过 buildReplySnapshotContent，不再原样抄 content', () => {
        expect(source).toContain('content: buildReplySnapshotContent(replyTarget)');
        expect(source).not.toMatch(/replyTo\s*=\s*\{[\s\S]{0,200}content:\s*replyTarget\.content\b/);
    });

    it('输入框上方的「正在回复」条也不再裸截 10 个字', () => {
        expect(source).not.toMatch(/replyTarget\.content\.slice\(0,\s*10\)/);
    });

    it('存相册的聊天上下文对图片/表情消息用占位符', () => {
        expect(source).not.toContain('${sender}: ${m.content.substring(0, 100)}');
        expect(source).toMatch(/buildReplySnapshotContent\(m\)[\s\S]{0,120}m\.content\.substring\(0, 100\)/);
    });

    it('存相册失败不拖垮发消息：saveGalleryImage 被 try 包住', () => {
        // 输入框在这一步之前已经清空，放任它抛出去就是「图片发着发着没了」
        const calls = source.match(/DB\.saveGalleryImage\(/g) || [];
        const guarded = source.match(/try\s*\{\s*await DB\.saveGalleryImage\(/g) || [];
        expect(guarded.length).toBeGreaterThan(0);
        expect(calls).toHaveLength(guarded.length);
    });

    it('拼出来的相册上下文长成「小明: [图片]」', () => {
        const line = `小明: ${buildReplySnapshotContent({ type: 'image', content: BLOB_TOKEN })}`;
        expect(line).toBe('小明: [图片]');
    });
});

describe('群聊（apps/GroupChat.tsx）的用户引用', () => {
    const source = readSource('../apps/GroupChat.tsx');

    it('落库的快照经过 buildReplySnapshotContent', () => {
        expect(source).toContain('content: buildReplySnapshotContent(replyTarget)');
        expect(source).not.toMatch(/replyTo\s*=\s*\{[\s\S]{0,200}content:\s*replyTarget\.content\b/);
    });

    it('气泡里的引用预览显示前先换占位符', () => {
        expect(source).toContain('buildReplySnapshotContent({ content: msg.replyTo.content })');
        expect(source).not.toMatch(/msg\.replyTo\.content\.slice\(0,\s*10\)/);
    });

    it('输入框上方的「正在回复」条也不再裸截 10 个字', () => {
        expect(source).not.toMatch(/replyTarget\.content\.slice\(0,\s*10\)/);
    });
});

describe('私聊气泡（components/chat/MessageItem.tsx）的引用预览', () => {
    const source = readSource('../components/chat/MessageItem.tsx');

    it('历史里已经存下的令牌快照，显示前换成占位符', () => {
        expect(source).toMatch(/replyPreview\s*=\s*m\.replyTo[\s\S]{0,300}buildReplySnapshotContent/);
        expect(source).not.toMatch(/const replyPreview = m\.replyTo \? stripJunk\(m\.replyTo\.content\) : '';/);
    });

    it('媒体判定复用 utils/blobRef 的 isImageValue，没有另起一份', () => {
        expect(source).toMatch(/import \{[^}]*isImageValue[^}]*\} from '\.\.\/\.\.\/utils\/blobRef'/);
        expect(source).not.toMatch(/const isMediaValue\s*=/);
    });
});

// ─── 读端漏网的两处令牌 ──────────────────────────────────────────────────────

describe('通话舞台的兜底头像（components/call/VRMVideoCallStage.tsx）', () => {
    const source = readSource('../components/call/VRMVideoCallStage.tsx');

    it('没配 VRM 模型时的兜底头像走 TokenImg，不是裸 <img>', () => {
        // fallbackAvatar 传的是 char.avatar，上传的头像已经是 blobref 令牌
        expect(source).toContain('<TokenImg value={fallbackAvatar}');
        expect(source).not.toMatch(/<img\s+src=\{fallbackAvatar\}/);
    });

    it('确实 import 了 TokenImg', () => {
        expect(source).toMatch(/import TokenImg from '\.\.\/os\/TokenImg'/);
    });
});

describe('桌面陪伴的主色提取（components/os/CompanionHome.tsx）', () => {
    const source = readSource('../components/os/CompanionHome.tsx');

    it('头像先解析成可加载 URL 再取色，不把令牌直接喂给 new Image()', () => {
        expect(source).toContain('useBlobRefUrl(character?.avatar)');
        expect(source).toContain('hueFromImage(avatarImageUrl)');
    });

    it('文件里每一处取色的入参都是解析后的 URL', () => {
        const args = [...source.matchAll(/hueFromImage\(([^)]*)\)/g)].map(m => m[1].trim());
        expect(args.length).toBeGreaterThan(0);
        expect(args.every(arg => arg === 'avatarImageUrl' || arg === 'backgroundImageUrl')).toBe(true);
    });
});
