import { useEffect, useState } from 'react';
import { INTRO_STATE_EVENT, type IntroStateDetail } from '../../game/match/MatchConfig.ts';
import { useFighterPortrait } from '../shared/useFighterPortrait.ts';

interface IntroCardProps {
  side: 'p1' | 'p2';
  playerLabel: string;
  name: string;
  tag: string | null;
  photoHash: string | null;
}

function IntroCard({ side, playerLabel, name, tag, photoHash }: IntroCardProps) {
  const portraitUrl = useFighterPortrait(photoHash);
  return (
    <article className={`fight-intro__card fight-intro__card--${side}`}>
      <div className="fight-intro__portrait" aria-hidden="true">
        {portraitUrl ? (
          <img className="fight-intro__portrait-img" src={portraitUrl} alt="" />
        ) : (
          <span className="fight-intro__portrait-fallback">{name.slice(0, 1).toUpperCase() || '?'}</span>
        )}
      </div>
      <div className="fight-intro__copy">
        <small>{playerLabel}</small>
        <strong>{name.toUpperCase()}</strong>
        {tag ? <span>{tag}</span> : null}
      </div>
    </article>
  );
}

export interface FightIntroOverlayProps {
  /** Test/SSR seed; live state arrives via the asf-intro window event. */
  initialState?: IntroStateDetail | null;
}

export function FightIntroOverlay({ initialState = null }: FightIntroOverlayProps) {
  const [state, setState] = useState<IntroStateDetail | null>(initialState);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    let hideTimer: number | undefined;
    const onIntroState = (event: WindowEventMap[typeof INTRO_STATE_EVENT]) => {
      const detail = event.detail;
      if (detail.visible) {
        window.clearTimeout(hideTimer);
        setExiting(false);
        setState(detail);
        return;
      }
      setExiting((wasExiting) => {
        if (!wasExiting) {
          const reduceMotion =
            window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
          hideTimer = window.setTimeout(
            () => {
              setState(null);
              setExiting(false);
            },
            reduceMotion ? 120 : 400,
          );
        }
        return true;
      });
    };
    window.addEventListener(INTRO_STATE_EVENT, onIntroState);
    return () => {
      window.removeEventListener(INTRO_STATE_EVENT, onIntroState);
      window.clearTimeout(hideTimer);
    };
  }, []);

  if (!state) return null;

  return (
    <section className={exiting ? 'fight-intro is-exiting' : 'fight-intro'} aria-hidden="true">
      <div className="fight-intro__energy" />
      <header className="fight-intro__heading">
        <span className="fight-intro__stage">{state.stageLabel}</span>
        <span className="fight-intro__match">{state.matchLabel}</span>
        <span className="fight-intro__round">ROUND {state.roundNumber}</span>
      </header>
      <div className="fight-intro__cards">
        <IntroCard
          side="p1"
          playerLabel="PLAYER ONE"
          name={state.p1Name}
          tag={state.p1Tag}
          photoHash={state.p1PhotoHash}
        />
        <div className="fight-intro__vs" aria-hidden="true">
          <i>V</i>
          <i>S</i>
        </div>
        <IntroCard
          side="p2"
          playerLabel="PLAYER TWO"
          name={state.p2Name}
          tag={state.p2Tag}
          photoHash={state.p2PhotoHash}
        />
      </div>
      <footer className="fight-intro__skip">ENTER / SPACE — SKIP</footer>
    </section>
  );
}
