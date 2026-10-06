import type { ReactNode } from 'react';
import { Button } from './Button.tsx';

export const LAUNCH_FILM = '/assets/insert-player-launch-aura-v25.mp4';

/** Opt-in playback keeps the three-game film off the landing's initial download. */
export function LaunchFilm() {
  return (
    <section className="product-entry__film" aria-labelledby="launch-film-title">
      <header className="product-entry__film-heading">
        <h2 id="launch-film-title">Insert yourself into the game.</h2>
        <p>Aura farming · Fight · Rush</p>
      </header>
      <video
        className="product-entry__film-video"
        aria-label="Insert Player: your photo, Aura farming, Fight and Rush"
        controls
        playsInline
        preload="none"
        width="1920"
        height="1080"
        poster="/assets/insert-player-launch-aura-v25-poster.webp"
      >
        <source src={LAUNCH_FILM} type="video/mp4" />
        <track kind="captions" src="/assets/insert-player-launch-aura-v25-en.vtt" srcLang="en" label="English" />
        <a href={LAUNCH_FILM}>Watch the Insert Player film</a>
      </video>
    </section>
  );
}

/** The first thing on both home pages: what Insert Player is, the film, one way in. */
export function HomeHero({ ctaLabel, onCta, children }: { ctaLabel?: string; onCta?: () => void; children?: ReactNode }) {
  return (
    <section className="home-hero" aria-labelledby="home-hero-title">
      <p className="product-entry__genre">Insert Player</p>
      <h1 id="home-hero-title">Insert yourself into the game.</h1>
      <p className="home-hero__claim">
        One photo turns you into a playable character. Farm aura on the beat in Aura, or take on a rival in Fight.
        Play a free demo with ready-made characters, no account needed.
      </p>
      <video
        className="home-hero__video"
        aria-label="Insert Player: your photo, Aura farming, Fight and Rush"
        controls
        playsInline
        preload="none"
        width="1920"
        height="1080"
        poster="/assets/insert-player-launch-aura-v25-poster.webp"
      >
        <source src={LAUNCH_FILM} type="video/mp4" />
        <track kind="captions" src="/assets/insert-player-launch-aura-v25-en.vtt" srcLang="en" label="English" />
        <a href={LAUNCH_FILM}>Watch the Insert Player film</a>
      </video>
      {onCta && ctaLabel ? (
        <div className="home-hero__actions">
          <Button variant="primary" size="lg" onClick={onCta}>{ctaLabel}</Button>
        </div>
      ) : null}
      {children}
    </section>
  );
}
