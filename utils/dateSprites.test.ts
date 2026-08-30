import { describe, it, expect } from 'vitest';
import { pickDateFallbackSprite } from './dateSprites';

const KEYS = ['normal', 'happy', 'angry', 'sad', 'shy'];
const AVATAR = 'blobref:b_avatar';

describe('pickDateFallbackSprite', () => {
    it('优先 normal / default', () => {
        expect(pickDateFallbackSprite({ normal: 'data:n', happy: 'data:h' }, KEYS, AVATAR)).toBe('data:n');
        expect(pickDateFallbackSprite({ default: 'data:d' }, KEYS, AVATAR)).toBe('data:d');
    });

    it('无 normal 时按见面情绪键兜底', () => {
        expect(pickDateFallbackSprite({ shy: 'data:s' }, KEYS, AVATAR)).toBe('data:s');
        expect(pickDateFallbackSprite({ excited: 'data:e' }, [...KEYS, 'excited'], AVATAR)).toBe('data:e');
    });

    // ↓ 三条钉住：立绘存的是 blobref 令牌时照选不误，不会被跳过、也不会退回头像。
    //   渲染方（TokenImg / useBlobRefUrl）认令牌，这里只管挑值。
    it('normal 是令牌 → 直接选它', () => {
        expect(pickDateFallbackSprite({ normal: 'blobref:b_normal' }, KEYS, AVATAR)).toBe('blobref:b_normal');
    });

    it('见面情绪键是令牌 → 直接选它', () => {
        expect(pickDateFallbackSprite({ shy: 'blobref:b_shy' }, KEYS, AVATAR)).toBe('blobref:b_shy');
    });

    it('杂项键是令牌 → 直接选它，不回落头像', () => {
        expect(pickDateFallbackSprite({ legacy_pose: 'blobref:b_xyz' }, KEYS, AVATAR)).toBe('blobref:b_xyz');
    });

    // ↓ 兜底顺序本身不变：chibi 永远不当见面立绘用，值是什么格式都一样。
    it('只有 chibi（令牌）时回落到头像', () => {
        expect(pickDateFallbackSprite({ chibi: 'blobref:b_chibi' }, KEYS, AVATAR)).toBe(AVATAR);
    });

    it('chibi 即使是 dataURL 也不当见面立绘用', () => {
        expect(pickDateFallbackSprite({ chibi: 'data:image/png;base64,CHIBI' }, KEYS, AVATAR)).toBe(AVATAR);
    });

    it('chibi 与杂项键并存时选杂项键，跳过 chibi', () => {
        expect(pickDateFallbackSprite({ chibi: 'blobref:b_chibi', legacy_pose: 'data:p' }, KEYS, AVATAR)).toBe('data:p');
    });

    it('情绪键优先于杂项键', () => {
        expect(pickDateFallbackSprite({ legacy_pose: 'data:p', happy: 'data:h' }, KEYS, AVATAR)).toBe('data:h');
    });

    it('非 chibi 的杂项键、可直接渲染的值仍可兜底', () => {
        expect(pickDateFallbackSprite({ legacy_pose: 'https://img.example/a.png' }, KEYS, AVATAR)).toBe('https://img.example/a.png');
    });

    it('空 sprites / undefined → 头像；连头像都没有 → undefined', () => {
        expect(pickDateFallbackSprite({}, KEYS, AVATAR)).toBe(AVATAR);
        expect(pickDateFallbackSprite(undefined, KEYS, AVATAR)).toBe(AVATAR);
        expect(pickDateFallbackSprite(undefined, KEYS, undefined)).toBeUndefined();
    });
});
