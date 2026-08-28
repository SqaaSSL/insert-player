import { useEffect, useState } from 'react';
import { HUD_STATE_EVENT, type HudStateDetail } from '../../game/match/MatchConfig.ts';
import { useFighterPortrait } from '../shared/useFighterPortrait.ts';

const BAR_WIDTH = 330;
const BAR_HEIGHT = 28;

function healthFillClass(ratio: number): string {
  if (ratio > 0.3) return 'fight-hud__bar-fill--ok';
  if (ratio > 0.15) return 'fight-hud__bar-fill--warn';
  return 'fight-hud__bar-fill--low';
}

interface HudSideProps {
  side: 'p1' | 'p2';
  name: string;
  tag: string | null;
  photoHash: string | null;
  health: number;
  maxHealth: number;
  meter: number;
  meterMax: number;
  wins: number;
  roundsToWin: number;
}

function HudSide({ side, name, tag, photoHash, health, maxHealth, meter, meterMax, wins, roundsToWin }: HudSideProps) {
  const portraitUrl = useFighterPortrait(photoHash);
  const ratio = maxHealth > 0 ? Math.max(0, Math.min(1, health / maxHealth)) : 0;
  const fillWidth = Math.round(ratio * BAR_WIDTH);
  const meterRatio = meterMax > 0 ? Math.max(0, Math.min(1, meter / meterMax)) : 0;
  const meterFull = meterRatio >= 1;
  const pips = Array.from({ length: Math.max(0, roundsToWin) }, (_, i) => i < wins);

  return (
    <div className={`fight-hud__side fight-hud__side--${side}`}>
      <div className="fight-hud__portrait" aria-hidden="true">
        {portraitUrl ? (
          <img className="fight-hud__portrait-img" src={portraitUrl} alt="" />
        ) : (
          <span className="fight-hud__portrait-fallback">{name.slice(0, 1).toUpperCase() || '?'}</span>
        )}
      </div>
      <div className="fight-hud__column">
        <div className="fight-hud__identity">
          <span className="fight-hud__name">{name.toUpperCase()}</span>
          {tag ? <span className="fight-hud__tag">{tag}</span> : null}
        </div>
        <div className="fight-hud__bar-frame">
          <svg
            className={side === 'p1' ? 'fight-hud__bar fight-hud__bar--mirrored' : 'fight-hud__bar'}
            viewBox={`0 0 ${BAR_WIDTH} ${BAR_HEIGHT}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <rect className="fight-hud__bar-bg" x={0} y={0} width={BAR_WIDTH} height={BAR_HEIGHT} />
            <rect className="fight-hud__bar-ghost" x={0} y={0} width={fillWidth} height={BAR_HEIGHT} />
            <rect
              className={`fight-hud__bar-fill ${healthFillClass(ratio)}`}
              x={0}
              y={0}
              width={fillWidth}
              height={BAR_HEIGHT}
            />
          </svg>
        </div>
        <div className="fight-hud__pips" aria-hidden="true">
          {pips.map((won, i) => (
            <span key={i} className={won ? 'fight-hud__pip is-won' : 'fight-hud__pip'} />
          ))}
        </div>
        <div
          className={meterFull ? 'fight-hud__meter is-full' : 'fight-hud__meter'}
          data-testid={`meter-${side}`}
          aria-hidden="true"
        >
          <svg
            className={side === 'p1' ? 'fight-hud__meter-bar fight-hud__meter-bar--mirrored' : 'fight-hud__meter-bar'}
            viewBox={`0 0 ${BAR_WIDTH} 10`}
            preserveAspectRatio="none"
          >
            <rect className="fight-hud__meter-bg" x={0} y={0} width={BAR_WIDTH} height={10} />
            <rect
              className={meterFull ? 'fight-hud__meter-fill is-full' : 'fight-hud__meter-fill'}
              x={0}
              y={0}
              width={Math.round(meterRatio * BAR_WIDTH)}
              height={10}
            />
          </svg>
          {meterFull ? <span className="fight-hud__meter-ready">SUPER</span> : null}
        </div>
      </div>
    </div>
  );
}

export interface FightHudProps {
  /** Test/SSR seed; live state arrives via the asf-hud-state window event. */
  initialState?: HudStateDetail | null;
}

export function FightHud({ initialState = null }: FightHudProps) {
  const [state, setState] = useState<HudStateDetail | null>(initialState);

  useEffect(() => {
    const onHudState = (event: WindowEventMap[typeof HUD_STATE_EVENT]) => {
      setState(event.detail);
    };
    window.addEventListener(HUD_STATE_EVENT, onHudState);
    return () => {
      window.removeEventListener(HUD_STATE_EVENT, onHudState);
    };
  }, []);

  if (!state || !state.visible) return null;

  return (
    <div className="fight-hud" data-testid="fight-hud">
      <HudSide
        side="p1"
        name={state.p1Name}
        tag={state.p1Tag}
        photoHash={state.p1PhotoHash}
        health={state.p1Health}
        maxHealth={state.maxHealth}
        meter={state.p1Meter}
        meterMax={state.meterMax}
        wins={state.p1Wins}
        roundsToWin={state.roundsToWin}
      />
      <div className="fight-hud__center">
        <span
          className={state.timer <= 10 ? 'fight-hud__timer fight-hud__timer--low' : 'fight-hud__timer'}
          role="timer"
        >
          {state.timer}
        </span>
        <span className="fight-hud__match-label">{state.matchLabel}</span>
      </div>
      <HudSide
        side="p2"
        name={state.p2Name}
        tag={state.p2Tag}
        photoHash={state.p2PhotoHash}
        health={state.p2Health}
        maxHealth={state.maxHealth}
        meter={state.p2Meter}
        meterMax={state.meterMax}
        wins={state.p2Wins}
        roundsToWin={state.roundsToWin}
      />
    </div>
  );
}
