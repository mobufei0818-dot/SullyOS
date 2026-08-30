import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FirecrawlApiError,
  getFirecrawlApiKey,
  getFirecrawlCreditUsage,
  scrapeWebpageWithFirecrawl,
  setFirecrawlApiKey,
} from './firecrawl';

const mockJsonFetch = (body: any, status = 200) => {
  const fn = vi.fn(async (..._args: any[]) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
};

describe('Firecrawl 网页抓取适配', () => {
  beforeEach(() => {
    localStorage.removeItem('sully_firecrawl_api_key_v1');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('API Key 只在本机保存，清空后停用', () => {
    setFirecrawlApiKey('  fc-user-key  ');
    expect(getFirecrawlApiKey()).toBe('fc-user-key');
    setFirecrawlApiKey('');
    expect(getFirecrawlApiKey()).toBe('');
  });

  it('额度接口返回实时剩余量和结算周期', async () => {
    const fn = mockJsonFetch({
      success: true,
      data: {
        remainingCredits: 876,
        planCredits: 1000,
        billingPeriodStart: '2026-08-01T00:00:00Z',
        billingPeriodEnd: '2026-09-01T00:00:00Z',
      },
    });
    const usage = await getFirecrawlCreditUsage('fc-user-key');
    const calls = fn.mock.calls as any[][];
    expect(usage).toMatchObject({ remainingCredits: 876, planCredits: 1000 });
    expect(String(calls[0][0])).toContain('/v2/team/credit-usage');
    expect((calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer fc-user-key',
    });
  });

  it('单页抓取关闭服务端缓存并映射正文元数据', async () => {
    const fn = mockJsonFetch({
      success: true,
      data: {
        markdown: '# 标题\n\n正文',
        metadata: {
          title: '标题',
          sourceURL: 'https://example.com/final',
          ogImage: 'https://example.com/cover.jpg',
        },
      },
    });
    const result = await scrapeWebpageWithFirecrawl('https://example.com/a', 'fc-user-key');
    expect(result).toEqual({
      markdown: '# 标题\n\n正文',
      title: '标题',
      finalUrl: 'https://example.com/final',
      image: 'https://example.com/cover.jpg',
    });
    const init = (fn.mock.calls as any[][])[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      url: 'https://example.com/a',
      formats: ['markdown'],
      onlyMainContent: true,
      storeInCache: false,
      maxAge: 0,
    });
  });

  it('额度耗尽与限速给出可降级识别的错误类型', async () => {
    mockJsonFetch({ success: false, error: 'Payment required' }, 402);
    await expect(scrapeWebpageWithFirecrawl('https://example.com', 'fc-user-key'))
      .rejects.toMatchObject({ kind: 'quota', status: 402 } satisfies Partial<FirecrawlApiError>);
  });
});
