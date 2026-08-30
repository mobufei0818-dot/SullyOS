import React from 'react';
import { Cat, HandTap, PawPrint, TShirt } from '@phosphor-icons/react';
import { Icons } from '../../constants';
import { AppID, type CharacterProfile, type ScheduleSlot } from '../../types';
import './CatCompanionChrome.css';

type CatCompanionChromeProps = {
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

const CatCompanionChrome: React.FC<CatCompanionChromeProps> = ({
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
  const quickActions = [
    { id: AppID.Date, label: '见面', Icon: Icons.Date },
    { id: 'wardrobe', label: '衣橱', Icon: TShirt, action: openWardrobe },
    { id: AppID.Call, label: '通话', Icon: Icons.Call },
  ];
  const dockActions = [
    { key: 'home', label: '归巢', Icon: Icons.Room, action: onHome },
    { key: AppID.Chat, label: '对话', Icon: Icons.Chat, action: () => openApp(AppID.Chat) },
    { key: AppID.SpecialMoments, label: '时光', Icon: Icons.SpecialMoments, action: () => openApp(AppID.SpecialMoments) },
    { key: AppID.Settings, label: '设置', Icon: Icons.Settings, action: () => openApp(AppID.Settings) },
  ];

  return (
    <div className="companion-cat-chrome pointer-events-none absolute inset-0 z-30" data-testid="companion-cat-chrome">
      <header className="cat-night-header pointer-events-auto">
        <button type="button" className="cat-identity" onClick={() => openApp(AppID.Character)}>
          <span className="cat-identity-mark" aria-hidden><Cat weight="fill" /></span>
          <span className="cat-identity-copy"><small>NIGHT COMPANION</small><strong>{character.name}</strong></span>
        </button>
        <div className="cat-event-flow" aria-label={`今天事件已流逝 ${dayProgress}%`}>
          <span><b>今天的事件</b><em>{dayProgress}%</em></span>
          <i aria-hidden><b style={{ width: `${dayProgress}%` }} /></i>
        </div>
      </header>

      <div className="cat-ear-tools pointer-events-auto" aria-label="舞台工具">
        <button type="button" onClick={() => openApp(AppID.Appearance)}><Icons.Appearance /><span>外观</span></button>
        <button type="button" onClick={openTouchSettings}><HandTap weight="bold" /><span>触摸</span></button>
      </div>

      <aside className="cat-paw-rail pointer-events-auto" aria-label="夜巡快捷入口">
        {quickActions.map(({ id, label, Icon, action }, index) => (
          <button key={id} type="button" onClick={action || (() => openApp(id as AppID))} data-companion-wardrobe-trigger={id === 'wardrobe' ? 'true' : undefined}>
            <span className="cat-paw-number">0{index + 1}</span>
            <Icon />
            <strong>{label}</strong>
          </button>
        ))}
      </aside>

      <button type="button" className="cat-current-route pointer-events-auto" onClick={openCharacterSchedule} data-testid="companion-cat-current-trip">
        <span className="cat-route-paw" aria-hidden><PawPrint weight="fill" /></span>
        <span className="cat-route-copy">
          <small>CURRENT ROUTE · 当前行程</small>
          <strong>{currentScheduleSlot?.activity || '尚未安排行程'}</strong>
          <em>{currentScheduleSlot ? `${currentScheduleSlot.startTime}${currentScheduleSlot.location ? ` · ${currentScheduleSlot.location}` : ''}` : '查看今天的事件流'}</em>
        </span>
        <span className="cat-route-arrow" aria-hidden>›</span>
      </button>

      <nav className="cat-paw-dock pointer-events-auto" aria-label="夜巡小猫导航">
        <div className="cat-dock-side cat-dock-side--left">
          {dockActions.slice(0, 2).map(({ key, label, Icon, action }) => (
            <button key={key} type="button" onClick={action}><Icon /><span>{label}</span></button>
          ))}
        </div>
        <button type="button" className="cat-menu-paw" onClick={openAllApps} aria-label="打开全部功能">
          <span aria-hidden><PawPrint weight="fill" /></span>
          <strong>全部</strong>
        </button>
        <div className="cat-dock-side cat-dock-side--right">
          {dockActions.slice(2).map(({ key, label, Icon, action }) => (
            <button key={key} type="button" onClick={action}><Icon /><span>{label}</span></button>
          ))}
        </div>
      </nav>
    </div>
  );
};

export default CatCompanionChrome;
