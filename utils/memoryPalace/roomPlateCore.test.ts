// utils/memoryPalace/roomPlateCore.test.ts
// 门牌整理上云带来的那个时间差：提示词是拿**提交那一刻**的快照拼的，LLM 说的 `U0`
// 指的是快照里的第 0 条；结果几分钟后才回来，这中间门牌可能已经被别的路径动过
// （手动回填就在本地跑）。不重新对准标签就直接合并，`U0` 会指到另一条认知上，
// 两条认知的来历（firstLearnedAt / sourceCount）被悄悄接错——而且界面上完全看不出来。
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { mergeCloudPlateEntries, mergePlateEntries, remapBasedOnLabels } from './roomPlateCore';
import { PLATE_ENTRY_CAPS } from './types';
import type { PlateEntry } from './types';

const entry = (id: string, text: string, extra: Partial<PlateEntry> = {}): PlateEntry => ({
  id,
  text,
  firstLearnedAt: 1_000,
  updatedAt: 1_000,
  sourceCount: 1,
  ...extra,
});

describe('remapBasedOnLabels — 把 basedOn 从「提交时的标签」改写成「现在的标签」', () => {
  it('门牌没动过时是恒等变换', () => {
    const current = [entry('pe_a', 'A'), entry('pe_b', 'B')];
    const items = [{ room: 'user_room', text: 'A+', basedOn: 'U1' }];
    expect(remapBasedOnLabels('user_room', items, ['pe_a', 'pe_b'], current))
      .toEqual([{ room: 'user_room', text: 'A+', basedOn: 'U1' }]);
  });

  it('提交后前面插了一条 → 标签跟着后移，指的还是同一条认知', () => {
    // 提交时：[pe_a, pe_b]，LLM 说 U1 = pe_b
    // 回来时：[pe_new, pe_a, pe_b]，pe_b 现在排第 2
    const current = [entry('pe_new', 'N'), entry('pe_a', 'A'), entry('pe_b', 'B')];
    const items = [{ room: 'user_room', text: 'B+', basedOn: 'U1' }];
    expect(remapBasedOnLabels('user_room', items, ['pe_a', 'pe_b'], current)[0].basedOn).toBe('U2');
  });

  // 回归守卫：这份结果拿的是旧快照，它「保留」的是一条已经不在了的认知。当新条目收
  // 进去就是原地复活，而门牌面板恰恰是用户手删的地方——删完还眼看着它自己长回来。
  it('快照里有、现在没了（提交之后被删掉）→ 整条丢掉，不许当新条目复活', () => {
    const current = [entry('pe_c', 'C')];
    const items = [
      { room: 'user_room', text: 'B+', basedOn: 'U1' },
      { room: 'user_room', text: 'C', basedOn: null },
    ];

    expect(
      remapBasedOnLabels('user_room', items, ['pe_a', 'pe_b'], current),
      '抹成 null 当新条目收的话，用户刚删掉的那条会带着新 id 长回来',
    ).toEqual([{ room: 'user_room', text: 'C', basedOn: null }]);
  });

  it('标签越界 / 前缀不对 / 不是数字 → 一律抹成 null', () => {
    const current = [entry('pe_a', 'A')];
    const ids = ['pe_a'];
    const bad = [
      { room: 'user_room', text: 'x', basedOn: 'U9' },
      { room: 'user_room', text: 'x', basedOn: 'B0' },
      { room: 'user_room', text: 'x', basedOn: 'Uabc' },
    ];
    for (const item of bad) {
      expect(remapBasedOnLabels('user_room', [item], ids, current)[0].basedOn).toBeNull();
    }
  });

  // 回归守卫：光秃秃的前缀是「不是数字」里最坑的一种，因为 Number('') 是 0。
  it('模型把数字掉了（basedOn: "U"）→ 抹成 null，不许当成第 0 条', () => {
    const current = [entry('pe_first', '第一条', { firstLearnedAt: 100, sourceCount: 5 })];
    const items = [{ room: 'user_room', text: '一条毫不相干的新认知', basedOn: 'U' }];

    const aligned = remapBasedOnLabels('user_room', items, ['pe_first'], current);
    expect(aligned[0].basedOn, 'Number("") === 0，不显式挡住就会指到快照第 0 条').toBeNull();

    // 落到合并上：当新条目收，不继承第一条的来历
    const merged = mergePlateEntries('user_room', current, aligned, 20_000);
    expect(merged[0].id).not.toBe('pe_first');
    expect(merged[0].firstLearnedAt).toBe(20_000);
  });
});

