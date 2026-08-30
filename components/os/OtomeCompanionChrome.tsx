import React from 'react';
import { HandTap, TShirt } from '@phosphor-icons/react';
import { Icons } from '../../constants';
import { AppID, type CharacterProfile, type ScheduleSlot } from '../../types';
import './OtomeCompanionChrome.css';

type OtomeCompanionChromeProps = {
  character: CharacterProfile;
  currentScheduleSlot: ScheduleSlot | null;
  dayProgress: number;
  openApp: (id: AppID) => void;
  openCharacterSchedule: () => void;
  openWardrobe: () => void;
  openTouchSettings: () => void;
  openAllApps: () => void;
  onHome: () => void;
};

const OtomeCompanionChrome: React.FC<OtomeCompanionChromeProps> = ({
  character,
  currentScheduleSlot,
  dayProgress,
  openApp,
  openCharacterSchedule,
  openWardrobe,
  openTouchSettings,
  openAllApps,
  onHome,
}) => {
  const dateLabel = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' })
    .format(new Date())
    .replace('/', '.');
  const rightBookmarks = [
    { key: AppID.CheckPhone, label: '心声', eyebrow: 'NOTE', Icon: Icons.CheckPhone, action: () => openApp(AppID.CheckPhone) },
    { key: 'wardrobe', label: '衣橱', eyebrow: 'LOOK', Icon: TShirt, action: openWardrobe, testId: 'companion-otome-wardrobe-button' },
    { key: AppID.Date, label: '见面', eyebrow: 'MEET', Icon: Icons.Date, action: () => openApp(AppID.Date), testId: 'companion-otome-date-button' },
    { key: AppID.Call, label: '通话', eyebrow: 'CALL', Icon: Icons.Call, action: () => openApp(AppID.Call) },
  ];
  const bottomActions = [
    { key: 'home', label: '主页', Icon: Icons.Room, action: onHome, active: true },
    { key: AppID.Chat, label: '对话', Icon: Icons.Chat, action: () => openApp(AppID.Chat) },
    { key: AppID.Date, label: '篇章', Icon: Icons.Date, action: () => openApp(AppID.Date) },
    { key: AppID.SpecialMoments, label: '时光', Icon: Icons.SpecialMoments, action: () => openApp(AppID.SpecialMoments) },
  ];

  return (
    <div className="companion-otome-chrome pointer-events-none absolute inset-0 z-30" data-testid="companion-otome-chrome">
      <header className="otome-daybook-header pointer-events-auto">
        <button type="button" className="otome-daybook-title" onClick={() => openApp(AppID.Character)}>
          <span>DAYBOOK · {dateLabel}</span>
          <strong>{character.name}</strong>
          <small className="otome-day-progress">
            <span>今天的事件</span>
            <i aria-hidden><b style={{ width: `${dayProgress}%` }} /></i>
            <em>{dayProgress}%</em>
          </small>
        </button>
        <button type="button" className="otome-keepsake-balance" onClick={() => openApp(AppID.Bank)} aria-label="打开账户">
          <span>花笺</span><strong>12,860</strong><i aria-hidden />
        </button>
      </header>

      <button type="button" className="otome-season-letter pointer-events-auto" onClick={() => openApp(AppID.VRWorld)}>
        <span className="otome-letter-seal" aria-hidden><Icons.SpecialMoments /></span>
        <span className="otome-letter-copy">
          <small>SEASON LETTER</small>
          <strong>晴庭来信</strong>
          <em>一段新的回忆已寄达</em>
        </span>
      </button>

      <div className="otome-stage-toolbar pointer-events-auto" aria-label="桌面工具">
        <button type="button" onClick={() => openApp(AppID.Appearance)}><Icons.Appearance /><span>外观</span></button>
        <i aria-hidden />
        <button type="button" onClick={openTouchSettings} className="relative">
          <HandTap weight="bold" /><span>触摸</span>
        </button>
      </div>

      <aside className="otome-bookmark-rail pointer-events-auto" aria-label="晴庭快捷书签">
        {rightBookmarks.map(({ key, label, eyebrow, Icon, action, testId }, index) => (
          <button key={key} type="button" onClick={action} data-testid={testId} data-companion-wardrobe-trigger={key === 'wardrobe' ? 'true' : undefined}>
            <span className="otome-bookmark-index">0{index + 1}</span>
            <Icon />
            <span className="otome-bookmark-copy"><small>{eyebrow}</small><strong>{label}</strong></span>
          </button>
        ))}
      </aside>

      <button type="button" className="otome-episode-ribbon pointer-events-auto" onClick={openCharacterSchedule} data-testid="companion-otome-current-trip">
        <span>CURRENT ROUTE</span>
        <strong>当前行程 · {currentScheduleSlot?.activity || '尚未安排'}</strong>
        <small>{currentScheduleSlot ? `${currentScheduleSlot.startTime}${currentScheduleSlot.location ? ` · ${currentScheduleSlot.location}` : ''}` : '打开角色日程'}</small>
        <Icons.Journal />
      </button>

      <nav className="otome-book-dock pointer-events-auto" aria-label="晴庭手帐导航">
        <div className="otome-book-dock-items">
          {bottomActions.map(({ key, label, Icon, action, active }) => (
            <button key={key} type="button" onClick={action} className={active ? 'is-active' : ''} aria-current={active ? 'page' : undefined}>
              <Icon /><span>{label}</span>
            </button>
          ))}
        </div>
        <button type="button" className="otome-menu-pearl" onClick={openAllApps} aria-label="打开全部功能">
          <Icons.Settings />
          <span>菜单</span>
        </button>
      </nav>
    </div>
  );
};

export default OtomeCompanionChrome;
