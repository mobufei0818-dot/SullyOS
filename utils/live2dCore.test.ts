import { describe, expect, it, vi } from 'vitest';
import { bridgeCubism6RenderOrders, enableCubism5HighPrecisionMasks } from './live2dCore';

const createModel = (
  drawables: { count: number; renderOrders?: Int32Array },
  renderOrders: Int32Array,
  offscreenCount = 0,
) => ({
  internalModel: {
    coreModel: {
      _model: {
        drawables,
        offscreens: { count: offscreenCount },
        getRenderOrders: () => renderOrders,
      },
    },
  },
});

describe('bridgeCubism6RenderOrders', () => {
  it('maps Core 6 model render orders onto the legacy drawable field', () => {
    const drawables: { count: number; renderOrders?: Int32Array } = { count: 3 };
    const renderOrders = new Int32Array([2, 0, 1]);

    const result = bridgeCubism6RenderOrders(createModel(drawables, renderOrders));

    expect(result).toEqual({ offscreenCount: 0 });
    expect(drawables.renderOrders).toEqual(renderOrders);
  });

  it('leaves pre-5.3 drawable render orders untouched', () => {
    const existing = new Int32Array([0, 1]);
    const drawables = { count: 2, renderOrders: existing };
    const model = createModel(drawables, new Int32Array([1, 0]));

    bridgeCubism6RenderOrders(model);

    expect(drawables.renderOrders).toBe(existing);
  });

  it('rejects Core 6 offscreen models instead of rendering them incorrectly', () => {
    const drawables: { count: number; renderOrders?: Int32Array } = { count: 2 };
    const model = createModel(drawables, new Int32Array([0, 2, 1]), 1);

    expect(() => bridgeCubism6RenderOrders(model)).toThrow(
      'This Cubism 5.3 model uses 1 offscreen object(s)',
    );
    expect(drawables.renderOrders).toBeUndefined();
  });
});

describe('enableCubism5HighPrecisionMasks', () => {
  const createMaskModel = (mocVersion: number, initiallyEnabled = false) => {
    let enabled = initiallyEnabled;
    const useHighPrecisionMask = vi.fn((value: boolean) => { enabled = value; });
    return {
      model: {
        internalModel: {
          coreModel: { __moc: { getMocVersion: () => mocVersion } },
          renderer: {
            isUsingHighPrecisionMask: () => enabled,
            useHighPrecisionMask,
          },
        },
      },
      useHighPrecisionMask,
    };
  };

  it.each([5, 6])('forces per-drawable masks for moc3 version %i', mocVersion => {
    const { model, useHighPrecisionMask } = createMaskModel(mocVersion);

    expect(enableCubism5HighPrecisionMasks(model)).toEqual({
      highPrecisionMaskEnabled: true,
      mocVersion,
    });
    expect(useHighPrecisionMask).toHaveBeenCalledWith(true);
  });

  it('keeps the adapter policy for pre-Cubism-5 models', () => {
    const { model, useHighPrecisionMask } = createMaskModel(4);

    expect(enableCubism5HighPrecisionMasks(model)).toEqual({
      highPrecisionMaskEnabled: false,
      mocVersion: 4,
    });
    expect(useHighPrecisionMask).not.toHaveBeenCalled();
  });

  it('safely keeps the adapter policy when the moc version is unavailable', () => {
    expect(enableCubism5HighPrecisionMasks({})).toEqual({
      highPrecisionMaskEnabled: false,
      mocVersion: null,
    });
  });

  it('does not report compatibility as enabled when the renderer hook is unavailable', () => {
    expect(enableCubism5HighPrecisionMasks({
      internalModel: { coreModel: { __moc: { getMocVersion: () => 6 } } },
    })).toEqual({
      highPrecisionMaskEnabled: false,
      mocVersion: 6,
    });
  });
});
