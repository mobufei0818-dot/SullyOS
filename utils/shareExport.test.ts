import { afterEach, describe, expect, it, vi } from 'vitest';
import { shareOrDownloadBlob } from './shareExport';

const originalShare = Object.getOwnPropertyDescriptor(navigator, 'share');
const originalCanShare = Object.getOwnPropertyDescriptor(navigator, 'canShare');

afterEach(() => {
  if (originalShare) Object.defineProperty(navigator, 'share', originalShare);
  else Reflect.deleteProperty(navigator, 'share');
  if (originalCanShare) Object.defineProperty(navigator, 'canShare', originalCanShare);
  else Reflect.deleteProperty(navigator, 'canShare');
});

describe('shareOrDownloadBlob web file sharing', () => {
  it('hands the real file to Web Share before considering a browser download', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: canShare });

    const result = await shareOrDownloadBlob({
      blob: new Blob(['real file'], { type: 'application/pdf' }),
      fileName: '协同交付.pdf',
      shareTitle: '协同交付',
    });

    expect(result).toBe('shared');
    expect(canShare).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledTimes(1);
    const payload = share.mock.calls[0][0] as ShareData;
    expect(payload.title).toBe('协同交付');
    expect(payload.files?.[0]?.name).toBe('协同交付.pdf');
    expect(payload.files?.[0]?.size).toBe(9);
  });
});
