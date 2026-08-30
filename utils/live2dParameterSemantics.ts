export type Live2DParameterArea =
  | 'eyes'
  | 'brows'
  | 'mouth'
  | 'face'
  | 'head'
  | 'body'
  | 'arms'
  | 'hair'
  | 'effects'
  | 'tracking'
  | 'other';

export interface Live2DParameterSemantics {
  area: Live2DParameterArea;
  areaLabel: string;
  label: string;
  description: string;
  negativeLabel: string;
  positiveLabel: string;
}

const AREA_LABELS: Record<Live2DParameterArea, string> = {
  eyes: '眼睛',
  brows: '眉毛',
  mouth: '嘴部',
  face: '面部',
  head: '头部',
  body: '身体',
  arms: '手臂',
  hair: '头发',
  effects: '效果',
  tracking: '追踪输入',
  other: '其他',
};

const sideLabel = (id: string): string => {
  if (/(?:^|Param)(?:Eye|Brow|Arm)L/i.test(id) || /Left/i.test(id)) return '左';
  if (/(?:^|Param)(?:Eye|Brow|Arm)R/i.test(id) || /Right/i.test(id)) return '右';
  return '';
};

const result = (
  area: Live2DParameterArea,
  label: string,
  description: string,
  negativeLabel: string,
  positiveLabel: string,
): Live2DParameterSemantics => ({
  area,
  areaLabel: AREA_LABELS[area],
  label,
  description,
  negativeLabel,
  positiveLabel,
});

/**
 * Converts common Cubism/VTube Studio parameter IDs into editing language.
 * Unknown model-specific IDs stay editable and are clearly marked as such.
 */
export const describeLive2DParameter = (parameterId: string): Live2DParameterSemantics => {
  const id = parameterId.trim();
  const side = sideLabel(id);

  if (/ParamEye[LR]Open/i.test(id)) {
    return result('eyes', `${side}眼开合`, `控制${side || '双'}眼眼皮的张合程度。`, '闭合', '睁开');
  }
  if (/ParamEye[LR]Smile/i.test(id)) {
    return result('eyes', `${side}眼笑意`, `控制${side || '双'}眼笑眼或眯眼的程度。`, '放松', '笑眼');
  }
  if (/ParamEyeBallX/i.test(id)) {
    return result('eyes', '视线左右', '控制眼球横向注视方向。', '看左', '看右');
  }
  if (/ParamEyeBallY/i.test(id)) {
    return result('eyes', '视线上下', '控制眼球纵向注视方向。', '看下', '看上');
  }
  if (/ParamBrow[LR]Y/i.test(id)) {
    return result('brows', `${side}眉高度`, `控制${side || '双'}侧眉毛的高低。`, '压低', '抬高');
  }
  if (/ParamBrow[LR]Angle/i.test(id)) {
    return result('brows', `${side}眉倾斜`, `控制${side || '双'}侧眉毛的倾斜方向。`, '向下倾', '向上倾');
  }
  if (/ParamBrow[LR]Form/i.test(id)) {
    return result('brows', `${side}眉形`, '模型作者定义的眉形变化；请直接观察上方模型。', '形状 −', '形状 +');
  }
  if (/ParamMouthOpenY/i.test(id)) {
    return result('mouth', '嘴巴开合', '控制嘴巴从闭合到张开的程度。', '闭嘴', '张嘴');
  }
  if (/ParamMouthForm/i.test(id)) {
    return result('mouth', '嘴型', '控制嘴角与嘴型，标准模型通常由嘟嘴过渡到微笑。', '嘟嘴', '微笑');
  }
  if (/ParamCheek/i.test(id)) {
    return result('face', '脸颊效果', '通常控制脸红、腮红或脸颊膨胀，具体以模型预览为准。', '关闭', '增强');
  }
  if (/ParamAngleX/i.test(id)) {
    return result('head', '头部左右转', '控制头部横向转动。', '转左', '转右');
  }
  if (/ParamAngleY/i.test(id)) {
    return result('head', '头部抬低', '控制头部向下或向上转动。', '低头', '抬头');
  }
  if (/ParamAngleZ/i.test(id)) {
    return result('head', '头部倾斜', '控制头部向两侧倾斜。', '左倾', '右倾');
  }
  if (/ParamBodyAngleX/i.test(id)) {
    return result('body', '身体左右转', '控制上半身横向转动。', '转左', '转右');
  }
  if (/ParamBodyAngleY/i.test(id)) {
    return result('body', '身体前后倾', '控制上半身前倾或后仰；方向可能由模型作者反转。', '方向 −', '方向 +');
  }
  if (/ParamBodyAngleZ/i.test(id)) {
    return result('body', '身体侧倾', '控制上半身向两侧倾斜。', '左倾', '右倾');
  }
  if (/ParamArm/i.test(id)) {
    return result('arms', `${side}臂动作`, `控制${side || '对应'}手臂的模型专属动作。`, '方向 −', '方向 +');
  }
  if (/ParamBreath/i.test(id)) {
    return result('body', '呼吸', '控制模型的呼吸循环幅度。', '呼出', '吸入');
  }
  if (/Hair|Ribbon|Accessory|Physics/i.test(id)) {
    return result('hair', '头发 / 配件', '模型专属的头发、飘带或物理辅助参数。', '方向 −', '方向 +');
  }
  if (/Opacity|Alpha|Display|Effect/i.test(id)) {
    return result('effects', '显示效果', '控制模型专属部件的透明度或视觉效果。', '减弱', '增强');
  }
  if (/^(?:x|y|z)inb?$/i.test(id)) {
    const axis = id[0]?.toUpperCase() || '';
    const body = /b$/i.test(id);
    return result(
      'tracking',
      `${body ? '身体' : '头部'}追踪 ${axis}`,
      'VTube Studio 风格的追踪输入，通常会通过模型物理联动多个部位。',
      '输入 −',
      '输入 +',
    );
  }

  return result(
    'other',
    id || '未命名参数',
    '这是模型作者自定义的参数，含义无法从名称可靠判断；拖动时请直接观察上方模型。',
    '最小值',
    '最大值',
  );
};

export const groupLive2DParameters = <T extends { id: string }>(
  parameters: T[],
): Array<{ area: Live2DParameterArea; label: string; parameters: T[] }> => {
  const groups = new Map<Live2DParameterArea, T[]>();
  parameters.forEach(parameter => {
    const area = describeLive2DParameter(parameter.id).area;
    groups.set(area, [...(groups.get(area) || []), parameter]);
  });
  return Array.from(groups.entries()).map(([area, items]) => ({
    area,
    label: AREA_LABELS[area],
    parameters: items,
  }));
};

export const live2DParameterPosition = (
  value: number,
  min: number,
  max: number,
): number => {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 50;
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
};
