import React from 'react';
import {
  Broadcast,
  Cat,
  ChatCircleDots,
  Diamond,
  LockSimple,
  PawPrint,
  Sparkle,
  TerminalWindow,
} from '@phosphor-icons/react';
import type { CharacterProfile } from '../../types';
import type { CompanionFrameStyleId } from './companionFrameStyles';
import './CompanionLockChrome.css';

type CompanionLockChromeProps = {
  variant: CompanionFrameStyleId;
  hours: number;
  minutes: number;
  activeCharacter?: CharacterProfile | null;
  unreadCharacter?: CharacterProfile | null;
  unreadCount: number;
  preserveWallpaper?: boolean;
};

const LOCK_COPY: Record<CompanionFrameStyleId, { eyebrow: string; line: string; unlock: string }> = {
  tech: { eyebrow: 'ORBITAL COMPANION OS', line: '终端保持在线', unlock: '接入终端' },
  otome: { eyebrow: 'DAYBOOK · LOCK', line: '晴庭仍为你留着灯', unlock: '轻触进入' },
  cat: { eyebrow: 'NIGHT COMPANION', line: '正在夜巡', unlock: '跟上脚步' },
  magazine: { eyebrow: 'PRIVATE HOURS · LOCK ISSUE', line: '今日封面仍在继续', unlock: '翻开本期' },
  archive: { eyebrow: 'LUMINA CARD ARCHIVE', line: '星愿卡册等待开启', unlock: '解除封印' },
  idol: { eyebrow: '', line: '', unlock: '轻触解锁' },
};

const CompanionLockChrome: React.FC<CompanionLockChromeProps> = ({
  variant,
  hours,
  minutes,
  activeCharacter,
  unreadCharacter,
  unreadCount,
  preserveWallpaper = false,
}) => {
  const date = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());
  const numericDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date())
    .replaceAll('/', '.');
  const time = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  const characterName = activeCharacter?.name || 'Sully';
  const copy = LOCK_COPY[variant];

  return (
    <div
      className={`companion-themed-lock companion-themed-lock--${variant}`}
      style={{ '--lock-theme-opacity': preserveWallpaper ? 0.58 : 1 } as React.CSSProperties}
      data-testid={`companion-${variant}-lockscreen`}
    >
      <div className="companion-lock-wallpaper" aria-hidden><i /><i /><i /><i /></div>

      {variant === 'otome' && (
        <>
          <header className="companion-lock-daybook"><span>{copy.eyebrow}</span><strong>{characterName}</strong><small>{date}</small></header>
          <div className="companion-lock-time companion-lock-time--otome"><strong>{time}</strong><span>{copy.line}</span></div>
        </>
      )}

      {variant === 'cat' && (
        <>
          <header className="companion-lock-cat-mark"><Cat weight="fill" /><span>{copy.eyebrow}</span></header>
          <div className="companion-lock-time companion-lock-time--cat"><span className="companion-lock-cat-ears" aria-hidden /><strong>{time}</strong><span>{date} · {characterName} {copy.line}</span></div>
        </>
      )}

      {variant === 'tech' && (
        <>
          <header className="companion-lock-tech-head"><TerminalWindow weight="duotone" /><span>{copy.eyebrow}</span><i>SYS / 08</i></header>
          <div className="companion-lock-time companion-lock-time--tech"><small>{numericDate}</small><strong>{time}</strong><span>{characterName} · {copy.line}</span></div>
          <div className="companion-lock-tech-readout" aria-hidden><span>LINK</span><i /><strong>STABLE</strong><em>09 / AXIS</em></div>
        </>
      )}

      {variant === 'magazine' && (
        <>
          <header className="companion-lock-mag-head"><span>{copy.eyebrow}</span><strong>08</strong><small>{numericDate}</small></header>
          <div className="companion-lock-mag-name">{characterName}</div>
          <div className="companion-lock-time companion-lock-time--magazine"><strong>{time}</strong><span>{copy.line}</span></div>
          <div className="companion-lock-mag-caption" aria-hidden><span>PERSONA<br />IN MOTION</span><small>VISUAL CHARACTER JOURNAL</small></div>
        </>
      )}

      {variant === 'archive' && (
        <>
          <header className="companion-lock-archive-head"><span>{copy.eyebrow}</span><i /><small>COLLECTOR · {numericDate}</small></header>
          <div className="companion-lock-archive-seal" aria-hidden><Diamond weight="duotone" /><span>CARD</span><strong>08</strong></div>
          <div className="companion-lock-time companion-lock-time--archive"><small>{characterName} · STAR WISH</small><strong>{time}</strong><span>{copy.line}</span></div>
        </>
      )}

      {variant === 'idol' && (
        <div className="companion-lock-time companion-lock-time--idol"><strong>{time}</strong><span>{date}</span></div>
      )}

      {unreadCount > 0 && (
        <section className="companion-lock-notice">
          <span className="companion-lock-notice-icon">
            {variant === 'cat' ? <PawPrint weight="fill" /> : variant === 'idol' ? <Broadcast weight="fill" /> : variant === 'archive' ? <Sparkle weight="fill" /> : <ChatCircleDots weight="fill" />}
          </span>
          <span><strong>{unreadCharacter?.name || 'Message'}</strong><small>{unreadCount > 1 ? `${unreadCount} 条新消息` : '发来了一条新消息'}</small></span>
          <em>刚刚</em>
        </section>
      )}

      <div className="companion-lock-unlock">
        <LockSimple weight="bold" /><span>{copy.unlock}</span><i aria-hidden />
      </div>
    </div>
  );
};

export default CompanionLockChrome;
