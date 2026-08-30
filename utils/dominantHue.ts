// ─── 主色相提取 ──────────────────────────────────────────────
// 从 TamagotchiHome「提取小窝主色」抽出的公共实现：
// 电子宠物小窝与触感陪伴桌面都用它做「界面颜色跟角色走」。

export const rgbToHsl = (r: number, g: number, b: number): [number, number, number] => {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
};

export const normalizeHue = (hue: number): number => ((hue % 360) + 360) % 360;

/**
 * Convert a theme color to #rrggbb. Companion surfaces append 8-digit hex
 * alpha values (for example `${color}33`), so hsl(...) cannot be returned.
 */
export const hslToHex = (hue: number, saturation: number, lightness: number): string => {
    const h = normalizeHue(hue);
    const s = Math.min(100, Math.max(0, saturation)) / 100;
    const l = Math.min(100, Math.max(0, lightness)) / 100;
    const chroma = (1 - Math.abs(2 * l - 1)) * s;
    const section = h / 60;
    const x = chroma * (1 - Math.abs((section % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (section < 1) [r, g] = [chroma, x];
    else if (section < 2) [r, g] = [x, chroma];
    else if (section < 3) [g, b] = [chroma, x];
    else if (section < 4) [g, b] = [x, chroma];
    else if (section < 5) [r, b] = [x, chroma];
    else [r, b] = [chroma, x];
    const match = l - chroma / 2;
    const channel = (value: number) => Math.round((value + match) * 255).toString(16).padStart(2, '0');
    return `#${channel(r)}${channel(g)}${channel(b)}`;
};

// 色相直方图（15° 一桶，饱和度×中亮度加权），忽略近灰/近黑白的像素
export const dominantHueOfPixels = (data: Uint8ClampedArray): number | null => {
    const BINS = 24;
    const weight = new Array(BINS).fill(0);
    const hueSum = new Array(BINS).fill(0);
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue; // 透明像素
        const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
        if (s < 0.14 || l < 0.1 || l > 0.92) continue;
        const w = s * (1 - Math.abs(l - 0.55));
        const bin = Math.floor(h / (360 / BINS)) % BINS;
        weight[bin] += w;
        hueSum[bin] += h * w;
    }
    let best = 0;
    for (let i = 1; i < BINS; i++) if (weight[i] > weight[best]) best = i;
    if (weight[best] <= 0) return null;
    return hueSum[best] / weight[best];
};

// 图片 url → 主色相（24×24 缩略采样；跨域画布被污染时返回 null，交给下一个候选）
export const hueFromImage = (url: string): Promise<number | null> => new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        try {
            const cv = document.createElement('canvas');
            cv.width = 24; cv.height = 24;
            const ctx = cv.getContext('2d');
            if (!ctx) return resolve(null);
            ctx.drawImage(img, 0, 0, 24, 24);
            resolve(dominantHueOfPixels(ctx.getImageData(0, 0, 24, 24).data));
        } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
});

// CSS 渐变串 → 主色相（抓 #hex 色值取饱和度加权平均）
export const hueFromGradient = (s: string): number | null => {
    const hexes = s.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g);
    if (!hexes || hexes.length === 0) return null;
    let wSum = 0, hSum = 0;
    for (const hex of hexes) {
        const full = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
        const r = parseInt(full.slice(1, 3), 16), g = parseInt(full.slice(3, 5), 16), b = parseInt(full.slice(5, 7), 16);
        const [h, sat, l] = rgbToHsl(r, g, b);
        if (sat < 0.1 || l < 0.08 || l > 0.95) continue;
        const w = sat * (1 - Math.abs(l - 0.55));
        wSum += w; hSum += h * w;
    }
    return wSum > 0 ? hSum / wSum : null;
};
