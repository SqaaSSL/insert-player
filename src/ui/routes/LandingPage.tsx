import { Button } from '../components/Button.tsx';

interface LandingPageProps {
  onCreateFighter: () => void;
  onOpenArcade: () => void;
  onOpenWatchMode: () => void;
}

const TRANSFORMATION_IMAGE = '/assets/landing-transformation.webp';
const LAUNCH_VIDEO = '/assets/insert-player-launch-3fe65eb9.mp4';

export function LandingPage({
  onCreateFighter,
  onOpenArcade,
  onOpenWatchMode,
}: LandingPageProps) {
  return (
    <div className="landing-page">
      <section className="landing-hero" aria-labelledby="landing-title">
        <img
          className="landing-hero__image"
          src={TRANSFORMATION_IMAGE}
          alt="A real person on the left and her recognizable arcade fighter on the right"
          fetchPriority="high"
        />
        <div className="landing-hero__shade" aria-hidden="true" />
        <div className="landing-hero__labels" aria-hidden="true">
          <span>Your photo</span>
          <span>Your fighter</span>
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
          <p className="landing-hero__note">Your first Rookie fighter is included.</p>
        </div>
      </section>

      <section className="landing-loop" aria-label="How Insert Player works">
        <div>
          <strong>Photo</strong>
          <span>Start with a real person</span>
        </div>
        <div>
          <strong>Fighter</strong>
          <span>Keep the face and build the moves</span>
        </div>
        <div>
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
