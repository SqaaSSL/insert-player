import { Button } from '../components/Button.tsx';

interface LandingPageProps {
  onCreateFighter: () => void;
  onOpenArcade: () => void;
  onOpenWatchMode: () => void;
}

const TRANSFORMATION_IMAGE = '/assets/landing-transformation.webp';
const LAUNCH_VIDEO = '/assets/insert-player-launch-bb1325da.mp4';
// GIF-style silent gameplay loop (~200 KB): real production footage, cut from
// the launch capture. The full film with audio stays in the proof section.
const FIGHT_LOOP_VIDEO = '/assets/landing-fight-loop-e40898d3.mp4';
const FIGHT_LOOP_POSTER = '/assets/landing-fight-poster-90b5173e.jpg';
const PANEL_PHOTO = '/assets/landing-panel-photo-b7ad6ddc.webp';
const PANEL_FIGHTER = '/assets/landing-panel-fighter-c2d0a569.webp';

export function LandingPage({
  onCreateFighter,
  onOpenArcade,
  onOpenWatchMode,
}: LandingPageProps) {
  return (
    <div className="landing-page">
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-triptych">
          <figure className="landing-panel landing-panel--photo">
            <span className="landing-panel__chip" aria-hidden="true">Your photo</span>
            <img
              src={PANEL_PHOTO}
              alt="A real person's portrait"
              fetchPriority="high"
            />
          </figure>
          <span className="landing-triptych__arrow" aria-hidden="true">&#9654;</span>
          <figure className="landing-panel landing-panel--fighter">
            <span className="landing-panel__chip" aria-hidden="true">Your fighter</span>
            <img
              src={PANEL_FIGHTER}
              alt="The same person as a recognizable arcade fighter"
            />
          </figure>
          <span className="landing-triptych__arrow" aria-hidden="true">&#9654;</span>
          <figure className="landing-panel landing-panel--fight">
            <span className="landing-panel__chip" aria-hidden="true">Your fight</span>
            <video
              autoPlay
              muted
              loop
              playsInline
              preload="auto"
              poster={FIGHT_LOOP_POSTER}
              aria-label="Silent looping clip of real Insert Player gameplay"
            >
              <source src={FIGHT_LOOP_VIDEO} type="video/mp4" />
            </video>
          </figure>
        </div>
        <div className="landing-hero__copy">
          <h1 id="landing-title">Insert Player</h1>
          <p>
            Turn one photo into a fighter you can actually play. Build your roster,
            enter the arcade, and keep every version across devices.
          </p>
          <div className="landing-hero__actions">
            <Button variant="primary" size="lg" onClick={onCreateFighter}>
              Create fighter
            </Button>
            <Button variant="ghost" size="lg" onClick={onOpenArcade}>
              Enter arcade
            </Button>
          </div>
          <p className="landing-hero__note">
            Your first Rookie fighter is included.
            <span className="landing-coin-blink" aria-hidden="true"> &middot; Insert coin</span>
          </p>
        </div>
      </section>

      <section className="landing-loop" aria-label="How Insert Player works">
        <div>
          <i className="landing-loop__num" aria-hidden="true">01</i>
          <strong>Photo</strong>
          <span>Start with a real person</span>
        </div>
        <div>
          <i className="landing-loop__num" aria-hidden="true">02</i>
          <strong>Fighter</strong>
          <span>Keep the face and build the moves</span>
        </div>
        <div>
          <i className="landing-loop__num" aria-hidden="true">03</i>
          <strong>Fight</strong>
          <span>Play the character in the browser</span>
        </div>
      </section>

      <section className="landing-proof" aria-labelledby="landing-proof-title">
        <header className="landing-section-head">
          <h2 id="landing-proof-title">The fighter actually fights.</h2>
          <p>
            This is recorded gameplay from the production build. Generated fighters,
            a generated stage, the real HUD, and a real exchange.
          </p>
        </header>
        <div className="landing-film">
          <video
            className="landing-film__video"
            controls
            playsInline
            preload="metadata"
            poster={TRANSFORMATION_IMAGE}
          >
            <source src={LAUNCH_VIDEO} type="video/mp4" />
          </video>
          <div className="landing-film__meta">
            <span>Production gameplay</span>
            <span>CPU vs CPU</span>
          </div>
        </div>
      </section>

      <section className="landing-identity" aria-labelledby="landing-identity-title">
        <img
          src={TRANSFORMATION_IMAGE}
          alt="The same woman shown as a source photo and as a game-ready fighter"
          loading="lazy"
        />
        <div className="landing-identity__copy">
          <h2 id="landing-identity-title">Keep the person. Build the player.</h2>
          <p>
            Insert Player preserves the source photo as the identity anchor, then builds
            the views and animations needed by the game. The result belongs in a match,
            not in a profile-picture folder.
          </p>
          <dl className="landing-identity__facts">
            <div>
              <dt>Recognizable</dt>
              <dd>Face, hair, clothes, and character stay connected to the source.</dd>
            </div>
            <div>
              <dt>Playable</dt>
              <dd>A complete move set loads directly into Insert Player: Fight.</dd>
            </div>
            <div>
              <dt>Portable</dt>
              <dd>Your cloud roster follows your account to another device.</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="landing-cta" aria-labelledby="landing-cta-title">
        <div>
          <h2 id="landing-cta-title">Your slot is open.</h2>
          <p>Create your Rookie or watch the global roster fight first.</p>
        </div>
        <div className="landing-cta__actions">
          <Button variant="primary" size="lg" onClick={onCreateFighter}>
            Insert player
          </Button>
          <Button variant="ghost" size="lg" onClick={onOpenWatchMode}>
            Watch a fight
          </Button>
        </div>
      </section>
    </div>
  );
}