describe('mergeCloudPlateEntries — 护住提交之后才出现的条目', () => {
  it('回归守卫：等结果的这一两分钟里新沉淀的条目不被整理结果淘汰', () => {
    // 提交时快照里只有 pe_old；结果还没回来，封盒又往门牌里写了 pe_fresh。
    // LLM 压根没见过 pe_fresh，它没被重新输出不等于「决定淘汰」。
    const snapshotIds = ['pe_old'];
    const current = [entry('pe_old', '小明住家里'), entry('pe_fresh', '小明最近在学做饭')];
    const items = [{ text: '小明搬去和同学合租', basedOn: 'U0' }];

    expect(
      mergePlateEntries('user_room', current, items, 20_000).map(e => e.id),
      '照原样合并的话 pe_fresh 被静默抹掉——用户看到刚沉淀的认知凭空消失',
    ).toEqual(['pe_old']);

    expect(mergeCloudPlateEntries('user_room', current, items, snapshotIds, 20_000, 0).map(e => e.id))
      .toEqual(['pe_old', 'pe_fresh']);
  });

  it('快照里的条目照常淘汰（合并语义没被削弱成只增不减）', () => {
    const current = [entry('pe_a', 'A'), entry('pe_b', 'B')];
    const items = [{ text: 'A', basedOn: 'U0' }];

    expect(mergeCloudPlateEntries('user_room', current, items, ['pe_a', 'pe_b'], 20_000, 0).map(e => e.id))
      .toEqual(['pe_a']);
  });

  it('整理结果里已经原样保留过的新条目不重复收一次', () => {
    // pe_fresh 不在快照里，但 LLM 恰好输出了同样的文本（没标 basedOn）
    const current = [entry('pe_fresh', '小明最近在学做饭')];
    const items = [{ text: '小明最近在学做饭' }];

    expect(mergeCloudPlateEntries('user_room', current, items, [], 20_000, 0).map(e => e.id))
      .toEqual(['pe_fresh']);
  });

  // 回归守卫：原先是 [...merged, ...born].slice(0, cap)——整理结果占满上限时 born 被整批
  // 扔掉，日志还写着「下轮整理再收」。可它们的来源节点早就打过 digestedAt，不会再来第二
  // 次，那批认知就这么永久没了，而门牌上看不出少了什么。
  it('整理结果占满上限时也要给快照之后新增的条目留位子', () => {
    const cap = PLATE_ENTRY_CAPS.user_room;
    const current = [entry('pe_fresh', '刚沉淀的')];
    const items = Array.from({ length: cap }, (_, i) => ({ text: `整理出来的第 ${i} 条` }));

    const merged = mergeCloudPlateEntries('user_room', current, items, [], 20_000, 0);
    expect(merged, '门牌不能被撑爆').toHaveLength(cap);
    expect(merged.some(e => e.id === 'pe_fresh'), '来源已消化，挤掉就是永久丢').toBe(true);
  });

  it('新增的条目再多也不许把整理结果整块挤出去（一半封顶）', () => {
    const cap = PLATE_ENTRY_CAPS.user_room;
    const current = Array.from({ length: cap }, (_, i) => entry(`pe_fresh_${i}`, `刚沉淀的第 ${i} 条`));
    const items = Array.from({ length: cap }, (_, i) => ({ text: `整理出来的第 ${i} 条` }));

    const merged = mergeCloudPlateEntries('user_room', current, items, [], 20_000, 0);
    expect(merged).toHaveLength(cap);
    expect(merged.filter(e => e.id.startsWith('pe_fresh')), '粗糙候选不该反客为主')
      .toHaveLength(Math.floor(cap / 2));
  });

  // 回归守卫：门牌面板是人工纠错的口子——蒸错的事实一旦常驻，角色会自信地重复很久。
  // 用户在等结果这几分钟里把一条改对了，而这份结果照着改之前那份快照生成：照常合并
  // 就是把刚纠正的那条又盖回旧说法，用户看着自己敲的字变回原样。
  it('快照之后被本地改过的条目，文本以本地那份为准', () => {
    const snapshotAt = 10_000;
    // pe_home 在快照之后被用户改成了「小明搬去和同学合租了」（updatedAt 晚于快照时刻）
    const current = [entry('pe_home', '小明搬去和同学合租了', { firstLearnedAt: 100, updatedAt: 15_000, sourceCount: 5 })];
    const items = [{ text: '小明住家里', basedOn: 'U0' }];

    const merged = mergeCloudPlateEntries('user_room', current, items, ['pe_home'], 20_000, snapshotAt);
    expect(merged[0].text, '用户刚改对的事实被一份陈旧结果盖回去了').toBe('小明搬去和同学合租了');
    // 条目本身照常参与这一轮：来历留着，没被当成新条目重开
    expect(merged[0].id).toBe('pe_home');
    expect(merged[0].firstLearnedAt).toBe(100);
  });

  // 回归守卫：快照时刻原先取的是**提交那一刻**，而门牌是更早读出来的——中间还夹着拼身份
  // 上下文、探测这台 worker 认不认识后台任务（要发一次请求）、把消化刚提交的候选先保底
  // 并进去。用户在这几秒里改的字 LLM 根本没看到，却因为 updatedAt 早于提交时刻被判成
  // 「LLM 见过」，于是被一份陈旧结果原样盖回去。
  it('改动落在「读完门牌、还没提交」那几秒里，同样算本地改过', () => {
    const readAt = 10_000;       // 门牌是这一刻读出来的
    const submittedAt = 13_000;  // 三秒后才交上去
    const current = [entry('pe_home', '小明搬去和同学合租了', { firstLearnedAt: 100, updatedAt: 11_500 })];
    const items = [{ text: '小明住家里', basedOn: 'U0' }];

    expect(
      mergeCloudPlateEntries('user_room', current, items, ['pe_home'], 20_000, submittedAt)[0].text,
      '按提交时刻算就会漏掉这一段的编辑',
    ).toBe('小明住家里');
    expect(mergeCloudPlateEntries('user_room', current, items, ['pe_home'], 20_000, readAt)[0].text)
      .toBe('小明搬去和同学合租了');
  });

  // 回归守卫：交云端之前，送达保证会先把消化刚提交的候选机械并进门牌（fallbackMergeSubmissions），
  // 那批的 updatedAt 就是并入那一刻、必然晚于快照。把它们也当成「本地改过」的话，云端整理
  // 把粗糙候选改写成人话的结果会被原样退回去——而改写它们正是那一轮整理最主要的目的。
  it('从建出来就没被改过的条目照常被结果改写（保底并入的那批不算本地编辑）', () => {
    const rescued = entry('pe_raw', '父母离异', { firstLearnedAt: 12_000, updatedAt: 12_000 });
    const items = [{ text: '小明的父母在他初中时离异，他跟着母亲', basedOn: 'U0' }];

    const merged = mergeCloudPlateEntries('user_room', [rescued], items, ['pe_raw'], 20_000, 10_000);
    expect(merged[0].text, '粗糙候选没被改写，整理白跑一轮').toBe('小明的父母在他初中时离异，他跟着母亲');
    expect(merged[0].id).toBe('pe_raw');
  });

  // 结果迟到太久 / 记号被 TTL 收走 / 换了设备：快照时刻无从查起。那时候按「谁都可能被
  // 改过」保守处理——有过改动痕迹的一律留本地文本，没被碰过的照常让结果改写。
  it('快照时刻问不到（传 0）时，被改过的条目一律留本地文本', () => {
    const edited = entry('pe_edited', '用户手改过的说法', { firstLearnedAt: 100, updatedAt: 9_000 });
    const untouched = entry('pe_plain', '没人碰过的说法', { firstLearnedAt: 100, updatedAt: 100 });
    const items = [
      { text: '结果里的说法 A', basedOn: 'U0' },
      { text: '结果里的说法 B', basedOn: 'U1' },
    ];

    const merged = mergeCloudPlateEntries('user_room', [edited, untouched], items, ['pe_edited', 'pe_plain'], 20_000, 0);
    expect(merged[0].text).toBe('用户手改过的说法');
    expect(merged[1].text).toBe('结果里的说法 B');
  });

  it('提交之前就是那个样子的条目照常被结果改写（别把保护做成谁都不许动）', () => {
    const current = [entry('pe_home', '小明住家里', { firstLearnedAt: 100, updatedAt: 5_000 })];
    const items = [{ text: '小明搬去和同学合租了', basedOn: 'U0' }];

    const merged = mergeCloudPlateEntries('user_room', current, items, ['pe_home'], 20_000, 10_000);
    expect(merged[0].text).toBe('小明搬去和同学合租了');
    expect(merged[0].id).toBe('pe_home');
  });

  it('没带 basedOn 的原样穿过去', () => {
    const items = [{ room: 'user_room', text: 'x' }, { room: 'user_room', text: 'y', basedOn: null }];
    expect(remapBasedOnLabels('user_room', items, ['pe_a'], [entry('pe_a', 'A')])).toEqual(items);
  });

  // 这条是整件事的意义所在：不重映射会怎样。
  it('回归守卫：不重映射就会把来历接到另一条认知上', () => {
    // 提交时快照：[pe_home（住家里）, pe_job（在读研）]，LLM 要更新 U0「住家里」
    const snapshotIds = ['pe_home', 'pe_job'];
    const items = [{ room: 'user_room', text: '小明搬去和同学合租', basedOn: 'U0' }];
    // 结果回来时 pe_home 已经排到第 1（前面插进来一条别的）
    const current = [
      entry('pe_new', '小明养了只猫', { firstLearnedAt: 9_000, sourceCount: 1 }),
      entry('pe_home', '小明住家里', { firstLearnedAt: 100, sourceCount: 5 }),
      entry('pe_job', '小明在读研', { firstLearnedAt: 200, sourceCount: 3 }),
    ];

    // 不重映射：U0 落到 pe_new 上 —— 「养猫」那条的来历被「搬家」这条继承走了
    const wrong = mergePlateEntries('user_room', current, items, 20_000);
    expect(wrong[0].id).toBe('pe_new');
    expect(wrong[0].firstLearnedAt).toBe(9_000);

    // 重映射之后：落在 pe_home 上，继承的是「住家里」那条的来历
    const right = mergePlateEntries(
      'user_room', current, remapBasedOnLabels('user_room', items, snapshotIds, current), 20_000,
    );
    expect(right[0].id).toBe('pe_home');
    expect(right[0].firstLearnedAt).toBe(100);
    expect(right[0].sourceCount).toBe(6);
  });
});

