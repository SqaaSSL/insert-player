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
