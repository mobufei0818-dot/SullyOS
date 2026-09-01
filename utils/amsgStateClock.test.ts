// utils/amsgStateClock.test.ts
//
// 回归守卫（云端 client_state 那一行的版本号该盖几点）：
//   1. 时钟正常走的时候盖的戳就是墙钟本身。这一层绝不能给正常路径引入偏移——云端那行
//      一旦莫名其妙领先真实时间，换台设备（水位是空的）就写不进去了。
//   2. 设备时钟被回拨之后，盖出去的戳仍然往前走。这是这个模块存在的全部理由：云端是
//      条件写（旧不盖新），戳只要回头，那台设备就再也写不进去。
//   3. 云端那行落在未来时，照它对齐一次就能跨过去——这是已经卡住的人唯一的出路。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AMSG_STATE_CLOCK_LS_KEY,
  observeRemoteStateUpdatedAt,
  readStateClockWatermark,
  resetStateClock,
  stampStateUpdatedAt,
} from './amsgStateClock';

/** 让 Date.now 按给定的序列往外吐（用完停在最后一个）。 */
const mockClock = (values: number[]) => {
  let i = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => values[Math.min(i++, values.length - 1)]);
};

beforeEach(() => {
  resetStateClock();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetStateClock();
});

describe('盖戳', () => {
  it('时钟正常往前走时，盖的就是墙钟本身（不引入任何偏移）', () => {
    mockClock([1_000, 2_000, 3_000]);

    expect(stampStateUpdatedAt()).toBe(1_000);
    expect(stampStateUpdatedAt()).toBe(2_000);
    expect(stampStateUpdatedAt()).toBe(3_000);
  });

  it('同一毫秒内连写两次也严格递增（条件写用的是 >=，相等能过，但递增更稳）', () => {
    mockClock([1_000]);

    expect(stampStateUpdatedAt()).toBe(1_000);
    expect(stampStateUpdatedAt()).toBe(1_001);
  });

  it('时钟被回拨之后，戳不跟着回头', () => {
    // 5 秒处写过一次，然后用户把钟往回拨了 1 秒。
    mockClock([5_000, 4_000, 4_001]);

    expect(stampStateUpdatedAt()).toBe(5_000);
    expect(stampStateUpdatedAt()).toBe(5_001);
    expect(stampStateUpdatedAt()).toBe(5_002);
  });

  it('水位落盘，重新读得回来（关掉页面再回来，云端那行还在原地）', () => {
    mockClock([7_000]);

    stampStateUpdatedAt();
    expect(localStorage.getItem(AMSG_STATE_CLOCK_LS_KEY)).toBe('7000');
  });
});

describe('照云端对齐', () => {
  it('云端那行落在未来 → 对齐一次，之后盖的戳就跨过去了', () => {
    // 本机的钟停在 5 秒处，云端那行却记着 9 秒（当初设备时钟领先时写进去的）。
    mockClock([5_000]);

    expect(observeRemoteStateUpdatedAt(9_000)).toBe(true);
    expect(stampStateUpdatedAt()).toBe(9_001);
  });

  it('云端那行比水位旧 → 不动水位，也不谎报对齐过（重发是白发）', () => {
    mockClock([5_000]);
    stampStateUpdatedAt();

    expect(observeRemoteStateUpdatedAt(3_000)).toBe(false);
    expect(readStateClockWatermark()).toBe(5_000);
  });

  it('云端回的不是个正经时间戳 → 一律不动水位', () => {
    mockClock([5_000]);
    stampStateUpdatedAt();

    for (const bad of [undefined, null, 'a', NaN, 1.5, Number.MAX_VALUE]) {
      expect(observeRemoteStateUpdatedAt(bad)).toBe(false);
    }
    expect(readStateClockWatermark()).toBe(5_000);
  });
});
