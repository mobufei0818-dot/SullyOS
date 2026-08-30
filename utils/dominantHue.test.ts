import { describe, expect, it } from 'vitest';
import { dominantHueOfPixels, hslToHex, normalizeHue } from './dominantHue';

describe('companion palette colors', () => {
  it('normalizes wrapped hue values', () => {
    expect(normalizeHue(-120)).toBe(240);
    expect(normalizeHue(480)).toBe(120);
  });

  it('returns six-digit hex colors that can safely receive an alpha suffix', () => {
    expect(hslToHex(0, 100, 50)).toBe('#ff0000');
    expect(hslToHex(120, 100, 50)).toBe('#00ff00');
    expect(hslToHex(240, 100, 50)).toBe('#0000ff');
    expect(`${hslToHex(267, 56, 70)}33`).toMatch(/^#[0-9a-f]{8}$/);
  });

  it('ignores transparent and gray pixels when choosing a dominant hue', () => {
    const pixels = new Uint8ClampedArray([
      255, 255, 255, 255,
      255, 0, 0, 0,
      0, 80, 255, 255,
      0, 90, 245, 255,
    ]);
    expect(dominantHueOfPixels(pixels)).toBeGreaterThan(210);
    expect(dominantHueOfPixels(pixels)).toBeLessThan(230);
  });
});
