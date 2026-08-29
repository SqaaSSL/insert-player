import { useEffect, useState } from 'react';
import { RUNTIME_READY_EVENT } from '../../game/match/MatchConfig.ts';
import { BrandMark } from './BrandMark.tsx';
import { useFighterPortrait } from '../shared/useFighterPortrait.ts';

export type FightLoadingPhase = 'loading' | 'opening' | 'error';

interface FightLoadingCurtainProps {
  phase: FightLoadingPhase;
  p1Name: string;
  p2Name: string;
  p1PhotoHash: string | null;
  p2PhotoHash: string | null;
  stageLabel: string;
  onExit: () => void;
}

function fighterLabel(name: string, fallback: string): string {
  const trimmed = name.trim();
  return (trimmed || fallback).toUpperCase();
}

interface FighterSideProps {
  side: 'p1' | 'p2';
  name: string;
  photoHash: string | null;
  portraitRefreshKey: number;
}

function FighterSide({ side, name, photoHash, portraitRefreshKey }: FighterSideProps) {
  const portraitUrl = useFighterPortrait(photoHash, portraitRefreshKey);
  const fallback = side === 'p1' ? 'Player One' : 'Player Two';
  const label = fighterLabel(name, fallback);

  return (
    <div className={`fight-loader__fighter fight-loader__fighter--${side}`}>
      <span className="fight-loader__player-label">{side === 'p1' ? 'PLAYER ONE' : 'PLAYER TWO'}</span>
      <div className="fight-loader__figure" aria-hidden="true">
        {portraitUrl ? (
          <img className="fight-loader__figure-img" src={portraitUrl} alt="" />
        ) : (
          <span className="fight-loader__figure-fallback">{label.slice(0, 1)}</span>
        )}
      </div>
      <strong className="fight-loader__fighter-name">{label}</strong>
    </div>
  );
}

export function FightLoadingCurtain({
  phase,
  p1Name,
  p2Name,
  p1PhotoHash,
  p2PhotoHash,
  stageLabel,
  onExit,
}: FightLoadingCurtainProps) {
  const failed = phase === 'error';
  const [portraitRefreshKey, setPortraitRefreshKey] = useState(0);

  useEffect(() => {
    const refreshPortraits = () => setPortraitRefreshKey((current) => current + 1);
    window.addEventListener(RUNTIME_READY_EVENT, refreshPortraits);
    return () => window.removeEventListener(RUNTIME_READY_EVENT, refreshPortraits);
  }, []);

  return (
    <section
      className={`fight-loader is-${phase}`}
      role={failed ? 'alert' : 'status'}
      aria-live="polite"
      aria-label={failed ? 'The match could not load' : 'Loading match'}
    >
      <div className="fight-loader__panel fight-loader__panel--p1" aria-hidden="true">
        <span className="fight-loader__panel-label">P1</span>
      </div>
      <div className="fight-loader__panel fight-loader__panel--p2" aria-hidden="true">
        <span className="fight-loader__panel-label">P2</span>
      </div>
      <div className="fight-loader__energy" aria-hidden="true" />
      <div className="fight-loader__slash" aria-hidden="true" />
      <div className="fight-loader__scanlines" aria-hidden="true" />

      <div className="fight-loader__stage" aria-hidden="true">
        <span>INSERT PLAYER PRESENTS</span>
        <strong>{stageLabel.toUpperCase()}</strong>
      </div>

      <div className="fight-loader__fighters">
        <FighterSide
          side="p1"
          name={p1Name}
          photoHash={p1PhotoHash}
          portraitRefreshKey={portraitRefreshKey}
        />
        <FighterSide
          side="p2"
          name={p2Name}
          photoHash={p2PhotoHash}
          portraitRefreshKey={portraitRefreshKey}
        />
      </div>

      <div className="fight-loader__content">
        <BrandMark size={62} className="fight-loader__mark" />
        <strong className="fight-loader__brand">INSERT PLAYER</strong>
        <b className="fight-loader__vs" aria-hidden="true"><i>V</i><i>S</i></b>
        {failed ? (
          <>
            <span className="fight-loader__status fight-loader__status--error">CABINET OFFLINE</span>
            <button type="button" className="fight-loader__exit asf-btn asf-btn--primary" onClick={onExit}>
              Back To Arcade
            </button>
          </>
        ) : (
          <>
            <span className="fight-loader__status">INSERTING FIGHTERS</span>
            <span className="fight-loader__meter" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
          </>
        )}
      </div>
    </section>
  );
}
