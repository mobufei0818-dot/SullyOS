import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error The deployed Worker entry is intentionally plain runtime JavaScript.
import worker, { __xhsLiteTest } from '../index.js';

const COOKIE = `a1=${'a'.repeat(52)}; web_session=test-session`;

const callLite = (
  command: string,
  body: Record<string, unknown> = {},
  env: Record<string, unknown> = {},
  rnoteApiKey = '',
  platform = 'xhs',
) =>
  worker.fetch(
    new Request(`https://local.test/api/${command}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-xhs-cookie': COOKIE,
        ...(rnoteApiKey ? { 'x-rnote-api-key': rnoteApiKey } : {}),
        ...(platform && platform !== 'auto' ? { 'x-xhs-platform': platform } : {}),
      },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil() {} },
  );
const callExperiment = (
  body: Record<string, unknown>,
  ack = 'spider-v3-isolated-cookie',
) =>
  worker.fetch(
    new Request('https://local.test/api/xhs-experimental-comments', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-xhs-cookie': COOKIE,
        'x-xhs-platform': 'xhs',
        ...(ack ? { 'x-xhs-experiment-ack': ack } : {}),
      },
      body: JSON.stringify(body),
    }),
    {},
    { waitUntil() {} },
  );


afterEach(() => {
  vi.restoreAllMocks();
  __xhsLiteTest.spiderV3.resetDslCache();
  __xhsLiteTest.spiderV3.resetPlatformCache();
});

describe('XHS Lite mainland / RedNote platform routing', () => {
  it('auto-detects a RedNote session without relying on gid or bRequestId', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(headers.get('cookie')).toBe(COOKIE);
      if (url.hostname === 'edith.xiaohongshu.com') {
        expect(headers.get('origin')).toBe('https://www.xiaohongshu.com');
        return new Response(JSON.stringify({ success: true, data: { guest: true } }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.hostname === 'webapi.rednote.com') {
        expect(headers.get('origin')).toBe('https://www.rednote.com');
        if (url.pathname.endsWith('/v2/user/me')) {
          return new Response(JSON.stringify({ success: true, data: { guest: true } }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          success: true,
          data: { result: { success: true, user: { user_id: 'rednote-user', nickname: 'global-user' } } },
        }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const response = await callLite('check-login', {}, {}, '', 'auto');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(body).toMatchObject({
      logged_in: true,
      platform: 'rednote',
      api_host: 'webapi.rednote.com',
      user_id: 'rednote-user',
    });
  });

  it('routes subsequent RedNote reads directly to the global backend', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { items: [] } }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await callLite('search', { keyword: 'cat' }, {}, '', 'rednote');

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const [input, init] = upstream.mock.calls[0];
    expect(String(input)).toContain('https://webapi.rednote.com/api/sns/web/v1/search/notes');
    const headers = new Headers(init?.headers);
    expect(headers.get('origin')).toBe('https://www.rednote.com');
    expect((await response.json()).platform).toBe('rednote');
  });
});

describe('XHS Lite session-risk headers', () => {
  it('keeps search on the previously stable request shape', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { items: [] } }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await callLite('search', { keyword: '小猫' });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const [, init] = upstream.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.has('x-rap-param')).toBe(false);
    expect(headers.has('xy-direction')).toBe(false);
    expect(headers.get('user-agent')).toContain('Chrome/138.0.0.0');
    expect(headers.get('sec-ch-ua')).toContain('Chromium";v="138"');
  });

  it('adds the upstream-required RAP envelope when loading the signed-in user notes', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      if (url.pathname.endsWith('/api/sns/web/v1/user/otherinfo')) {
        expect(headers.has('x-rap-param')).toBe(false);
        return new Response(JSON.stringify({
          success: true,
          data: { basic_info: { nickname: 'owner' } },
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname.endsWith('/api/sns/web/v1/user_posted')) {
        expect(headers.get('x-rap-param')).toBeTruthy();
        expect(url.searchParams.get('user_id')).toBe('owner-id');
        expect(url.searchParams.get('xsec_source')).toBe('pc_user');
        return new Response(JSON.stringify({
          success: true,
          data: { notes: [{ id: 'owned-note-id', note_card: { title: 'mine' } }] },
        }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const response = await callLite('user-profile', {
      user_id: 'owner-id',
      xsec_token: 'owner-token',
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(body).toMatchObject({
      success: true,
      notes_status: 'loaded',
      notes: [{ note_id: 'owned-note-id', title: 'mine' }],
    });
  });

  it('uses RAP and exact note/comment ids when replying to a comment', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/sns/web/v1/comment/post');
      const headers = new Headers(init?.headers);
      expect(headers.get('x-rap-param')).toBeTruthy();
      expect(JSON.parse(String(init?.body))).toMatchObject({
        note_id: 'owned-note-id',
        target_comment_id: 'comment-id',
        content: 'reply text',
      });
      return new Response(JSON.stringify({ success: true, data: { comment: { id: 'reply-id' } } }), {
        headers: { 'content-type': 'application/json' },
      });
    });

    const response = await callLite('reply-comment', {
      feed_id: 'owned-note-id',
      comment_id: 'comment-id',
      content: 'reply text',
    });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({ success: true });
  });

  it('surfaces an upstream reply rejection as an operation error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, msg: 'risk control' }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await callLite('reply-comment', {
      feed_id: 'owned-note-id',
      comment_id: 'comment-id',
      content: 'reply text',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ error: '评论失败: risk control' });
  });

  it('does not call the protected XHS comment endpoint when no managed provider is configured', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/sns/web/v1/feed')) {
        return new Response(JSON.stringify({
          success: true,
          data: { items: [{ note_card: { title: 'test', desc: 'body' } }] },
        }));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const response = await callLite('get-feed-detail', {
      feed_id: 'note-id',
      xsec_token: 'token',
      xsec_source: 'pc_share',
      load_all_comments: true,
    });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);

    const [, detailInit] = upstream.mock.calls[0];
    const detailHeaders = new Headers(detailInit?.headers);
    expect(detailHeaders.has('x-rap-param')).toBe(false);
    expect(detailHeaders.get('xy-direction')).toBe('13');

    const body = await response.json();
    expect(body.data.comments.list).toEqual([]);
    expect(body.data.comments_status).toBe('unavailable');
    expect(body.data.comments_error.code).toBe('COMMENT_PROVIDER_NOT_CONFIGURED');
  });

  it('loads real comments through the managed provider without forwarding the user cookie', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/sns/web/v1/feed')) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            items: [{
              note_card: {
                title: 'test',
                desc: 'body',
                interact_info: { comment_count: '1' },
              },
            }],
          },
        }));
      }
      if (url.startsWith('https://rnote.dev/api/v2/crawler/note/comments')) {
        const headers = new Headers(init?.headers);
        expect(headers.get('X-API-Key')).toBe('provider-key');
        expect(headers.has('cookie')).toBe(false);
        expect(headers.has('x-xhs-cookie')).toBe(false);
        expect(headers.has('x-s')).toBe(false);
        return new Response(JSON.stringify({
          success: true,
          data: {
            data: {
              comments: [{
                comment_id: 'comment-1',
                content: '真实评论',
                like_count: '12',
                user_info: { user_id: 'user-1', nickname: '甲' },
              }],
            },
          },
        }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const response = await callLite('get-feed-detail', {
      feed_id: 'note-id',
      xsec_token: 'token',
      xsec_source: 'pc_share',
      load_all_comments: true,
    }, { RNOTE_API_KEY: 'provider-key' });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    const body = await response.json();
    expect(body.data.comments_status).toBe('loaded');
    expect(body.data.comments_provider).toBe('rnote');
    expect(body.data.comments.list).toEqual([expect.objectContaining({
      comment_id: 'comment-1',
      content: '真实评论',
      nickname: '甲',
    })]);
  });

  it('uses a per-user Rnote key without storing it in Worker env', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/sns/web/v1/feed')) {
        return new Response(JSON.stringify({
          success: true,
          data: { items: [{ note_card: { title: 'test', desc: 'body' } }] },
        }));
      }
      if (url.startsWith('https://rnote.dev/api/v2/crawler/note/comments')) {
        const headers = new Headers(init?.headers);
        expect(headers.get('X-API-Key')).toBe('user-owned-key');
        expect(headers.has('cookie')).toBe(false);
        expect(headers.has('x-xhs-cookie')).toBe(false);
        return new Response(JSON.stringify({
          success: true,
          data: {
            comments: [{
              comment_id: 'comment-user-key',
              content: '用户 Key 读取的真实评论',
              user_info: { nickname: '乙' },
            }],
          },
        }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const response = await callLite('get-feed-detail', {
      feed_id: 'note-id',
      xsec_token: 'token',
      load_all_comments: true,
    }, {}, 'user-owned-key');

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    const body = await response.json();
    expect(body.data.comments_status).toBe('loaded');
    expect(body.data.comments_provider).toBe('rnote');
    expect(body.data.comments.list[0].content).toBe('用户 Key 读取的真实评论');
  });
});
describe('XHS Spider session v3 isolated experiment', () => {
  it('requires both the private acknowledgement header and body flag', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch'));

    const response = await callExperiment({ feed_id: 'note-id' }, '');

    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });

  it('uses a client-owned stable session and the safe no-client-hints strategy by default', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://as.xiaohongshu.com/api/sec/v1/ds')) {
        return new Response("function getdss(){return '1785079000000';}");
      }
      if (url.includes('/api/sns/web/v2/comment/page')) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            comments: [{
              id: 'comment-1',
              content: 'real comment',
              user_info: { user_id: 'user-1', nickname: 'reader' },
            }],
            cursor: 'next',
            has_more: true,
          },
        }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const first = await callExperiment({
      acknowledge_risk: true,
      feed_id: 'note-id',
      xsec_token: 'token',
    });

    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(upstream).toHaveBeenCalledTimes(2);
    const [commentUrl, commentInit] = upstream.mock.calls[1];
    const headers = new Headers(commentInit?.headers);
    expect(String(commentUrl)).toContain('/api/sns/web/v2/comment/page?note_id=note-id');
    expect(headers.get('x-s')).toMatch(/^XYS_/);
    expect(headers.get('x-s-common')).toBeTruthy();
    expect(headers.get('x-t')).toMatch(/^\d{13}$/);
    expect(headers.get('user-agent')).toContain('Chrome/150.0.0.0');
    expect(headers.has('sec-ch-ua')).toBe(false);
    expect(headers.has('sec-ch-ua-mobile')).toBe(false);
    expect(headers.has('sec-ch-ua-platform')).toBe(false);
    expect(headers.has('x-mns')).toBe(false);

    const firstBody = await first.json();
    expect(firstBody.success).toBe(true);
    expect(firstBody.data.comments_provider).toBe('spider-session-v3');
    expect(firstBody.data.comments.list[0]).toEqual(expect.objectContaining({
      comment_id: 'comment-1',
      content: 'real comment',
      nickname: 'reader',
    }));
    expect(firstBody.session_state).toEqual(expect.objectContaining({
      version: 1,
      mnsSeq: 1,
      signCount: 1,
      webBuild: '6.32.2',
    }));
    expect(firstBody.session_state).not.toHaveProperty('cookie');
    expect(firstBody.session_state).not.toHaveProperty('a1');

    const second = await callExperiment({
      acknowledge_risk: true,
      feed_id: 'note-id',
      xsec_token: 'token',
      session_state: firstBody.session_state,
    });
    const secondBody = await second.json();

    expect(upstream).toHaveBeenCalledTimes(3);
    expect(secondBody.session_state.a1Tag).toBe(firstBody.session_state.a1Tag);
    expect(secondBody.session_state.loadts).toBe(firstBody.session_state.loadts);
    expect(secondBody.session_state.mnsSeq).toBe(2);
    expect(secondBody.session_state.signCount).toBe(2);
  });

  it('opens the circuit on the first HTTP 406 and never retries comments', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('https://as.xiaohongshu.com/api/sec/v1/ds')) {
        return new Response("function getdss(){return '1785079000000';}");
      }
      if (url.includes('/api/sns/web/v2/comment/page')) {
        return new Response(JSON.stringify({ success: false, msg: 'blocked' }), {
          status: 406,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const response = await callExperiment({
      acknowledge_risk: true,
      feed_id: 'note-id',
      xsec_token: 'token',
    });
    const body = await response.json();

    expect(upstream).toHaveBeenCalledTimes(2);
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('XHS_EXPERIMENT_HTTP_406');
    expect(body.circuit_open).toBe(true);
    expect(body.retry_performed).toBe(false);
    expect(body.upstream_requests.comments).toBe(1);
  });

  it('keeps browser-hints and legacy transport as explicit one-shot A/B strategies', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('https://as.xiaohongshu.com/api/sec/v1/ds')) {
        return new Response("function getdss(){return '1785079000000';}");
      }
      return new Response(JSON.stringify({
        success: true,
        data: { comments: [], cursor: '', has_more: false },
      }), { headers: { 'content-type': 'application/json' } });
    });

    const browserHints = await callExperiment({
      acknowledge_risk: true,
      feed_id: 'note-id',
      strategy: 'browser-hints',
    });
    const browserBody = await browserHints.json();
    const browserHeaders = new Headers(upstream.mock.calls[1][1]?.headers);
    expect(browserHeaders.get('sec-ch-ua')).toContain('Chromium');
    expect(browserHeaders.has('x-mns')).toBe(false);

    await callExperiment({
      acknowledge_risk: true,
      feed_id: 'note-id',
      strategy: 'legacy-transport',
      session_state: browserBody.session_state,
    });
    const legacyHeaders = new Headers(upstream.mock.calls[2][1]?.headers);
    expect(legacyHeaders.get('sec-ch-ua')).toContain('Chromium');
    expect(legacyHeaders.get('x-mns')).toBe('unload');
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it('matches the verified Spider_XHS 4.3.7 fixed signing vector', async () => {
    const a1 = 'a'.repeat(52);
    const api = '/api/sns/web/v2/comment/page?note_id=note-id&cursor=&top_comment_id=&image_formats=jpg%2Cwebp%2Cavif&xsec_token=token';
    const state = {
      version: 1,
      a1Tag: 'unused',
      loadts: 1785079999000,
      dsllt: 1785079999000,
      mnsSeq: 0,
      signCount: 0,
      b1Seed: 123456789,
      timeOrigin: 1785079998000,
      webBuild: '6.32.2',
    };
    const signed = __xhsLiteTest.spiderV3.signComment(
      api,
      { a1 },
      state,
      '1785079000000',
      { now: 1785080000123, version: 0x12345678 },
    );
    const vector = new TextEncoder().encode(
      `${signed.headers['x-s']}\n${signed.headers['x-s-common']}`,
    );
    const digest = await crypto.subtle.digest('SHA-256', vector);
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');

    expect(signed.debug).toEqual(expect.objectContaining({
      x3Prefix: 'mns0301_gRaK',
      x3Length: 200,
    }));
    expect(hash).toBe('dbefc44eb80b9dba04fd427e93a4bdae0065cbec907a4fee4d91fe63c6f25b70');
  });
});
