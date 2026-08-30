import React, { useEffect, useState } from 'react';

export type CompanionStageCurtainPhase = 'covered' | 'opening' | 'hidden';

interface CompanionStageLoadingCurtainProps {
  phase: CompanionStageCurtainPhase;
  characterName: string;
  accentColor: string;
  surfaceColor: string;
  lightSurface?: boolean;
}

const STATUS_STEPS = [
  '校准舞台比例',
  '同步角色姿态',
  '固定角色构图',
];

const CompanionStageLoadingCurtain: React.FC<CompanionStageLoadingCurtainProps> = ({
  phase,
  characterName,
  accentColor,
  surfaceColor,
  lightSurface = false,
}) => {
  const [statusIndex, setStatusIndex] = useState(0);

  useEffect(() => {
    if (phase !== 'covered') return;
    setStatusIndex(0);
    const timer = window.setInterval(() => {
      setStatusIndex(index => Math.min(index + 1, STATUS_STEPS.length - 1));
    }, 1150);
    return () => window.clearInterval(timer);
  }, [phase]);

  if (phase === 'hidden') return null;
  const opening = phase === 'opening';
  const textColor = lightSurface ? '#332d3b' : '#f8f5ff';
  const mutedColor = lightSurface ? 'rgba(51,45,59,.5)' : 'rgba(248,245,255,.48)';
  const doorBackground = lightSurface
    ? `linear-gradient(150deg, color-mix(in srgb, ${surfaceColor} 14%, #fffaf3), color-mix(in srgb, ${accentColor} 9%, #f1ede5))`
    : `linear-gradient(150deg, color-mix(in srgb, ${surfaceColor} 86%, #171022), color-mix(in srgb, ${accentColor} 12%, #08060d))`;

  return (
    <div
      className="absolute inset-0 z-[25] overflow-hidden"
      style={{
        pointerEvents: opening ? 'none' : 'auto',
        background: opening ? 'transparent' : `${surfaceColor}35`,
        transition: 'background-color 460ms ease',
      }}
      role="status"
      aria-live="polite"
      aria-label={`${characterName}舞台正在准备`}
      data-testid="companion-stage-loading-curtain"
      data-phase={phase}
    >
      <style>{`
        @keyframes companion-curtain-scan {
          0% { transform:translateY(-32vh); opacity:0; }
          18% { opacity:.6; }
          82% { opacity:.32; }
          100% { transform:translateY(104vh); opacity:0; }
        }
        @keyframes companion-curtain-signal {
          0%,100% { transform:scaleX(.2); opacity:.38; }
          50% { transform:scaleX(1); opacity:.9; }
        }
        @media (prefers-reduced-motion: reduce) {
          .companion-curtain-door, .companion-curtain-copy { transition-duration:1ms !important; }
          .companion-curtain-scan, .companion-curtain-signal { animation:none !important; }
        }
      `}</style>

      <div
        className="companion-curtain-door absolute inset-y-0 left-0 w-[calc(50%+1px)] border-r"
        style={{
          background: doorBackground,
          borderColor: `${accentColor}38`,
          boxShadow: `inset -18px 0 38px ${surfaceColor}38`,
          transform: opening ? 'translate3d(-104%,0,0)' : 'translate3d(0,0,0)',
          transition: 'transform 620ms cubic-bezier(.76,0,.24,1)',
          willChange: 'transform',
        }}
      >
        <span className="absolute inset-y-[9%] right-4 w-px" style={{ background: `${accentColor}22` }} />
        <span className="absolute right-4 top-[18%] h-8 w-3 border-y border-l" style={{ borderColor: `${accentColor}42` }} />
        <span className="absolute bottom-[16%] right-4 h-12 w-3 border-y border-l" style={{ borderColor: `${accentColor}42` }} />
      </div>
      <div
        className="companion-curtain-door absolute inset-y-0 right-0 w-[calc(50%+1px)] border-l"
        style={{
          background: doorBackground,
          borderColor: `${accentColor}38`,
          boxShadow: `inset 18px 0 38px ${surfaceColor}38`,
          transform: opening ? 'translate3d(104%,0,0)' : 'translate3d(0,0,0)',
          transition: 'transform 620ms cubic-bezier(.76,0,.24,1)',
          willChange: 'transform',
        }}
      >
        <span className="absolute inset-y-[9%] left-4 w-px" style={{ background: `${accentColor}22` }} />
        <span className="absolute left-4 top-[18%] h-8 w-3 border-y border-r" style={{ borderColor: `${accentColor}42` }} />
        <span className="absolute bottom-[16%] left-4 h-12 w-3 border-y border-r" style={{ borderColor: `${accentColor}42` }} />
      </div>

      <span
        className="companion-curtain-scan pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{
          background: `linear-gradient(90deg,transparent,${accentColor}c9,transparent)`,
          boxShadow: `0 0 18px ${accentColor}94`,
          animation: 'companion-curtain-scan 2.1s linear infinite',
          opacity: opening ? 0 : 1,
        }}
      />

      <div
        className="companion-curtain-copy absolute inset-0 flex flex-col items-center justify-center px-8 text-center"
        style={{
          color: textColor,
          opacity: opening ? 0 : 1,
          transform: opening ? 'scale(.98)' : 'scale(1)',
          transition: 'opacity 220ms ease, transform 260ms ease',
        }}
      >
        <span className="text-[8px] font-semibold tracking-[0.34em]" style={{ color: mutedColor }}>STAGE LINK / 01</span>
        <strong className="mt-2 max-w-full truncate font-serif text-[21px] font-medium tracking-[0.04em]">{characterName}</strong>
        <span className="mt-4 h-px w-20 overflow-hidden" style={{ background: `${accentColor}24` }}>
          <span
            className="companion-curtain-signal block h-full w-full origin-center"
            style={{ background: accentColor, animation: 'companion-curtain-signal 1.15s ease-in-out infinite' }}
          />
        </span>
        <span className="mt-2 text-[10px] tracking-[0.14em]" style={{ color: mutedColor }}>{STATUS_STEPS[statusIndex]}</span>
      </div>
    </div>
  );
};

export default CompanionStageLoadingCurtain;
