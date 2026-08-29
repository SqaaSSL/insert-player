import { useEffect, useRef, useState } from 'react';
import type { BillingProfile } from '../../services/Billing.ts';
import type { AuthStatus } from '../authState.ts';
import { Button } from '../components/Button.tsx';
import { includedRookieStatus } from '../shared/rookieEntitlement.ts';

interface LandingPageProps {
  authStatus: AuthStatus;
  billingProfile: BillingProfile | null;
  billingProfileChecked: boolean;
  onPlayTrial: () => Promise<void>;
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
  authStatus,
  billingProfile,
  billingProfileChecked,
  onPlayTrial,
  onCreateFighter,
  onOpenArcade,
  onOpenWatchMode,
}: LandingPageProps) {
  const [trialLoading, setTrialLoading] = useState(false);
  const [trialError, setTrialError] = useState<string | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const [prefersReducedMotion] = useState(() => (
    typeof window !== 'undefined'
      && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  ));
  const [previewPlaying, setPreviewPlaying] = useState(!prefersReducedMotion);
  const rookieStatus = includedRookieStatus(authStatus, billingProfile);
  const rookieOffer = authStatus === 'signed-in' && billingProfileChecked && !billingProfile
    ? 'Rookie · pass verified at creation'
    : rookieStatus === 'included' && authStatus === 'signed-in'
    ? 'Free Rookie pass · 1 available'
    : rookieStatus === 'included'
      ? 'Free Rookie · human check at creation'
    : rookieStatus === 'credits'
      ? `Rookie · 2 credits · ${billingProfile?.creditsBalance ?? 0} available`
      : 'Checking your Rookie pass…';

  useEffect(() => {
    if (!prefersReducedMotion) return;
    previewVideoRef.current?.pause();
  }, [prefersReducedMotion]);

  const playTrial = async () => {
    if (trialLoading) return;
    setTrialLoading(true);
    setTrialError(null);
    try {
      await onPlayTrial();
    } catch (error) {
      setTrialError(error instanceof Error ? error.message : 'The demo could not start. Try again.');
      setTrialLoading(false);
    }
  };

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
              ref={previewVideoRef}
              autoPlay={!prefersReducedMotion}
              muted
              loop
              playsInline
              preload={prefersReducedMotion ? 'metadata' : 'auto'}
              poster={FIGHT_LOOP_POSTER}
              aria-label="Silent looping clip of real Insert Player gameplay"
              onPlay={() => setPreviewPlaying(true)}
              onPause={() => setPreviewPlaying(false)}
            >
              <source src={FIGHT_LOOP_VIDEO} type="video/mp4" />
            </video>
            <button
              type="button"
              className="landing-panel__motion-toggle"
              aria-label={`${previewPlaying ? 'Pause' : 'Play'} gameplay preview`}
              onClick={() => {
                const video = previewVideoRef.current;
                if (!video) return;
                if (video.paused) {
                  void video.play().catch(() => setPreviewPlaying(false));
                }
                else video.pause();
              }}
            >
              {previewPlaying ? 'Pause' : 'Play'} preview
            </button>
          </figure>
        </div>
        <div className="landing-hero__copy">
          <h1 id="landing-title">Insert Player</h1>
          <p>
            Play a real round first. Then turn one photo into your own fighter and
            take it straight into the Arcade.
          </p>
          <div className="landing-hero__actions">
            <Button variant="primary" size="lg" disabled={trialLoading} onClick={() => void playTrial()}>
              {trialLoading ? 'Loading fight…' : 'Play a free round'}
            </Button>
            <Button variant="ghost" size="lg" onClick={onCreateFighter}>
              Create your fighter
            </Button>
          </div>
          <p className="landing-hero__note">
              <span>Playable demo · no account, upload, or credits</span>
            <span aria-hidden="true"> &middot; </span>
            <span>{rookieOffer}</span>
          </p>
          {trialError ? (
            <p className="landing-hero__error" role="alert">{trialError}</p>
          ) : null}
          <button
            type="button"
            className="landing-hero__arcade-link"
            onClick={onOpenArcade}
          >
            Already have a fighter? Enter Arcade
          </button>
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
          <p>Try the controls, create your Rookie, then climb the global roster.</p>
        </div>
        <div className="landing-cta__actions">
          <Button variant="primary" size="lg" disabled={trialLoading} onClick={() => void playTrial()}>
            {trialLoading ? 'Loading fight…' : 'Play free round'}
          </Button>
          <Button variant="ghost" size="lg" onClick={onCreateFighter}>
            Insert yourself
          </Button>
          <Button variant="ghost" size="lg" onClick={onOpenWatchMode}>
            Watch a fight
          </Button>
        </div>
      </section>
    </div>
  );
}
