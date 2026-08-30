import React from 'react';
import {
  Broadcast,
  ChatCircleDots,
  HandTap,
  Heart,
  Sparkle,
  TShirt,
  VideoCamera,
} from '@phosphor-icons/react';
import { Icons } from '../../constants';
import TokenImg from './TokenImg';
import { AppID, type CharacterProfile, type ScheduleSlot } from '../../types';
import './IdolCompanionChrome.css';

type IdolCompanionChromeProps = {
  character: CharacterProfile;
  currentScheduleSlot: ScheduleSlot | null;
  dayProgress: number;
  hours: number;
  minutes: number;
  openApp: (id: AppID) => void;
  openCharacterSchedule: () => void;
  openWardrobe: () => void;
  openTouchSettings: () => void;
  openAllApps: () => void;
};

const IdolCompanionChrome: React.FC<IdolCompanionChromeProps> = ({
  character,
  currentScheduleSlot,
  dayProgress,
  hours,
  minutes,
  openApp,
  openCharacterSchedule,
  openWardrobe,
  openTouchSettings,
  openAllApps,
}) => {
  const time = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  const stageTools = [
    { id: 'touch', label: '互动', eyebrow: 'TOUCH', Icon: HandTap, action: openTouchSettings },
    { id: 'wardrobe', label: '换装', eyebrow: 'STYLE', Icon: TShirt, action: openWardrobe, testId: 'companion-idol-wardrobe-button' },
    { id: 'appearance', label: '舞美', eyebrow: 'SCENE', Icon: Sparkle, action: () => openApp(AppID.Appearance) },
  ];
  const dock = [
    { id: AppID.Chat, label: '对话', Icon: ChatCircleDots, action: () => openApp(AppID.Chat) },
    { id: AppID.Call, label: '通话', Icon: VideoCamera, action: () => openApp(AppID.Call) },
    { id: 'live', label: '舞台', Icon: Broadcast, action: openAllApps, primary: true },
    { id: AppID.SpecialMoments, label: '时光', Icon: Heart, action: () => openApp(AppID.SpecialMoments) },
    { id: AppID.Music, label: '音乐', Icon: Icons.Music, action: () => openApp(AppID.Music) },
  ];

  return (
    <div className="companion-idol-chrome pointer-events-none absolute inset-0 z-30" data-testid="companion-idol-chrome">
      <header className="idol-live-header pointer-events-auto">
        <button type="button" className="idol-live-identity" onClick={() => openApp(AppID.Character)}>
          <span className="idol-live-avatar"><TokenImg value={character.avatar} alt="" /></span>
          <span className="idol-live-copy"><small>NOW ON STAGE</small><strong>{character.name}</strong></span>
        </button>
        <div className="idol-live-status" aria-label="正在直播">
          <i aria-hidden /><strong>LIVE</strong><span>{time}</span>
        </div>
      </header>

      <div className="idol-stage-title" aria-hidden>
        <span>PRIVATE LIVE SESSION</span>
        <strong>{character.name}</strong>
        <small>STAGE · 08</small>
      </div>

      <aside className="idol-stage-tools pointer-events-auto" aria-label="直播舞台工具">
        {stageTools.map(({ id, label, eyebrow, Icon, action, testId }, index) => (
          <button key={id} type="button" onClick={action} data-testid={testId} data-companion-wardrobe-trigger={id === 'wardrobe' ? 'true' : undefined}>
            <span>0{index + 1}</span><Icon weight="bold" />
            <small>{eyebrow}</small><strong>{label}</strong>
          </button>
        ))}
      </aside>

      <button type="button" className="idol-live-route pointer-events-auto" onClick={openCharacterSchedule}>
        <span><i aria-hidden /> CURRENT SET</span>
        <strong>{currentScheduleSlot?.activity || '自由互动时间'}</strong>
        <small>{currentScheduleSlot ? `${currentScheduleSlot.startTime}${currentScheduleSlot.location ? ` · ${currentScheduleSlot.location}` : ''}` : '打开今天的舞台行程'}</small>
        <em>{dayProgress}%</em>
      </button>

      <div className="idol-live-caption" aria-hidden><span>YOUR FRONT ROW</span><i /><small>映像与心跳同频</small></div>

      <nav className="idol-live-dock pointer-events-auto" aria-label="偶像直播导航">
        {dock.map(({ id, label, Icon, action, primary }) => (
          <button key={id} type="button" onClick={action} className={primary ? 'is-live' : ''} aria-label={primary ? '打开全部功能' : label}>
            <span><Icon weight={primary ? 'fill' : 'regular'} /></span><small>{label}</small>
          </button>
        ))}
      </nav>
    </div>
  );
};

export default IdolCompanionChrome;
