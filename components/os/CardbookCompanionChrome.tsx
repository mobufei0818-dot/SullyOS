import React from 'react';
import { HandTap, Sparkle, TShirt } from '@phosphor-icons/react';
import { Icons } from '../../constants';
import { AppID, type CharacterProfile, type ScheduleSlot } from '../../types';
import './CardbookCompanionChrome.css';

type CardbookCompanionChromeProps = {
  character: CharacterProfile;
  currentScheduleSlot: ScheduleSlot | null;
  dayProgress: number;
  openApp: (id: AppID) => void;
  openCharacterSchedule: () => void;
  openWardrobe: () => void;
  openTouchSettings: () => void;
  openAllApps: () => void;
};

const CardbookCompanionChrome: React.FC<CardbookCompanionChromeProps> = ({
  character,
  currentScheduleSlot,
  dayProgress,
  openApp,
  openCharacterSchedule,
  openWardrobe,
  openTouchSettings,
  openAllApps,
}) => {
  const date = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' })
    .format(new Date())
    .replace('/', ' · ');
  const tools = [
    { id: 'appearance', label: '外观', en: 'APPEARANCE', Icon: Icons.Appearance, action: () => openApp(AppID.Appearance) },
    { id: 'touch', label: '触摸', en: 'TOUCH', Icon: HandTap, action: openTouchSettings },
    { id: 'wardrobe', label: '衣橱', en: 'WARDROBE', Icon: TShirt, action: openWardrobe, testId: 'companion-cardbook-wardrobe-button' },
  ];
  const nav = [
    { id: AppID.Chat, label: '对话', Icon: Icons.Chat, action: () => openApp(AppID.Chat) },
    { id: AppID.Date, label: '见面', Icon: Icons.Date, action: () => openApp(AppID.Date) },
    { id: 'all', label: '星章', Icon: Sparkle, action: openAllApps, primary: true },
    { id: AppID.SpecialMoments, label: '时光', Icon: Icons.SpecialMoments, action: () => openApp(AppID.SpecialMoments) },
    { id: AppID.Settings, label: '设置', Icon: Icons.Settings, action: () => openApp(AppID.Settings) },
  ];

  return (
    <div className="companion-cardbook-chrome pointer-events-none absolute inset-0 z-30" data-testid="companion-cardbook-chrome">
      <header className="cardbook-header pointer-events-auto">
        <div className="cardbook-series"><span>LUMINA CARD ARCHIVE</span><i /><em>VOL. 08</em></div>
        <button type="button" onClick={() => openApp(AppID.Character)}>
          <small>COLLECTOR · {date}</small>
          <strong>{character.name}</strong>
          <span>星愿收藏册</span>
        </button>
      </header>

      <div className="cardbook-progress" aria-label={`今天的事件已流逝 ${dayProgress}%`}>
        <span>DAY TRACE</span>
        <i><b style={{ width: `${dayProgress}%` }} /></i>
        <strong>{dayProgress}%</strong>
      </div>

      <aside className="cardbook-tools pointer-events-auto" aria-label="收藏册工具">
        {tools.map(({ id, label, en, Icon, action, testId }, index) => (
          <button key={id} type="button" onClick={action} data-testid={testId} data-companion-wardrobe-trigger={id === 'wardrobe' ? 'true' : undefined}>
            <span>0{index + 1}</span>
            <Icon weight="bold" />
            <strong>{label}</strong>
            <small>{en}</small>
          </button>
        ))}
      </aside>

      <div className="cardbook-chapter" aria-hidden>
        <span>CARD</span><strong>08</strong><small>THE LITTLE HOURS</small>
      </div>

      <button type="button" className="cardbook-route pointer-events-auto" onClick={openCharacterSchedule}>
        <span>今日卡面 · CURRENT ROUTE</span>
        <strong>{currentScheduleSlot?.activity || '尚未安排行程'}</strong>
        <small>{currentScheduleSlot ? `${currentScheduleSlot.startTime}${currentScheduleSlot.location ? ` · ${currentScheduleSlot.location}` : ''}` : '翻开角色今天的事件流'}</small>
        <Sparkle weight="fill" />
      </button>

      <nav className="cardbook-dock pointer-events-auto" aria-label="星愿卡册导航">
        {nav.map(({ id, label, Icon, action, primary }) => (
          <button key={id} type="button" onClick={action} className={primary ? 'is-primary' : ''} aria-label={primary ? '打开全部功能' : label}>
            <span><Icon weight={primary ? 'fill' : 'regular'} /></span>
            <small>{label}</small>
          </button>
        ))}
      </nav>
    </div>
  );
};

export default CardbookCompanionChrome;
