import React from 'react';
import { HandTap, TShirt } from '@phosphor-icons/react';
import { Icons } from '../../constants';
import { AppID, type CharacterProfile, type ScheduleSlot } from '../../types';
import './MagazineCompanionChrome.css';

type MagazineCompanionChromeProps = {
  character: CharacterProfile;
  currentScheduleSlot: ScheduleSlot | null;
  openApp: (id: AppID) => void;
  openCharacterSchedule: () => void;
  openWardrobe: () => void;
  openTouchSettings: () => void;
  openAllApps: () => void;
};

const MagazineCompanionChrome: React.FC<MagazineCompanionChromeProps> = ({
  character,
  currentScheduleSlot,
  openApp,
  openCharacterSchedule,
  openWardrobe,
  openTouchSettings,
  openAllApps,
}) => {
  const now = new Date();
  const dateLabel = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
  const masthead = character.name.toUpperCase();
  return (
    <div className="companion-magazine-chrome pointer-events-none absolute inset-0 z-30" data-testid="companion-magazine-chrome">
      <header className="mag-cover-header">
        <div className="mag-cover-meta"><span>VISUAL CHARACTER JOURNAL</span><strong>ISSUE 08</strong><em>{dateLabel}</em></div>
        <button type="button" className="mag-cover-masthead pointer-events-auto" onClick={() => openApp(AppID.Character)}>{masthead}</button>
        <p>THE PRIVATE HOURS OF {masthead}</p>
      </header>

      <div className="mag-cover-vertical" aria-hidden><span>きみと過ごす時間の記録</span><small>CHARACTER / VISUAL BOOK</small></div>
      <div className="mag-cover-cross mag-cover-cross--one" aria-hidden /><div className="mag-cover-cross mag-cover-cross--two" aria-hidden />

      <section className="mag-cover-tools pointer-events-auto" aria-label="封面工具">
        <button type="button" onClick={() => openApp(AppID.Appearance)}><span>01</span><Icons.Appearance /><strong>外观</strong><small>APPEARANCE</small></button>
        <button type="button" onClick={openTouchSettings}><span>02</span><HandTap weight="bold" /><strong>触摸</strong><small>TOUCH</small></button>
        <button type="button" onClick={openWardrobe} data-testid="companion-magazine-wardrobe-button" data-companion-wardrobe-trigger="true"><span>03</span><TShirt weight="bold" /><strong>衣橱</strong><small>WARDROBE</small></button>
      </section>

      <button type="button" className="mag-cover-feature pointer-events-auto" onClick={openCharacterSchedule}>
        <span>COVER STORY</span>
        <strong>{currentScheduleSlot?.activity || '今天的未定事件'}</strong>
        <small>{currentScheduleSlot ? `${currentScheduleSlot.startTime}${currentScheduleSlot.location ? ` / ${currentScheduleSlot.location}` : ''}` : 'OPEN DAILY SCHEDULE'}</small>
      </button>

      <aside className="mag-cover-caption" aria-hidden>
        <span>NO. 008</span>
        <strong>PERSONA<br />IN MOTION</strong>
        <p>Fragments, gestures and the shape of an ordinary day.</p>
      </aside>

      <div className="mag-cover-code" aria-hidden><i /><span>978-4-08-081526-6</span></div>
      <div className="mag-cover-qr" aria-hidden>{Array.from({ length: 16 }, (_, index) => <i key={index} />)}</div>

      <nav className="mag-cover-nav pointer-events-auto" aria-label="夜刊封面导航">
        <button type="button" onClick={() => openApp(AppID.Chat)}><Icons.Chat /><span>对话</span></button>
        <button type="button" onClick={() => openApp(AppID.Date)}><Icons.Date /><span>见面</span></button>
        <button type="button" onClick={() => openApp(AppID.SpecialMoments)}><Icons.SpecialMoments /><span>时光</span></button>
        <button type="button" onClick={openAllApps}><Icons.Settings /><span>目录</span></button>
      </nav>
    </div>
  );
};

export default MagazineCompanionChrome;
