/**
 * 线上产物核对：把用户浏览器真正会加载到的 js 全部抓下来，
 * 在里面找统计站点 id 和 tracker 地址。
 *
 * 为什么要抓全站而不是只看入口那一个文件：
 * 统计配置落在哪个 chunk 里，是打包器按依赖图自行决定的，跟隐私承诺无关。
 * 依赖图一变它就换个地方待着（2026-08-16 起连红两天就是这么来的：某个模块
 * 在「记忆宫殿」和「amsg 运行时」之间架了条依赖边，analytics 那一片被划进了
 * memory-palace 包，入口包里从此不含这两个值）。
 * 更要紧的是反方向：多出来的第二个上报端点只要待在懒加载 chunk 里，
 * 「只看入口」的查法就永远发现不了 —— 假红只是难看，这个是真会漏。
 *
 * 所以这里从 index.html 出发，顺着各个 chunk 之间的引用一路跟下去，
 * 扫完再下结论；中途撞上限就直接判失败，不按「已经扫到的那部分」报通过。
 *
 * 用法：
 *   node scripts/audit-online-bundle.mjs --base https://例子.github.io/仓库/ \
 *        --website-id <uuid> --script-url https://统计实例/script.js
 *   node scripts/audit-online-bundle.mjs --dir dist --website-id ... --script-url ...
 *
 * stdout 是给机器看的 JSON（workflow 用 jq 取里面的 checks），
 * 人看的日志走 stderr。
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** 一轮扫描最多抓多少个 js / 多少字节。撞上就停，并且判失败。 */
const DEFAULT_LIMITS = { maxFiles: 300, maxBytes: 120 * 1024 * 1024 };

/**
 * 产物里出现的 tracker 脚本地址长这样。跟 assert-privacy.sh 的判定保持一致。
 * 每次现造一个：带 g 的正则自带 lastIndex，共享一份迟早要在这上面翻车。
 */
const trackerPattern = () => /https:\/\/[A-Za-z0-9.-]+\/script\.js/g;

/**
 * 从一份文本（index.html 或某个 chunk）里找出它引用的、本站内的 js 地址。
 *
 * 几种写法都要认：
 *   · `"./memory-palace-abc.js"`  chunk 之间的 import，相对当前文件
 *   · `"assets/Chat-abc.js"`      懒加载用的 __vite__mapDeps 数组，相对站点根
 *   · `"/assets/Chat-abc.js"`     根路径写法，取决于构建时的 base 配置
 *
 * 「算不算本站」按同源判定，跟浏览器一个标准：同源的它都会去加载，
 * 那审计就都得跟。用「地址以站点根开头」来判会漏 —— base 配置一改，
 * 根路径写法就整批跳出前缀，从审计视野里消失，而浏览器照加载不误。
 *
 * @param {string} text 文件内容
 * @param {string} fromUrl 这份内容自己的地址
 * @param {string} baseUrl 站点根，必须以 / 结尾
 * @returns {string[]} 去重后的绝对地址
 */
