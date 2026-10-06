import type { FighterGameMode } from '../../services/FighterAssetPacks.ts';
import type { OnboardingStatus } from '../../services/Crews.ts';
import { Button } from '../components/Button.tsx';
import { HomeHero } from '../components/LaunchFilm.tsx';
import { GAME_ENTRY_CONTENT, GameEntryPlayButton, GameEntryPreview, type PlayGameHandler } from './GameLandingPage.tsx';
import './product-entry.css';

export interface PlayPageProps {
  onPlay: PlayGameHandler;
  onChooseCharacter?: () => void;
  onExplore: (mode: FighterGameMode) => void;
  onOpenCharacters: () => void;
  onOpenChallenges: () => void;
  lastGame?: FighterGameMode | null;
  onboardingStatus?: OnboardingStatus | null;
  onContinueOnboarding?: () => void;
  /** Start the debut match directly from the Play page. */
  onPlayDebut?: (photoHash: string, mode: 'aura' | 'fight') => void;
  /** The first run, optionally with a game already chosen. Used while it is unfinished. */
  onTry?: (mode?: FighterGameMode) => void;
}

export function nextMissionTitle(status: Pick<OnboardingStatus, 'fighter' | 'debutComplete' | 'recommendedStep'>): string {
  if (!status.fighter) return 'Create your own Rookie';
  if (!status.debutComplete) return 'Make your debut';
  if (status.recommendedStep === 'invite') return 'Bring in Player Two';
  if (status.recommendedStep === 'stage') return 'Choose your Crew’s home stage';
  return 'Build your Crew';
}

/** Play: Aura and Fight share the top row as equals; Rush stays available below. */
export function PlayPage({ onPlay, onExplore, onOpenCharacters, onOpenChallenges, onChooseCharacter, lastGame = null, onboardingStatus, onContinueOnboarding, onPlayDebut, onTry }: PlayPageProps) {
  const firstRunOpen = Boolean(onTry) && !onboardingStatus?.complete;
  const pickGame: PlayGameHandler = (mode) => firstRunOpen && mode !== 'rush' ? onTry!(mode) : onPlay(mode);
  return (
    <div className="product-entry product-entry--play">
      <HomeHero ctaLabel={firstRunOpen ? (onboardingStatus ? 'Continue my first run' : 'Try it free') : undefined}
        onCta={firstRunOpen ? () => onTry!() : undefined}>
        {lastGame ? <button type="button" className="product-entry__text-link" onClick={() => onPlay(lastGame)}>Continue {GAME_ENTRY_CONTENT[lastGame].name} →</button> : null}
      </HomeHero>

      {onboardingStatus?.fighter && !onboardingStatus.debutComplete && onPlayDebut ? (
        <section className="gallery-panel play-debut-card" aria-label="Next mission">
          <p className="product-entry__genre">Next mission · your debut</p>
          <h2>{onboardingStatus.fighter.name} is ready</h2>
          <p>Play one match as {onboardingStatus.fighter.name} to finish your debut.</p>
          <div className="play-debut-card__actions">
            <Button variant="primary" onClick={() => onPlayDebut(onboardingStatus.fighter!.photoHash, 'aura')}>Debut in Aura</Button>
            <Button onClick={() => onPlayDebut(onboardingStatus.fighter!.photoHash, 'fight')}>Debut in Fight</Button>
          </div>
          {onContinueOnboarding ? (
            <button type="button" className="product-entry__text-link" onClick={onContinueOnboarding}>See my first run →</button>
          ) : null}
        </section>
      ) : onboardingStatus && !onboardingStatus.complete && onContinueOnboarding ? (
        <section className="gallery-panel" aria-label="Next mission">
          <p className="product-entry__genre">Next mission</p>
          <h2>{nextMissionTitle(onboardingStatus)}</h2>
          <p>Pick up where you left off. Your progress is saved.</p>
          <Button onClick={onContinueOnboarding}>Continue My First Run</Button>
        </section>
      ) : null}

      <section className="product-entry__duo" aria-label="Choose your game">
        {(['aura', 'fight'] as const).map((mode) => (
          <article className={`product-entry__duo-card product-entry__duo-card--${mode}`} key={mode} aria-labelledby={`play-${mode}-title`}>
            <div className="product-entry__duo-art"><GameEntryPreview mode={mode} compact /></div>
            <div className="product-entry__duo-copy">
              <h2 id={`play-${mode}-title`}>{GAME_ENTRY_CONTENT[mode].name}</h2>
              <p className="product-entry__promise">{mode === 'aura' ? 'Hit the beat. Win the crowd.' : 'Face a rival. Take the round.'}</p>
              <GameEntryPlayButton mode={mode} onPlay={pickGame} />
              <p className="product-entry__play-hint">{GAME_ENTRY_CONTENT[mode].playHint}</p>
              <div className="product-entry__duo-links">
                {mode === 'aura' && onChooseCharacter ? <button className="product-entry__text-link" type="button" onClick={onChooseCharacter}>Choose a character</button> : null}
                <button className="product-entry__text-link" type="button" onClick={() => onExplore(mode)}>Explore {GAME_ENTRY_CONTENT[mode].name} →</button>
              </div>
            </div>
          </article>
        ))}
      </section>

      <section className="product-entry__game-list" aria-label="More games">
        <article className="product-entry__game-row">
          <GameEntryPreview mode="rush" compact />
          <div className="product-entry__game-row-copy">
            <h2>{GAME_ENTRY_CONTENT.rush.name}</h2>
            <p>Clear the street with a CPU ally.</p>
            <button className="product-entry__text-link" type="button" onClick={() => onExplore('rush')}>Explore {GAME_ENTRY_CONTENT.rush.name} →</button>
          </div>
          <GameEntryPlayButton mode="rush" onPlay={onPlay} />
        </article>
      </section>


      <nav className="product-entry__collection" aria-label="Your Insert Player collection">
        <p>Your characters and rivals, all in one place.</p>
        <button className="product-entry__text-link" type="button" onClick={onOpenCharacters}>My characters →</button>
        <button className="product-entry__text-link" type="button" onClick={onOpenChallenges}>Challenges →</button>
      </nav>
    </div>
  );
}
