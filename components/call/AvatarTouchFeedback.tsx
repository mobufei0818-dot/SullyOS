import React from 'react';

export interface AvatarTouchEffect {
  id: string;
  normalizedX: number;
  normalizedY: number;
  label: string;
}

interface AvatarTouchFeedbackProps {
  characterName: string;
  accentColor: string;
  effects: AvatarTouchEffect[];
  lightTheme?: boolean;
}

const TOUCH_FEEDBACK_CSS = `
@keyframes sully-touch-ripple {
  0% { opacity: .85; transform: translate(-50%, -50%) scale(.25); }
  62% { opacity: .28; transform: translate(-50%, -50%) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(1.28); }
}
@keyframes sully-touch-heart-left {
  0% { opacity: 0; transform: translate(-50%, -25%) scale(.45) rotate(-8deg); }
  18% { opacity: 1; }
  100% { opacity: 0; transform: translate(calc(-50% - 18px), -62px) scale(1.05) rotate(-22deg); }
}
@keyframes sully-touch-heart-mid {
  0% { opacity: 0; transform: translate(-50%, -20%) scale(.35); }
  16% { opacity: .95; }
  100% { opacity: 0; transform: translate(-50%, -76px) scale(.9) rotate(8deg); }
}
@keyframes sully-touch-heart-right {
  0% { opacity: 0; transform: translate(-50%, -20%) scale(.4) rotate(6deg); }
  22% { opacity: .9; }
  100% { opacity: 0; transform: translate(calc(-50% + 20px), -56px) scale(1) rotate(25deg); }
}
@keyframes sully-touch-avatar-bounce {
  0% { transform: scale(1) rotate(0deg); }
  32% { transform: scale(.965) rotate(-1.5deg); }
  68% { transform: scale(1.035) rotate(1deg); }
  100% { transform: scale(1) rotate(0deg); }
}
@keyframes sully-touch-float-copy {
  0% { opacity: 0; transform: translate(-50%, 8px); }
  14% { opacity: 1; transform: translate(-50%, 0); }
  72% { opacity: .95; transform: translate(-50%, -15px); }
  100% { opacity: 0; transform: translate(-50%, -28px); }
}
@media (prefers-reduced-motion: reduce) {
  .sully-touch-ripple,
  .sully-touch-heart { display: none; }
  .sully-touch-copy {
    animation: none !important;
    opacity: 1;
    transform: translate(-50%, 0);
    filter: none;
  }
  .sully-touch-avatar { animation: none !important; }
}
`;

const clampPercent = (value: number, min: number, max: number) => (
  Math.max(min, Math.min(max, value * 100))
);

const AvatarTouchFeedback: React.FC<AvatarTouchFeedbackProps> = ({
  characterName,
  accentColor,
  effects,
  lightTheme = false,
}) => (
  <div
    className="pointer-events-none absolute inset-0 z-30 overflow-visible"
    aria-live="polite"
    aria-atomic="false"
    data-avatar-touch-effects={effects.length}
  >
    <style>{TOUCH_FEEDBACK_CSS}</style>
    {effects.map(effect => {
      const pointX = clampPercent(effect.normalizedX, 4, 96);
      const pointY = clampPercent(effect.normalizedY, 6, 94);
      const copyX = clampPercent(effect.normalizedX, 25, 75);
      const copyY = clampPercent(effect.normalizedY - 0.08, 20, 78);
      return (
        <React.Fragment key={effect.id}>
          <span
            className="sully-touch-ripple absolute h-14 w-14 rounded-full border"
            style={{
              left: `${pointX}%`,
              top: `${pointY}%`,
              borderColor: `${accentColor}cc`,
              boxShadow: `0 0 18px ${accentColor}88, inset 0 0 14px ${accentColor}44`,
              animation: 'sully-touch-ripple 760ms cubic-bezier(.16,.84,.35,1) both',
            }}
          />
          {(['left', 'mid', 'right'] as const).map((side, index) => (
            <span
              key={side}
              className="sully-touch-heart absolute text-[13px]"
              style={{
                left: `${pointX}%`,
                top: `${pointY}%`,
                color: index === 1 ? '#fff1f7' : '#ff91bd',
                textShadow: `0 0 10px ${accentColor}, 0 1px 2px rgba(0,0,0,.45)`,
                animation: `sully-touch-heart-${side} ${820 + index * 110}ms ease-out ${index * 45}ms both`,
              }}
            >♥</span>
          ))}
          <span
            className="sully-touch-copy absolute whitespace-nowrap rounded-full border px-3 py-1.5 text-[11px] font-medium tracking-[0.04em] backdrop-blur-md"
            data-avatar-touch-feedback={effect.label}
            style={{
              left: `${copyX}%`,
              top: `${copyY}%`,
              color: lightTheme ? '#4a2941' : '#fff5fb',
              background: lightTheme ? 'rgba(255,248,252,.88)' : 'rgba(19,10,27,.72)',
              borderColor: `${accentColor}55`,
              boxShadow: `0 8px 28px rgba(0,0,0,.24), 0 0 18px ${accentColor}33`,
              animation: 'sully-touch-float-copy 1650ms cubic-bezier(.2,.8,.2,1) both',
            }}
          >~ ♥ 你戳了戳 {characterName} 的{effect.label} ♥ ~</span>
        </React.Fragment>
      );
    })}
  </div>
);

export default AvatarTouchFeedback;
