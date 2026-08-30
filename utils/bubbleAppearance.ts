import type { BubbleStyle } from '../types';

export interface BubbleCornerRadii {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

const finiteRadius = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : fallback;
};

/** Resolve four-corner values while keeping every pre-existing theme compatible. */
export const resolveBubbleCornerRadii = (
  style: Pick<BubbleStyle,
    'borderRadius' | 'borderTopLeftRadius' | 'borderTopRightRadius' |
    'borderBottomRightRadius' | 'borderBottomLeftRadius'>,
): BubbleCornerRadii => {
  const base = finiteRadius(style.borderRadius, 20);
  return {
    topLeft: finiteRadius(style.borderTopLeftRadius, base),
    topRight: finiteRadius(style.borderTopRightRadius, base),
    bottomRight: finiteRadius(style.borderBottomRightRadius, base),
    bottomLeft: finiteRadius(style.borderBottomLeftRadius, base),
  };
};

/**
 * Existing themes had no tail setting, so undefined intentionally keeps the old
 * "every bubble" behaviour. Newly-created themes explicitly opt into `last`.
 */
export const shouldHideBubbleTail = (
  mode: BubbleStyle['tailMode'],
  isLastInGroup: boolean,
): boolean => mode === 'none' || (mode === 'last' && !isLastInGroup);
