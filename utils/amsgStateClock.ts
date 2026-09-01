// utils/amsgStateClock.ts
//
// 云端 client_state 那一行该盖几点的版本号（`updatedAt`）。
//
// 云端的写入是条件写：新来的 `updatedAt` 不比库里那行晚，整条就跳过（旧不盖新，
// 见 worker 的 `WHERE excluded.updated_at >= client_state.updated_at`）。这道闸护的是
// 「慢包后到别盖掉新包」，判据却是客户端自己报的时间——于是它护不住设备时钟本身跑偏：
// 手机的钟只要领先过真实时间，那一刻同步上去的行就带着一个**还没到的时刻**，之后每
// 次上传都比它「旧」，云端从此一直拒收。
//
// 这不是理论上的坑。2026-09-01 有用户改过一次系统时间，之后那个角色的即时对话一直
// 报 409，删消息、重启、重装小手机、重填 Worker 地址全都不管用——那一行在云端 D1 里，
// 本地做什么都碰不到它；而常规的批量同步撞上同一道闸只打一行 log，那个角色的云端上
// 下文就一直停在旧版本，界面上什么都看不出来。
//
// 所以本地记一道水位：盖出去的时间戳只会往前走，绝不回头。正常情况下（时钟没跑偏）
// 水位就是上次写入的时刻，`Date.now()` 每次都比它大，行为与直接用墙钟完全一致；
// 只有在时钟被回拨、或云端那行已经落在未来时，水位才接管，保证这一次写得进去。
//
// 水位有两个抬升来源：自己每次盖戳（同一毫秒内连写两次也能严格递增），以及
// `observeRemoteStateUpdatedAt` —— 云端明说了它那份更新时，照它的数对齐。

const HEADER = '[AmsgStateClock]';

/** 水位的落盘位置。存 localStorage 而不是内存：关掉页面再回来，云端那行还在原地。 */
export const AMSG_STATE_CLOCK_LS_KEY = 'amsg2_state_clock_watermark';

/** 水位领先本机时钟超过这么久就喊一声——正常状态下两者只差几毫秒。 */
const CLOCK_SKEW_WARN_MS = 60_000;

/** 内存里的当前水位；null = 还没从 localStorage 读回来。 */
let watermark: number | null = null;

const readWatermark = (): number => {
  if (watermark !== null) return watermark;
  try {
    const raw = Number(localStorage.getItem(AMSG_STATE_CLOCK_LS_KEY));
    watermark = Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
  } catch {
    // 隐私模式 / 没有 localStorage 的环境：退回纯内存，本次会话内仍然单调。
    watermark = 0;
  }
  return watermark;
};

const writeWatermark = (value: number) => {
  watermark = value;
  try {
    localStorage.setItem(AMSG_STATE_CLOCK_LS_KEY, String(value));
  } catch {
    // 存储满 / 写不进去：这一轮盖的戳仍然是对的，只是重启后退回本地时钟。
  }
};

const warnIfAhead = (value: number, now: number, reason: string) => {
  const skew = value - now;
  if (skew <= CLOCK_SKEW_WARN_MS) return;
  console.warn(
    `${HEADER} 云端状态的时间戳领先本机时钟 ${Math.round(skew / 1000)} 秒（${reason}）。`
    + '设备时钟大概被改过，云端那行要等真实时间追上来才会回到正常节奏。',
  );
};

/**
 * 给这一次 client_state 写入盖一个时间戳：本机时钟与水位取大的那个，且严格递增。
 *
 * 凡是往云端写状态的地方都该用它，别再各自 `Date.now()` —— 只要有一条路漏了，
 * 那条路就会在时钟跑偏后一直被云端拒收。
 */
export const stampStateUpdatedAt = (): number => {
  const now = Date.now();
  const at = Math.max(now, readWatermark() + 1);
  writeWatermark(at);
  warnIfAhead(at, now, '本地水位');
  return at;
};

/**
 * 云端那份的时间戳比本地水位还新时，照它对齐（返回是否真的抬动了）。
 *
 * 用在「被条件写拦下」之后：拦下就说明云端那行的时间戳我们跨不过去，读回来对齐一次，
 * 下一次写入自然就盖得上。返回 false 表示水位没动——那这次被拦不是时间戳的事，
 * 重发也是白发。
 */
export const observeRemoteStateUpdatedAt = (remoteUpdatedAt: unknown): boolean => {
  if (typeof remoteUpdatedAt !== 'number' || !Number.isSafeInteger(remoteUpdatedAt)) return false;
  if (remoteUpdatedAt <= readWatermark()) return false;
  writeWatermark(remoteUpdatedAt);
  warnIfAhead(remoteUpdatedAt, Date.now(), '云端那行');
  return true;
};

/** 当前水位（排障与单测用；日常代码不需要看它）。 */
export const readStateClockWatermark = (): number => readWatermark();

/** 把水位清零（单测用：各条用例之间不互相污染）。 */
export const resetStateClock = () => {
  watermark = null;
  try {
    localStorage.removeItem(AMSG_STATE_CLOCK_LS_KEY);
  } catch {
    // 同上，读不到就当没有。
  }
};
