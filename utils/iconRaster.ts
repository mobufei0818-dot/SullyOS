// 图标栅格化：把任意图片源渲染成固定边长的正方形 PNG data URL。
//
// 为什么必须转 PNG：iOS 的 apple-touch-icon 只稳定支持 PNG。上传管线
// （utils/file.ts 的 processImageToBlob）默认吐 JPEG，图床拉下来的还可能是 WebP，
// 直接拿去当图标 iOS 会静默忽略、继续用旧图标。
//
// 为什么必须定尺寸：apple-touch-icon 标准边长 180；源图 512 转出来的 data URI
// 动辄几百 KB，塞进 <link href> 又慢又容易踩到实现上限。

/** 等比缩放并居中裁切（cover），铺满整个正方形——图标不该留白边。 */
function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, size: number): void {
  const scale = Math.max(size / img.width, size / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
}

/**
 * 把图片源渲染成 `size × size` 的 PNG data URL。
 *
 * 远程 URL 会污染 canvas 导致 toDataURL 抛 SecurityError，所以调用方应先 fetch 成
 * Blob 再传进来（AppIconEditor 的「填入链接」就是这么做的）。
 */
export function toSquarePngDataUrl(src: Blob | string, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = src instanceof Blob ? URL.createObjectURL(src) : null;
    const href = objectUrl ?? (src as string);

    const cleanup = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };

    const img = new Image();
    // 远程图需要 CORS 头才能不污染画布；图床一般都给。拿不到就走 onerror。
    if (!objectUrl) img.crossOrigin = 'anonymous';

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas context 拿不到');

        ctx.clearRect(0, 0, size, size);
        drawCover(ctx, img, size);

        // 固定 PNG：iOS apple-touch-icon 只稳定认这个格式
        resolve(canvas.toDataURL('image/png'));
      } catch (e) {
        reject(e);
      } finally {
        cleanup();
      }
    };
    img.onerror = () => {
      cleanup();
      reject(new Error('图片加载失败'));
    };

    img.src = href;
  });
}
