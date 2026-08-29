import { BrandMark } from './BrandMark.tsx';

export type FightLoadingPhase = 'loading' | 'opening' | 'error';

interface FightLoadingCurtainProps {
  phase: FightLoadingPhase;
  p1Name: string;
  p2Name: string;
  onExit: () => void;
}

function fighterLabel(name: string, fallback: string): string {
  const trimmed = name.trim();
  return (trimmed || fallback).toUpperCase();
}

export function FightLoadingCurtain({ phase, p1Name, p2Name, onExit }: FightLoadingCurtainProps) {
  const failed = phase === 'error';

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
      <div className="fight-loader__scanlines" aria-hidden="true" />

      <div className="fight-loader__content">
        <BrandMark size={78} className="fight-loader__mark" />
        <strong className="fight-loader__brand">INSERT PLAYER</strong>
        <div className="fight-loader__matchup" aria-hidden="true">
          <span>{fighterLabel(p1Name, 'Player One')}</span>
          <b>VS</b>
          <span>{fighterLabel(p2Name, 'Player Two')}</span>
        </div>
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