describe('叶子纪律', () => {
    // 这三份都会被 pnpm build:workers 打进 amsg worker bundle。import 到带浏览器依赖的
    // 模块（db / safeApi / context / activeMsgClient…）就会在 worker 里炸，而且要等真机
    // 跑到那一步才发现。靠源码扫描当场拦住：白名单里的三个自己也是零依赖叶子。
    const ALLOWED = new Set([
        './types', './jsonUtils', './roomPlateCore',
        './memoryPalace/types', './memoryPalace/roomPlateCore',
    ]);

    it.each([
        ['门牌提示词与合并', './roomPlateCore.ts'],
        ['门牌上云契约', '../amsgPlateJob.ts'],
        ['后台任务通用约定', '../amsgTaskKinds.ts'],
    ])('%s 保持环境无关', (_label, rel) => {
        const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
        const specifiers = [...src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
        expect(specifiers.filter((s) => !ALLOWED.has(s))).toEqual([]);
        // 只认 `from` 的话，`import '../db';` 这种**只为副作用**的引入会整条漏过去——
        // 它一样会把 db 打进 bundle、一样在 worker 里炸，而这道守卫的意义正是别等真机
        // 跑到那一步才发现。这种写法在这三份叶子里没有任何正当用途，见一个拦一个。
        expect(src.match(/^\s*import\s*['"][^'"]+['"]/gm) ?? []).toEqual([]);
        // 动态引入同理，运行期才炸更难查
        expect(src.match(/\bimport\s*\(/g) ?? []).toEqual([]);
    });
});
