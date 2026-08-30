// 「设置 → API 预设」这块的接线守卫。
//
// 仓库的 vitest 跑在纯 Node 环境（组件测试没装 testing-library），所以沿用
// amsg2CharToggle.wiring.test.ts 的做法做**源码级**断言。验证不了运行时时序，
// 只防下面这几种回归——它们的共同点是全都不报错、界面上也看不出来：
//
//   1. 草稿同步 effect 又拿整个 apiConfig 当依赖
//      → 在识图 / 语音那块点一下保存，主 API 这边没保存的输入被悄悄冲回旧值
//   2. 保存按钮又顺手覆盖「选中的」预设
//      → 上一条冲回来的旧值被写进预设，那条预设从此永久坏掉，只能删了重建
//   3. 点预设绕开 commitApiConfig 自己写配置
//      → 聊天换了 API，后台已排程的主动消息还拿旧 Key 打请求，到点一片 401
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const settings = readFileSync(fileURLToPath(new URL('../apps/Settings.tsx', import.meta.url)), 'utf8');

/** 截出某个顶层箭头函数的函数体（这些函数在文件里都是两空格缩进 + `};` 收尾）。 */
const bodyOf = (name: string): string => {
  const start = settings.indexOf(`const ${name} = `);
  expect(start, `${name} 没找到`).toBeGreaterThan(-1);
  const end = settings.indexOf('\n  };', start);
  expect(end, `${name} 的函数体没收尾`).toBeGreaterThan(start);
  return settings.slice(start, end);
};

describe('草稿同步不跨区块打架', () => {
  it('同步 effect 不以整个 apiConfig 对象为依赖', () => {
    // updateApiConfig 每次都返回新对象。整个对象当依赖 = 任何一处保存都会重置所有输入框。
    expect(settings).not.toMatch(/\}, \[apiConfig\]\);/);
  });

  it('主 API 那份只盯自己的五个字段', () => {
    expect(settings).toMatch(
      /\}, \[apiConfig\.baseUrl, apiConfig\.apiKey, apiConfig\.model, apiConfig\.stream, apiConfig\.temperature\]\);/,
    );
  });
});

describe('点预设 = 直接切过去', () => {
  it('预设名按钮走 applyPreset，不是「载入草稿」', () => {
    expect(settings).toMatch(/onClick=\{\(\) => applyPreset\(preset\)\}/);
    expect(settings).not.toMatch(/loadPreset/);
  });

  it('切换走 commitApiConfig，不自己调 updateApiConfig（否则漏掉凭据同步）', () => {
    const applyPreset = bodyOf('applyPreset');
    expect(applyPreset).toMatch(/commitApiConfig\(configFromPreset\(preset\)\)/);
    expect(applyPreset).not.toMatch(/updateApiConfig\(/);
  });

  it('高亮的是「当前生效的那条」，按已保存配置反查', () => {
    expect(settings).toMatch(/activePresetId = useMemo\(\s*\(\) => findActivePresetId\(apiPresets, apiConfig\)/);
  });
});

describe('保存配置不反写预设', () => {
  it('handleSaveApi 只改当前配置', () => {
    const handleSaveApi = bodyOf('handleSaveApi');
    expect(handleSaveApi).toMatch(/commitApiConfig\(nextConfig\)/);
    expect(handleSaveApi).not.toMatch(/updateApiPreset/);
  });

  it('改预设只有编辑弹窗这一个入口', () => {
    expect(settings.match(/updateApiPreset\(/g) ?? []).toHaveLength(1);
    expect(bodyOf('handleUpdatePreset')).toMatch(/updateApiPreset\(preset\.id, name, nextConfig\)/);
  });

  it('改的正好是在用的那条时，当前配置一起跟着走', () => {
    const handleUpdatePreset = bodyOf('handleUpdatePreset');
    // wasActive 必须在 updateApiPreset 之前算好：改完值就对不上了，反查会落空
    expect(handleUpdatePreset).toMatch(
      /const wasActive = activePresetId === preset\.id;[\s\S]*updateApiPreset\(/,
    );
    expect(handleUpdatePreset).toMatch(/if \(wasActive\) commitApiConfig\(/);
  });

  it('铅笔编辑会读取并保存每条预设自己的流式与温度', () => {
    const openEditPreset = bodyOf('openEditPreset');
    const handleUpdatePreset = bodyOf('handleUpdatePreset');

    // 正在使用的那条优先拿主表单值：改完高级设置后，点铅笔再保存就能真正写回预设。
    expect(openEditPreset).toMatch(/const isActive = activePresetId === preset\.id/);
    expect(openEditPreset).toMatch(/setEditPresetStream\([\s\S]*isActive \? localStream/);
    expect(openEditPreset).toMatch(/setEditPresetTemperature\([\s\S]*isActive[\s\S]*localTemperature/);
    // 非当前预设仍读自己的值，不能被当前 API 的高级设置覆盖。
    expect(openEditPreset).toMatch(/typeof preset\.config\.stream === 'boolean'/);
    expect(openEditPreset).toMatch(/setEditPresetTemperature\([\s\S]*preset\.config\.temperature/);
    expect(handleUpdatePreset).toMatch(/stream:\s*editPresetStream/);
    expect(handleUpdatePreset).toMatch(/temperature:\s*editPresetTemperature/);
  });

  it('用当前配置填入时不会漏掉高级设置', () => {
    expect(settings).toMatch(/setEditPresetStream\(localStream\)/);
    expect(settings).toMatch(/setEditPresetTemperature\(localTemperature\)/);
    expect(settings).toMatch(/aria-pressed=\{editPresetStream\}/);
    expect(settings).toMatch(/value=\{editPresetTemperature\}/);
  });
});

describe('换 API 一定连着换云端凭据', () => {
  it('commitApiConfig 里三件事齐全', () => {
    const commitApiConfig = bodyOf('commitApiConfig');
    expect(commitApiConfig).toMatch(/updateApiConfig\(patch\)/);
    expect(commitApiConfig).toMatch(/syncAmsgLlmCredentials\(\{ \.\.\.apiConfig, \.\.\.patch \}\)/);
    expect(commitApiConfig).toMatch(/refreshApiCredentialsForPendingTasks\(\{ \.\.\.apiConfig, \.\.\.patch \}\)/);
  });
});