export function extractScriptRefs(text, fromUrl, baseUrl) {
  const refs = new Set();
  const pattern = /["'`]([^"'`\s<>]{1,300}\.js)["'`]/g;
  const siteOrigin = new URL(baseUrl).origin;

  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    let resolved;
    try {
      // 以 . 或 / 开头的是相对/根路径写法，按当前文件解析；
      // 裸路径（mapDeps 数组里那种）按站点根解析。
      const anchor = raw.startsWith('.') || raw.startsWith('/') ? fromUrl : baseUrl;
      resolved = new URL(raw, anchor);
    } catch {
      continue;
    }
    if (resolved.origin !== siteOrigin) continue;
    refs.add(resolved.href);
  }

  return [...refs];
}

/**
 * 从 index.html 出发，把站内所有能引用到的 js 抓下来。
 *
 * 有几个文件是 import 链上找不到的：public/ 下原样复制上线的那些，
 * 其中一部分由运行时拼出地址来加载（MediaPipe 的 wasm glue 就是这样）。
 * 浏览器照样会加载它们，所以调用方可以用 extraPaths 把这些路径直接补进起点。
 *
 * @param {object} options
 * @param {string} options.baseUrl 站点根，必须以 / 结尾
 * @param {(url: string) => Promise<string | null>} options.fetchText 取文本；取不到返回 null
 * @param {string[]} [options.extraPaths] 额外起点，相对站点根
 * @param {{ maxFiles?: number, maxBytes?: number }} [options.limits]
 * @returns {Promise<{ files: {url: string, text: string, bytes: number}[],
 *                     stats: { fetched: number, missing: number, bytes: number, indexReadable: boolean },
 *                     truncated: null | { reason: string, limit: number } }>}
 */
export async function collectSiteScripts({ baseUrl, fetchText, extraPaths = [], limits = {} }) {
  const { maxFiles, maxBytes } = { ...DEFAULT_LIMITS, ...limits };

  const files = [];
  const stats = { fetched: 0, missing: 0, unreachable: 0, bytes: 0, indexReadable: false };
  let truncated = null;

  const indexText = await fetchText(baseUrl);
  const queue = [];
  const seen = new Set();

  const enqueue = (url) => {
    if (seen.has(url)) return;
    seen.add(url);
    queue.push(url);
  };

  if (indexText !== null) {
    stats.indexReadable = true;
    for (const ref of extractScriptRefs(indexText, baseUrl, baseUrl)) enqueue(ref);
  }

  for (const extra of extraPaths) {
    try {
      enqueue(new URL(extra, baseUrl).href);
    } catch {
      // 给了个解析不了的路径，跳过就行 —— 抓不到的引用本来也只记数。
    }
  }

  while (queue.length > 0) {
    if (files.length >= maxFiles) {
      truncated = { reason: 'maxFiles', limit: maxFiles };
      break;
    }
    if (stats.bytes >= maxBytes) {
      truncated = { reason: 'maxBytes', limit: maxBytes };
      break;
    }

    const url = queue.shift();
    let text;
    try {
      text = await fetchText(url);
    } catch (error) {
      // 取不到 ≠ 不存在。这个文件没被审计过，结论就有个缺口，
      // 不能跟「认错文件名」一样放过去。
      stats.unreachable += 1;
      console.error(`  ⚠️  取不到 ${url}：${error?.message || error}`);
      continue;
    }
    if (text === null) {
      // 从压缩过的代码里认文件名难免认错，认错的地址一取就是 404。
      // 这些不算失败，但要记数：数字太大就说明上面那个正则该收紧了。
      stats.missing += 1;
      continue;
    }

    const bytes = Buffer.byteLength(text);
    files.push({ url, text, bytes });
    stats.fetched += 1;
    stats.bytes += bytes;

    for (const ref of extractScriptRefs(text, url, baseUrl)) enqueue(ref);
  }

  return { files, stats, truncated };
}

/**
 * 对扫到的产物做断言。
 *
 * @param {object} options
 * @param {{ files: {url: string, text: string}[], truncated: any }} options.scan
 * @param {string} options.websiteId
 * @param {string} options.scriptUrl
 * @returns {{ checks: {name: string, expected: string, actual: string, ok: boolean, note?: string}[],
 *             failed: {name: string, expected: string, actual: string}[] }}
 */
export function auditTrackerFootprint({ scan, websiteId, scriptUrl }) {
  const checks = [];
  const add = (name, expected, actual, note) => {
    checks.push({ name, expected, actual, ok: expected === actual, ...(note ? { note } : {}) });
  };

  // 这几条是「结论有没有依据」的前提，放最前面。
  // 探测这一侧自己坏掉的时候（站点拿不到、入口包 404、爬了一半撞上限、
  // 有文件取不到），「什么都没查出来」和「查完没问题」长得一模一样，而且是绿的。
  add('抓到了可供审计的产物', 'yes', scan.files.length > 0 ? 'yes' : 'no');
  add(
    '扫描覆盖完整（没撞上限）',
    'yes',
    scan.truncated ? `no（撞上 ${scan.truncated.reason}=${scan.truncated.limit}）` : 'yes',
  );
  add('引用到的文件都取到了', '0 个取不到', `${scan.stats.unreachable} 个取不到`);

  const idHit = scan.files.find((file) => file.text.includes(websiteId));
  add(
    '线上产物内含该站点 id',
    'yes',
    idHit ? 'yes' : 'no',
    idHit ? `出现在 ${idHit.url.split('/').pop()}` : undefined,
  );

  // 产物里出现的 tracker 地址去重后必须只有一个，且就是配的那个。
  // 多出一个 = 页面上还挂着第二个上报端点。
  const found = new Set();
  for (const file of scan.files) {
    for (const match of file.text.matchAll(trackerPattern())) found.add(match[0]);
  }
  const got = [...found].sort().join(',');
  add('线上产物内 tracker 地址唯一且相符', scriptUrl, got || '（没找到）');

  return { checks, failed: checks.filter((check) => !check.ok) };
}

// ───────────────────────── 以下是命令行入口 ─────────────────────────

/** `--a b --c d` → { a: 'b', c: 'd' } */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? '' : (argv[i + 1] ?? '');
  }
  return out;
}

/**
 * 走网络取文本。404 当「这个地址本来就没有」（多半是从压缩代码里认错了文件名），
 * 其余的失败先重试，重试完还不行就抛 —— 那意味着这个文件没被审计到，
 * 是结论上的缺口，不能跟认错文件名一样默默放过。
 */
function httpFetcher(timeoutMs = 60_000, retries = 2) {
  return async (url) => {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      } catch (error) {
        lastError = error;
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    throw lastError;
  };
}

/** 从本地构建产物里取，用来自查（node scripts/audit-online-bundle.mjs --dir dist）。 */
function directoryFetcher(dir, baseUrl) {
  return async (url) => {
    const relative = url.slice(baseUrl.length) || 'index.html';
    try {
      return await readFile(path.join(dir, decodeURIComponent(relative)), 'utf8');
    } catch {
      return null;
    }
  };
}

/**
 * 列出 public/ 下所有 js 的相对路径。这个目录是原样复制上线的，
 * 站点上的地址就是「站点根 + 这里的相对路径」。
 */
async function listPublicScripts(dir) {
  const found = [];
  async function walk(current, prefix) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), relative);
      else if (entry.name.endsWith('.js')) found.push(relative);
    }
  }
  await walk(dir, '');
  return found;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const websiteId = args['website-id'] || process.env.AUDIT_WEBSITE_ID || '';
  const scriptUrl = args['script-url'] || process.env.AUDIT_SCRIPT_URL || '';
  const dir = args.dir || '';
  // 本地目录模式借一个 http 假地址当站点根：同源判定要有 origin，
  // 而 file:// 的 origin 是 null，判不了。
  const baseUrl = dir ? 'http://local/' : (args.base || process.env.AUDIT_BASE_URL || '');

  if (!websiteId || !scriptUrl || (!dir && !args.base && !process.env.AUDIT_BASE_URL)) {
    console.error('用法：--base <站点根 URL> | --dir <本地目录>，外加 --website-id 与 --script-url');
    process.exit(2);
  }

  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const fetchText = dir ? directoryFetcher(dir, base) : httpFetcher();

  // 改 workflow 的 push 会顺带触发一次部署，两边撞车时 index.html 指向的 chunk
  // 可能正在被换掉，抓下来是 404。整轮重试 —— 部署一次 chunk 名就变一次，
  // 只重试下载单个文件是没用的。
  const extraPaths = args['public-dir'] ? await listPublicScripts(args['public-dir']) : [];

  let scan = null;
  const attempts = dir ? 1 : 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    scan = await collectSiteScripts({ baseUrl: base, fetchText, extraPaths });
    if (scan.files.length > 0) break;
    if (attempt < attempts) {
      console.error(`  第 ${attempt} 次一个 js 都没抓到，等 20 秒重试（多半是正撞上部署）`);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
    }
  }

  const result = auditTrackerFootprint({ scan, websiteId, scriptUrl });

  console.error(`  扫描起点 ${base}${extraPaths.length ? `，外加 public/ 里的 ${extraPaths.length} 个静态 js` : ''}`);
  console.error(
    `  抓到 ${scan.stats.fetched} 个 js（${scan.stats.bytes} 字节）；` +
      `${scan.stats.missing} 个地址是 404（认错文件名，正常）；` +
      `${scan.stats.unreachable} 个取不到`,
  );
  for (const check of result.checks) {
    const suffix = check.note ? `  ${check.note}` : '';
    if (check.ok) console.error(`  ✅ ${check.name.padEnd(38)} ${check.actual}${suffix}`);
    else console.error(`  ❌ ${check.name.padEnd(38)} 期望 ${check.expected}，实际 ${check.actual}`);
  }

  process.stdout.write(`${JSON.stringify({ checks: result.checks, stats: scan.stats }, null, 2)}\n`);
  process.exit(result.failed.length === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`审计脚本自己出错了：${error?.stack || error}`);
    process.exit(2);
  });
}
