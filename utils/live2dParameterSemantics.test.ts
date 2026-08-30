import { describe, expect, it } from 'vitest';
import {
  describeLive2DParameter,
  groupLive2DParameters,
  live2DParameterPosition,
} from './live2dParameterSemantics';

describe('Live2D 参数语义', () => {
  it('把常见 Cubism 参数翻译成作用部位和可理解方向', () => {
    expect(describeLive2DParameter('ParamEyeLOpen')).toMatchObject({
      area: 'eyes',
      label: '左眼开合',
      negativeLabel: '闭合',
      positiveLabel: '睁开',
    });
    expect(describeLive2DParameter('ParamMouthForm')).toMatchObject({
      area: 'mouth',
      negativeLabel: '嘟嘴',
      positiveLabel: '微笑',
    });
    expect(describeLive2DParameter('ParamAngleY')).toMatchObject({
      area: 'head',
      negativeLabel: '低头',
      positiveLabel: '抬头',
    });
  });

  it('对模型自定义参数明确保留原始 ID 与未知语义', () => {
    expect(describeLive2DParameter('ParamSpecialStarEye')).toMatchObject({
      area: 'other',
      label: 'ParamSpecialStarEye',
      negativeLabel: '最小值',
      positiveLabel: '最大值',
    });
  });

  it('按语义部位分组并计算默认点在轨道上的位置', () => {
    const groups = groupLive2DParameters([
      { id: 'ParamMouthOpenY' },
      { id: 'ParamEyeROpen' },
      { id: 'ParamMouthForm' },
    ]);
    expect(groups.map(group => [group.area, group.parameters.length])).toEqual([
      ['mouth', 2],
      ['eyes', 1],
    ]);
    expect(live2DParameterPosition(0, -1, 1)).toBe(50);
    expect(live2DParameterPosition(4, 0, 2)).toBe(100);
  });
});
