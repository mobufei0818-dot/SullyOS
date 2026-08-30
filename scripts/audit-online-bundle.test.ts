import { describe, it, expect } from 'vitest';
// @ts-expect-error JavaScript helper has no type declarations.
import { collectSiteScripts, auditTrackerFootprint } from './audit-online-bundle.mjs';

const SITE = 'https://example.test/SullyOS/';
const WEBSITE_ID = '11111111-2222-3333-4444-555555555555';
const SCRIPT_URL = 'https://stats.example.test/script.js';

/** 把 { 完整 URL: 内容 } 当成一个静态站点；没列出的地址一律当 404。 */
function fakeSite(pages: Record<string, string>) {
  return async (url: string) => (url in pages ? pages[url] : null);
}

/** 只列出失败项的名字，断言时读起来清楚些。 */
function failedNames(result: { failed: { name: string }[] }) {
  return result.failed.map((f) => f.name);
}

describe('线上产物审计 · 抓取范围', () => {
  it('统计配置被打包进非入口 chunk 时照样找得到', async () => {
    // 这正是 2026-08-16 起连红两天的场景：「门牌整理上云」让打包器把
    // analytics 那一片划进了 memory-palace 包，入口包里就此不含这两个值。
    const pages = {
      [SITE]: '<script type="module" crossorigin src="./assets/index-aaa.js"></script>',
      [`${SITE}assets/index-aaa.js`]: 'import"./memory-palace-bbb.js";console.log(1);',
      [`${SITE}assets/memory-palace-bbb.js`]: `const w="${WEBSITE_ID}",s="${SCRIPT_URL}";`,
    };

    const scan = await collectSiteScripts({ baseUrl: SITE, fetchText: fakeSite(pages) });
    const result = auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL });

    expect(failedNames(result)).toEqual([]);
    expect(scan.stats.fetched).toBe(2);
  });

  it('跟得进只在 mapDeps 数组里出现的懒加载 chunk', async () => {
    const pages = {
      [SITE]: '<script type="module" src="./assets/index-aaa.js"></script>',
      [`${SITE}assets/index-aaa.js`]:
        'const __vite__mapDeps=(i,m,d=(m.f||(m.f=["assets/Chat-ccc.js","assets/Chat-ddd.css"])))=>i.map(i=>d[i]);',
      [`${SITE}assets/Chat-ccc.js`]: `const w="${WEBSITE_ID}",s="${SCRIPT_URL}";`,
    };

    const scan = await collectSiteScripts({ baseUrl: SITE, fetchText: fakeSite(pages) });

    expect(scan.files.map((f: { url: string }) => f.url)).toContain(`${SITE}assets/Chat-ccc.js`);
    expect(failedNames(auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL }))).toEqual([]);
  });

  it('根路径写法 /assets/xxx.js 也跟得到', async () => {
    // 产物用相对路径（./assets/…）还是根路径（/assets/…），取决于构建时的 base 配置。
    // 判定标准得跟浏览器一致：同源的它都会去加载，审计就都得跟，
    // 不然换个 base 配置就有一批文件从审计视野里消失了。
    const pages = {
      [SITE]: '<script type="module" src="/assets/index-aaa.js"></script>',
      'https://example.test/assets/index-aaa.js': `const w="${WEBSITE_ID}",s="${SCRIPT_URL}";`,
    };

    const scan = await collectSiteScripts({ baseUrl: SITE, fetchText: fakeSite(pages) });

    expect(scan.stats.fetched).toBe(1);
    expect(failedNames(auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL }))).toEqual([]);
  });

  it('没人 import 的静态 js（public/ 那些）给了路径就照样审计', async () => {
    // public/ 下的文件是原样复制上线的，有几个由运行时拼出地址来加载
    // （MediaPipe 的 wasm glue 就是），import 链上找不到它们。
    // 浏览器该加载还是会加载，所以得把这些路径直接喂进来。
    const pages = {
      [SITE]: '<script type="module" src="./assets/index-aaa.js"></script>',
      [`${SITE}assets/index-aaa.js`]: `const w="${WEBSITE_ID}",s="${SCRIPT_URL}";`,
      [`${SITE}mediapipe/wasm/vision-internal.js`]: 'const extra="https://tracker.evil.test/script.js";',
    };

    const scan = await collectSiteScripts({
      baseUrl: SITE,
      fetchText: fakeSite(pages),
      extraPaths: ['mediapipe/wasm/vision-internal.js'],
    });
    const result = auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL });

    expect(scan.stats.fetched).toBe(2);
    expect(failedNames(result)).toContain('线上产物内 tracker 地址唯一且相符');
  });

  it('不跟去站外的地址', async () => {
    const pages = {
      [SITE]: '<script type="module" src="./assets/index-aaa.js"></script>',
      [`${SITE}assets/index-aaa.js`]:
        `const cdn="https://cdn.other.test/lib-eee.js",w="${WEBSITE_ID}",s="${SCRIPT_URL}";`,
      'https://cdn.other.test/lib-eee.js': 'const x=1;',
    };

    const scan = await collectSiteScripts({ baseUrl: SITE, fetchText: fakeSite(pages) });

    expect(scan.files.map((f: { url: string }) => f.url)).toEqual([`${SITE}assets/index-aaa.js`]);
  });
});

