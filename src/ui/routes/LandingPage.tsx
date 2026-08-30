import { useEffect, useState } from 'react';
import { Button } from '../components/Button.tsx';

interface LandingPageProps {
  onCreateFighter: () => void;
  onOpenArcade: () => void;
  onOpenWatchMode: () => void;
  onOpenCommunity: () => void;
  /** Signed-in visitors see their own photo in the first panel. */
  userImageUrl?: string | null;
}

const TRANSFORMATION_IMAGE = '/assets/landing-transformation.webp';
const LAUNCH_VIDEO = '/assets/insert-player-launch-3dfeedd6.mp4';
const GAMEPLAY_REEL_VIDEO = '/assets/insert-player-gameplay-5a19b606.mp4';
const GAMEPLAY_REEL_GIF = '/assets/insert-player-gameplay-0e5dc078.gif';
// GIF-style silent gameplay loop (~200 KB): real production footage, cut from
// the launch capture. The full film with audio stays in the proof section.
const FIGHT_LOOP_VIDEO = '/assets/landing-fight-loop-e40898d3.mp4';
const FIGHT_LOOP_POSTER = '/assets/landing-fight-poster-90b5173e.jpg';
const CASUAL_FIGHT_LOOP_VIDEO = '/assets/landing-fight-loop-casual-1f510ac6.mp4';
const CASUAL_FIGHT_LOOP_POSTER = '/assets/landing-fight-poster-casual-5ce10ee4.jpg';

export interface LandingStory {
  id: string;
  name: string;
  photo: string;
  fighter: string;
  fightVideo: string;
  fightPoster: string;
}

/** Complete photo -> fighter -> fight stories. Every fight must feature the
 * person shown in that same story; do not reuse footage across entries. */
export const LANDING_STORIES: LandingStory[] = [
  {
    id: 'player-one',
    name: 'Player One',
    photo: '/assets/landing-panel-photo-a6cda804.webp',
    fighter: '/assets/landing-panel-fighter-c2d0a569.webp',
    fightVideo: FIGHT_LOOP_VIDEO,
    fightPoster: FIGHT_LOOP_POSTER,
  },
  // Fully synthetic casual-selfie example: nobody real, no licensing.
  {
    id: 'casual',
    name: 'Casual',
    photo: '/assets/landing-panel-photo2-2de4f7af.webp',
    fighter: '/assets/landing-panel-fighter2-e9c8ad75.webp',
    fightVideo: CASUAL_FIGHT_LOOP_VIDEO,
    fightPoster: CASUAL_FIGHT_LOOP_POSTER,
  },
];
const EXAMPLE_ROTATION_MS = 7000;

export function LandingPage({
  onCreateFighter,
  onOpenArcade,
  onOpenWatchMode,
  onOpenCommunity,
  userImageUrl = null,
}: LandingPageProps) {
  // Both stock stories always rotate; a signed-in visitor's own photo joins
  // the loop as the third stop, with the fighter panel as the locked tease.
  const entries = [
    ...LANDING_STORIES.map((story) => ({ ...story, isYou: false })),
    ...(userImageUrl
      ? [{
        id: 'you',
        name: 'You',
        photo: userImageUrl,
        fighter: LANDING_STORIES[0].fighter,
        fightVideo: null,
        fightPoster: LANDING_STORIES[0].fightPoster,
        isYou: true,
      }]
      : []),
  ];
  const [exampleIndex, setExampleIndex] = useState(0);
  useEffect(() => {
    if (entries.length < 2) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(
      () => setExampleIndex((index) => (index + 1) % entries.length),
      EXAMPLE_ROTATION_MS,
    );
    return () => window.clearInterval(timer);
  }, [entries.length]);
  const example = entries[exampleIndex % entries.length] ?? entries[0];
  const isYou = example.isYou;
  return (
    <div className="landing-page">
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-hero__intro">
          <h1 id="landing-title">Insert Player</h1>
          <p>
            Turn one photo into a fighter you can actually play. Build your roster,
            enter the arcade, and keep every version across devices.
          </p>
        </div>
        <div className="landing-triptych">
          <button
            type="button"
            className="landing-panel landing-panel--photo"
            onClick={onCreateFighter}
            aria-label="Create your fighter from a photo"
          >
            <span className="landing-panel__chip" aria-hidden="true">Your photo</span>
            <img
              key={example.photo}
              className={isYou ? 'landing-panel__avatar landing-panel__media' : 'landing-panel__media'}
              src={example.photo}
              alt=""
              fetchPriority="high"
            />
            <span className="landing-panel__cta">
              {isYou ? <>That&apos;s you &#9654;</> : <>Create yours &#9654;</>}
            </span>
          </button>
          <span className="landing-triptych__arrow" aria-hidden="true">&#9654;</span>
          <button
            type="button"
            className={isYou
              ? 'landing-panel landing-panel--fighter is-mystery'
              : 'landing-panel landing-panel--fighter'}
            onClick={isYou ? onCreateFighter : onOpenCommunity}
            aria-label={isYou
              ? 'Build your fighter from your photo'
              : 'Browse fighters the community has created'}
          >
            <span className="landing-panel__chip" aria-hidden="true">Your fighter</span>
            <img
              key={example.fighter + (isYou ? '-you' : '')}
              className="landing-panel__media"
              src={example.fighter}
              alt=""
            />
            {isYou ? (
              <span className="landing-panel__mystery" aria-hidden="true">?</span>
            ) : null}
            <span className="landing-panel__cta">
              {isYou ? <>Build it &#9654;</> : <>See fighters &#9654;</>}
            </span>
          </button>
          <span className="landing-triptych__arrow" aria-hidden="true">&#9654;</span>
          <button
            type="button"
            className={isYou
              ? 'landing-panel landing-panel--fight is-mystery'
              : 'landing-panel landing-panel--fight'}
            onClick={isYou ? onCreateFighter : onOpenArcade}
            aria-label={isYou ? 'Create your fighter to unlock your fight' : `Play as ${example.name}`}
          >
            <span className="landing-panel__chip" aria-hidden="true">Your fight</span>
            {example.fightVideo ? (
              <video
                key={example.fightVideo}
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                poster={example.fightPoster}
                aria-label={`Silent looping clip of ${example.name} in real Insert Player gameplay`}
              >
                <source src={example.fightVideo} type="video/mp4" />
              </video>
            ) : (
              <img src={example.fightPoster} alt="" />
            )}
            {isYou ? (
              <span className="landing-panel__mystery" aria-hidden="true">?</span>
            ) : null}
            <span className="landing-panel__cta">
              {isYou ? <>Unlock it &#9654;</> : <>Play now &#9654;</>}
            </span>
          </button>
        </div>
        <div className="landing-hero__copy">
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
        <div className="landing-proof__media">
          <div className="landing-film">
            <video
              className="landing-film__video"
              autoPlay
              muted
              loop
              playsInline
              preload="none"
              aria-label="Eight real Insert Player matches featuring two personal fighters and four global opponents"
            >
              <source src={GAMEPLAY_REEL_VIDEO} type="video/mp4" />
              <img
                src={GAMEPLAY_REEL_GIF}
                alt="Eight real Insert Player matches featuring two personal fighters and four global opponents"
                loading="lazy"
              />
            </video>
            <div className="landing-film__meta">
              <span>8-match reel</span>
              <span>Real gameplay</span>
            </div>
          </div>
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
              <span>Launch film</span>
              <span>Sound on</span>
            </div>
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
