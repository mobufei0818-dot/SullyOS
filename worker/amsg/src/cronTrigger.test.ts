// 暂停 / 恢复后台任务（改 Worker 自己的 cron trigger）的回归守卫。
//
// 钉住的几件事：
//   1. 暂停 = 整体覆盖成空列表，恢复 = 覆盖成 wrangler.toml 里那一条；两边都是 PUT，不是增删单条。
//   2. 恢复时加回去的表达式必须跟 wrangler.toml 一致——worker 运行时读不到那份配置，
//      这里抄的一份要是漂了，「恢复」加回去的就是另一个节奏。
//   3. 没配 CF_API_TOKEN / 共享密钥没过时一个 CF 请求都不发。
//   4. Cloudflare 那边失败要把它的报错原样带出来，别只说「没成功」。
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AMSG_CRON_EXPRESSION, handleCronTriggerRead, handleCronTriggerWrite } from './cronTrigger';

type CfCall = { method: string; path: string; body: unknown; contentType: string | null };

const ENV = {
  AMSG_SERVER_TOKEN: 'shared',
  CF_API_TOKEN: 'cf-token',
  CF_SCRIPT_NAME: 'sullyos-amsg',
  CF_ACCOUNT_ID: 'acc-1',
};

/** Cloudflare API 的完整路径（含 /client/v4 这一段）。 */
const SCHEDULES_PATH = '/client/v4/accounts/acc-1/workers/scripts/sullyos-amsg/schedules';

const request = (method: 'GET' | 'POST', clientToken: string | null = 'shared') =>
  new Request('https://amsg.test.workers.dev/cron-trigger', {
    method,
    headers: clientToken ? { 'X-Client-Token': clientToken } : {},
  });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * 把打到 Cloudflare 的每一发记下来。schedules 的 GET 按 current 回，PUT 按 putResponse 回
 * （不给就当成功、原样回写）；定位 Worker 用的 settings 一律回成功。
 */
const stubCloudflare = (opts: { current?: unknown[]; putResponse?: Response } = {}) => {
  const calls: CfCall[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const path = new URL(String(input)).pathname;
    const method = init.method ?? 'GET';
    calls.push({
      method,
      path,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      contentType: new Headers(init.headers).get('content-type'),
    });
    if (path.endsWith('/settings')) return Response.json({ success: true, result: { bindings: [] } });
    if (path === SCHEDULES_PATH && method === 'GET') {
      return Response.json({ success: true, result: { schedules: opts.current ?? [] } });
    }
    if (path === SCHEDULES_PATH && method === 'PUT') {
      return opts.putResponse ?? Response.json({ success: true, result: { schedules: JSON.parse(init.body) } });
    }
    throw new Error(`没料到的请求：${method} ${path}`);
  }) as typeof fetch;
  return calls;
};

const schedulePuts = (calls: CfCall[]) => calls.filter((c) => c.path === SCHEDULES_PATH && c.method === 'PUT');

describe('AMSG_CRON_EXPRESSION', () => {
  it('跟 wrangler.toml 的 [triggers] crons 一致（恢复时加回去的就是这一条）', () => {
    const toml = readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8');
    const line = toml.match(/^crons\s*=\s*\[(.*)\]/m);
    expect(line, 'wrangler.toml 里找不到 crons = [...]').not.toBeNull();
    const crons = Array.from(line![1].matchAll(/"([^"]*)"/g), (m) => m[1]);
    expect(crons).toEqual([AMSG_CRON_EXPRESSION]);
  });
});

describe('handleCronTriggerWrite', () => {
  it('暂停 = 把 schedules 整体覆盖成空列表', async () => {
    const calls = stubCloudflare();
    const result = await handleCronTriggerWrite(ENV, request('POST'), false);
    expect(result).toEqual({ ok: true, enabled: false });
    const puts = schedulePuts(calls);
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual([]);
    expect(puts[0].contentType).toBe('application/json');
  });

  it('恢复 = 覆盖成 wrangler.toml 里那一条', async () => {
    const calls = stubCloudflare();
    const result = await handleCronTriggerWrite(ENV, request('POST'), true);
    expect(result).toEqual({ ok: true, enabled: true });
    expect(schedulePuts(calls)[0].body).toEqual([{ cron: '* * * * *' }]);
  });

  it('Cloudflare 那边失败：ok:false，把它的报错带出来，代号 CF_ERROR', async () => {
    stubCloudflare({
      putResponse: Response.json(
        { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
        { status: 403 },
      ),
    });
    const result = await handleCronTriggerWrite(ENV, request('POST'), false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CF_ERROR');
    expect(result.message).toContain('10000: Authentication error');
  });

  it('没配 CF_API_TOKEN：报 CF_TOKEN_MISSING，一个 CF 请求都不发', async () => {
    const calls = stubCloudflare();
    const result = await handleCronTriggerWrite({ ...ENV, CF_API_TOKEN: '' }, request('POST'), false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CF_TOKEN_MISSING');
    expect(calls).toHaveLength(0);
  });

  // 这个端点能把别人的主动消息整个关掉，认证的两道门跟 /self-update 一样都得在。
  it('共享密钥对不上：UNAUTHORIZED，不碰 Cloudflare', async () => {
    const calls = stubCloudflare();
    const result = await handleCronTriggerWrite(ENV, request('POST', 'wrong'), false);
    expect(result).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
    expect(calls).toHaveLength(0);
  });

  it('Worker 没设共享密钥：SERVER_TOKEN_REQUIRED，不碰 Cloudflare', async () => {
    const calls = stubCloudflare();
    const result = await handleCronTriggerWrite({ ...ENV, AMSG_SERVER_TOKEN: '' }, request('POST'), false);
    expect(result).toMatchObject({ ok: false, code: 'SERVER_TOKEN_REQUIRED' });
    expect(calls).toHaveLength(0);
  });
});

describe('handleCronTriggerRead', () => {
  it('schedules 非空 → enabled: true', async () => {
    stubCloudflare({ current: [{ cron: '* * * * *', created_on: 'x', modified_on: 'y' }] });
    expect(await handleCronTriggerRead(ENV, request('GET'))).toEqual({ supported: true, enabled: true });
  });

  it('schedules 为空 → enabled: false', async () => {
    const calls = stubCloudflare({ current: [] });
    expect(await handleCronTriggerRead(ENV, request('GET'))).toEqual({ supported: true, enabled: false });
    // 只是看一眼，不许顺手改
    expect(schedulePuts(calls)).toHaveLength(0);
  });

  it('没配 CF_API_TOKEN：supported:false + CF_TOKEN_MISSING，一个 CF 请求都不发', async () => {
    const calls = stubCloudflare();
    const result = await handleCronTriggerRead({ ...ENV, CF_API_TOKEN: undefined }, request('GET'));
    expect(result).toMatchObject({ supported: false, code: 'CF_TOKEN_MISSING' });
    expect(calls).toHaveLength(0);
  });

  it('共享密钥对不上：supported:false + UNAUTHORIZED', async () => {
    const calls = stubCloudflare();
    const result = await handleCronTriggerRead(ENV, request('GET', null));
    expect(result).toMatchObject({ supported: false, code: 'UNAUTHORIZED' });
    expect(calls).toHaveLength(0);
  });
});
