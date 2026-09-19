import type { FighterGameMode } from '../../services/FighterAssetPacks.ts';
import type { OnboardingStatus } from '../../services/Crews.ts';
import { Button } from '../components/Button.tsx';
import { LaunchFilm } from '../components/LaunchFilm.tsx';
import { GAME_ENTRY_CONTENT, GameEntryPlayButton, GameEntryPreview, AuraRosterButton, type PlayGameHandler } from './GameLandingPage.tsx';
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
}

export function PlayPage({ onPlay, onExplore, onOpenCharacters, onOpenChallenges, onChooseCharacter, lastGame = null, onboardingStatus, onContinueOnboarding }: PlayPageProps) {
  return (
    <div className="product-entry product-entry--play">
      <header className="product-entry__page-heading">
        <h1>Play</h1>
        {lastGame && <button type="button" className="product-entry__text-link" onClick={() => onPlay(lastGame)}>Continue {GAME_ENTRY_CONTENT[lastGame].name} →</button>}
      </header>

      {onboardingStatus && !onboardingStatus.complete && onContinueOnboarding ? (
        <section className="gallery-panel" aria-label="Next Aura mission">
          <p className="product-entry__genre">Next mission</p>
          <h2>{!onboardingStatus.fighter ? 'Create your own Rookie' : !onboardingStatus.debutComplete ? 'Make your Aura debut' : onboardingStatus.recommendedStep === 'invite' ? 'Bring in Player Two' : onboardingStatus.recommendedStep === 'stage' ? 'Choose your Crew’s home stage' : 'Build your Crew'}</h2>
          <p>Pick up where you left off. Your progress is saved.</p>
          <Button onClick={onContinueOnboarding}>Continue My First Run</Button>
        </section>
      ) : null}

      <section className="product-entry__hero product-entry__hero--gameplay-first" aria-labelledby="play-aura-title">
        <header className="product-entry__hero-copy">
          <h2 id="play-aura-title">Aura</h2>
          <p className="product-entry__promise">Hit the beat. Win the crowd.</p>
        </header>
        <div className="product-entry__hero-art"><GameEntryPreview mode="aura" /></div>
        <div className="product-entry__hero-actions">
          <GameEntryPlayButton mode="aura" onPlay={onPlay} label="Play Aura" />
          <p className="product-entry__play-hint">{GAME_ENTRY_CONTENT.aura.playHint}</p>
          {onChooseCharacter ? <AuraRosterButton onChoose={onChooseCharacter} /> : null}
          <button className="product-entry__text-link" type="button" onClick={() => onExplore('aura')}>Meet Aura →</button>
        </div>
      </section>

      <section className="product-entry__game-list" aria-label="More games">
        {(['fight', 'rush'] as const).map((mode) => (
          <article className="product-entry__game-row" key={mode}>
            <GameEntryPreview mode={mode} compact />
            <div className="product-entry__game-row-copy">
              <h2>{GAME_ENTRY_CONTENT[mode].name}</h2>
              <p>{mode === 'fight' ? 'Face a rival. Take the round.' : 'Clear the street with a CPU ally.'}</p>
              <button className="product-entry__text-link" type="button" onClick={() => onExplore(mode)}>Explore {GAME_ENTRY_CONTENT[mode].name} →</button>
            </div>
            <GameEntryPlayButton mode={mode} onPlay={onPlay} />
          </article>
        ))}
      </section>

      <LaunchFilm />

      <nav className="product-entry__collection" aria-label="Your Insert Player collection">
        <p>Your characters and rivals, all in one place.</p>
        <button className="product-entry__text-link" type="button" onClick={onOpenCharacters}>My characters →</button>
        <button className="product-entry__text-link" type="button" onClick={onOpenChallenges}>Challenges →</button>
      </nav>
    </div>
  );
}
