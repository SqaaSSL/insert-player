import { useEffect, useState } from 'react';
import { RUNTIME_READY_EVENT } from '../../game/match/MatchConfig.ts';
import { BrandMark } from './BrandMark.tsx';
import { useFighterPortrait } from '../shared/useFighterPortrait.ts';

export type FightLoadingPhase = 'loading' | 'opening' | 'error';

interface FightLoadingCurtainProps {
  phase: FightLoadingPhase;
  mode?: 'fight' | 'rush';
  p1Name: string;
  p2Name: string;
  p1PhotoHash: string | null;
  p2PhotoHash: string | null;
  stageLabel: string;
  stageDescription?: string;
  stageImageUrl?: string | null;
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
  playerLabel: string;
}

function FighterSide({ side, name, photoHash, portraitRefreshKey, playerLabel }: FighterSideProps) {
  const portraitUrl = useFighterPortrait(photoHash, portraitRefreshKey);
  const fallback = side === 'p1' ? 'Player One' : 'Player Two';
  const label = fighterLabel(name, fallback);

  return (
    <div className={`fight-loader__fighter fight-loader__fighter--${side}`}>
      <span className="fight-loader__player-label">{playerLabel}</span>
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

function LoadingMeter() {
  return (
    <span className="fight-loader__meter" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

interface RushLoadingLayoutProps {
  failed: boolean;
  p1Name: string;
  p2Name: string;
  p1PhotoHash: string | null;
  p2PhotoHash: string | null;
  portraitRefreshKey: number;
  stageLabel: string;
  stageDescription?: string;
  stageImageUrl?: string | null;
  onExit: () => void;
}

function RushLoadingLayout({
  failed,
  p1Name,
  p2Name,
  p1PhotoHash,
  p2PhotoHash,
  portraitRefreshKey,
  stageLabel,
  stageDescription,
  stageImageUrl,
  onExit,
}: RushLoadingLayoutProps) {
  return (
    <>
      <div className="rush-loader__stage-art" aria-hidden="true">
        {stageImageUrl ? (
          <img src={stageImageUrl} alt="" decoding="async" fetchPriority="high" />
        ) : null}
      </div>
      <div className="rush-loader__ambient" aria-hidden="true" />
      <div className="fight-loader__scanlines" aria-hidden="true" />

      <div className="rush-loader__layout">
        <section className="rush-loader__team" aria-label={`Team: ${p1Name} and ${p2Name}`}>
          <div className="rush-loader__brand-lockup">
            <BrandMark size={46} className="rush-loader__mark" />
            <div>
              <strong>INSERT PLAYER</strong>
              <span>CO-OP RUSH</span>
            </div>
          </div>

          <div className="rush-loader__team-heading">
            <span>TEAM READY</span>
            <strong>MOVE AS ONE</strong>
          </div>

          <div className="rush-loader__fighters">
            <FighterSide
              side="p1"
              name={p1Name}
              photoHash={p1PhotoHash}
              portraitRefreshKey={portraitRefreshKey}
              playerLabel="PLAYER"
            />
            <span className="rush-loader__plus" aria-hidden="true">+</span>
            <FighterSide
              side="p2"
              name={p2Name}
              photoHash={p2PhotoHash}
              portraitRefreshKey={portraitRefreshKey}
              playerLabel="CPU PARTNER"
            />
          </div>
        </section>

        <div className="rush-loader__advance" aria-hidden="true">
          <span>ADVANCE</span>
          <b>›</b>
        </div>

        <aside className="rush-loader__briefing">
          <span className="rush-loader__route-label">ROUTE 01</span>
          <h2>{stageLabel.toUpperCase()}</h2>
          <p>
            {stageDescription
              ?? 'Push right together, clear every blockade, and reach the final gate.'}
          </p>

          <dl className="rush-loader__mission">
            <div>
              <dt>PATH</dt>
              <dd>MOVE RIGHT</dd>
            </div>
            <div>
              <dt>FORMATION</dt>
              <dd>PLAYER + CPU</dd>
            </div>
            <div>
              <dt>FINISH</dt>
              <dd>CLEAR 4 SECTORS</dd>
            </div>
          </dl>

          {failed ? (
            <div className="rush-loader__loading">
              <span className="fight-loader__status fight-loader__status--error">ROUTE OFFLINE</span>
              <button type="button" className="fight-loader__exit asf-btn asf-btn--primary" onClick={onExit}>
                Back To Arcade
              </button>
            </div>
          ) : (
            <div className="rush-loader__loading">
              <span className="fight-loader__status">OPENING ROUTE</span>
              <LoadingMeter />
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

export function FightLoadingCurtain({
  phase,
  mode = 'fight',
  p1Name,
  p2Name,
  p1PhotoHash,
  p2PhotoHash,
  stageLabel,
  stageDescription,
  stageImageUrl,
  onExit,
}: FightLoadingCurtainProps) {
  const failed = phase === 'error';
  const isRush = mode === 'rush';
  const [portraitRefreshKey, setPortraitRefreshKey] = useState(0);

  useEffect(() => {
    const refreshPortraits = () => setPortraitRefreshKey((current) => current + 1);
    window.addEventListener(RUNTIME_READY_EVENT, refreshPortraits);
    return () => window.removeEventListener(RUNTIME_READY_EVENT, refreshPortraits);
  }, []);

  if (isRush) {
    return (
      <section
        className={`fight-loader is-${phase} is-rush`}
        role={failed ? 'alert' : 'status'}
        aria-live="polite"
        aria-label={failed ? 'The game could not load' : 'Loading Rush'}
      >
        <RushLoadingLayout
          failed={failed}
          p1Name={p1Name}
          p2Name={p2Name}
          p1PhotoHash={p1PhotoHash}
          p2PhotoHash={p2PhotoHash}
          portraitRefreshKey={portraitRefreshKey}
          stageLabel={stageLabel}
          stageDescription={stageDescription}
          stageImageUrl={stageImageUrl}
          onExit={onExit}
        />
      </section>
    );
  }

  return (
    <section
      className={`fight-loader is-${phase}`}
      role={failed ? 'alert' : 'status'}
      aria-live="polite"
      aria-label={failed ? 'The game could not load' : 'Loading Fight'}
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
          playerLabel="PLAYER ONE"
        />
        <FighterSide
          side="p2"
          name={p2Name}
          photoHash={p2PhotoHash}
          portraitRefreshKey={portraitRefreshKey}
          playerLabel="PLAYER TWO"
        />
      </div>

      <div className="fight-loader__content">
        <BrandMark size={62} className="fight-loader__mark" />
        <strong className="fight-loader__brand">INSERT PLAYER</strong>
        <span className="fight-loader__mode">FIGHT</span>
        <b className="fight-loader__vs" aria-hidden="true">
          <i>V</i><i>S</i>
        </b>
        {failed ? (
          <>
            <span className="fight-loader__status fight-loader__status--error">CABINET OFFLINE</span>
            <button type="button" className="fight-loader__exit asf-btn asf-btn--primary" onClick={onExit}>
              Back To Arcade
            </button>
          </>
        ) : (
          <>
            <span className="fight-loader__status">
              INSERTING FIGHTERS
            </span>
            <LoadingMeter />
          </>
        )}
      </div>
    </section>
  );
}
