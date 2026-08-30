import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../types';
import {
  companionExpressionKey,
  getCompanionDateSprites,
  listCompanionDateOutfits,
  resolveCompanionPortrait,
} from './companionAvatar';

const character = {
  id: 'char-1',
  name: 'Sully',
  avatar: 'avatar.png',
  sprites: { normal: 'base-normal.png', happy: 'base-happy.png', chibi: 'chibi.png' },
  dateSkinSets: [
    { id: 'coat', name: '风衣', sprites: { normal: 'coat-normal.png', shy: 'coat-shy.png' } },
  ],
  companionAvatar: { version: 1, source: 'date', skinSetId: 'coat' },
} as unknown as CharacterProfile;

describe('静态陪伴形象', () => {
  it('把桌面演出情绪映射到见面模式的五类表情', () => {
    expect(companionExpressionKey('happy')).toBe('happy');
    expect(companionExpressionKey('surprised')).toBe('shy');
    expect(companionExpressionKey('calm', ['blush'])).toBe('shy');
    expect(companionExpressionKey('disgusted')).toBe('angry');
  });

  it('为桌面保留独立衣服选择并在缺图时回退到 normal', () => {
    expect(getCompanionDateSprites(character)).toBe(character.dateSkinSets?.[0].sprites);
    expect(resolveCompanionPortrait(character, 'surprised')).toBe('coat-shy.png');
    expect(resolveCompanionPortrait(character, 'happy')).toBe('coat-normal.png');
  });

  it('列出默认立绘和有图片的见面衣橱，并忽略 chibi', () => {
    const outfits = listCompanionDateOutfits(character);
    expect(outfits.map(item => item.name)).toEqual(['默认立绘', '风衣']);
    expect(outfits[0].expressionCount).toBe(2);
    expect(outfits[0].preview).toBe('base-normal.png');
  });

  it('导入单图始终使用原始 PNG/GIF 引用', () => {
    const uploaded = {
      ...character,
      companionAvatar: { version: 1, source: 'upload', imageRef: 'blobref:portrait' },
    } as unknown as CharacterProfile;
    expect(resolveCompanionPortrait(uploaded, 'angry')).toBe('blobref:portrait');
  });
});