describe('线上产物审计 · 断言', () => {
  it('多出来的上报端点藏在懒加载 chunk 里也要被抓出来', async () => {
    // 旧写法只 grep 入口包，这种「入口一切正常、第二个端点躲在懒加载包里」
    // 的情况会一路绿灯 —— 恰恰是这条断言本来要防的事。
    const pages = {
      [SITE]: '<script type="module" src="./assets/index-aaa.js"></script>',
      [`${SITE}assets/index-aaa.js`]: `const w="${WEBSITE_ID}",s="${SCRIPT_URL}";import"./lazy-fff.js";`,
      [`${SITE}assets/lazy-fff.js`]: 'const extra="https://tracker.evil.test/script.js";',
    };

    const scan = await collectSiteScripts({ baseUrl: SITE, fetchText: fakeSite(pages) });
    const result = auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL });

    expect(failedNames(result)).toContain('线上产物内 tracker 地址唯一且相符');
    const failure = result.failed.find((f) => f.name === '线上产物内 tracker 地址唯一且相符')!;
    expect(failure.actual).toContain('https://tracker.evil.test/script.js');
    expect(failure.actual).toContain(SCRIPT_URL);
  });

  it('站点 id 一处都不出现时判失败', async () => {
    const pages = {
      [SITE]: '<script type="module" src="./assets/index-aaa.js"></script>',
      [`${SITE}assets/index-aaa.js`]: `const s="${SCRIPT_URL}";`,
    };

    const scan = await collectSiteScripts({ baseUrl: SITE, fetchText: fakeSite(pages) });
    const result = auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL });

    expect(failedNames(result)).toContain('线上产物内含该站点 id');
  });

  it('一个 js 都没抓到时判失败，而不是「没找到问题」', async () => {
    // 探测机制自己坏掉（index.html 拿不到、入口包 404、站点整个挂了）时，
    // 「没扫到东西」和「扫完没问题」长得一模一样。必须红。
    const scan = await collectSiteScripts({ baseUrl: SITE, fetchText: fakeSite({}) });
    const result = auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL });

    expect(failedNames(result)).toContain('抓到了可供审计的产物');
  });

  it('扫描撞到上限被截断时判失败，不给出「唯一」的结论', async () => {
    // 截断之后「tracker 地址唯一」这句话就没有依据了 —— 没扫到的那部分里
    // 有没有第二个端点，谁也不知道。这种时候必须红，不能悄悄按扫到的部分报通过。
    const pages: Record<string, string> = {
      [SITE]: '<script type="module" src="./assets/index-aaa.js"></script>',
      [`${SITE}assets/index-aaa.js`]:
        `const w="${WEBSITE_ID}",s="${SCRIPT_URL}";import"./a-111.js";import"./b-222.js";`,
      [`${SITE}assets/a-111.js`]: 'const a=1;',
      [`${SITE}assets/b-222.js`]: 'const b=2;',
    };

    const scan = await collectSiteScripts({
      baseUrl: SITE,
      fetchText: fakeSite(pages),
      limits: { maxFiles: 2 },
    });
    const result = auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL });

    expect(scan.truncated).not.toBeNull();
    expect(failedNames(result)).toContain('扫描覆盖完整（没撞上限）');
  });

  it('文件取不到（网络抽风）时判失败，不跟「认错文件名」混为一谈', async () => {
    // 404 是认错了文件名，无所谓；取不到是这个文件没被审计过。
    // 两者都当 missing 放过的话，网络抖一下就少扫几个文件，而结论照样是绿的。
    const fetchText = async (url: string) => {
      if (url === SITE) return '<script type="module" src="./assets/index-aaa.js"></script>';
      if (url.endsWith('index-aaa.js')) return `const w="${WEBSITE_ID}",s="${SCRIPT_URL}";import"./lazy-bbb.js";`;
      throw new Error('502 Bad Gateway');
    };

    const scan = await collectSiteScripts({ baseUrl: SITE, fetchText });
    const result = auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL });

    expect(scan.stats.unreachable).toBe(1);
    expect(failedNames(result)).toContain('引用到的文件都取到了');
  });

  it('抓不到的引用只记数，不算失败', async () => {
    // 从压缩后的代码里认文件名难免有认错的，这些地址一取就是 404。
    // 它们不该把审计判红，但要出现在统计里，好判断正则是不是太松了。
    const pages = {
      [SITE]: '<script type="module" src="./assets/index-aaa.js"></script>',
      [`${SITE}assets/index-aaa.js`]: `const w="${WEBSITE_ID}",s="${SCRIPT_URL}";const nope="./ghost-999.js";`,
    };

    const scan = await collectSiteScripts({ baseUrl: SITE, fetchText: fakeSite(pages) });
    const result = auditTrackerFootprint({ scan, websiteId: WEBSITE_ID, scriptUrl: SCRIPT_URL });

    expect(scan.stats.missing).toBe(1);
    expect(failedNames(result)).toEqual([]);
  });
});
