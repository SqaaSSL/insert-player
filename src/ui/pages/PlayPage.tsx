import type { FighterGameMode } from '../../services/FighterAssetPacks.ts';
import { GAME_ENTRY_CONTENT, GameEntryPlayButton, GameEntryPreview, AuraRosterButton, type PlayGameHandler } from './GameLandingPage.tsx';
import './product-entry.css';

export interface PlayPageProps {
  onPlay: PlayGameHandler;
  onChooseCharacter?: () => void;
  onExplore: (mode: FighterGameMode) => void;
  onOpenCharacters: () => void;
  onOpenChallenges: () => void;
  lastGame?: FighterGameMode | null;
}

export function PlayPage({ onPlay, onExplore, onOpenCharacters, onOpenChallenges, onChooseCharacter, lastGame = null }: PlayPageProps) {
  return (
    <div className="product-entry product-entry--play">
      <header className="product-entry__page-heading">
        <h1>Play</h1>
        {lastGame && <button type="button" className="product-entry__text-link" onClick={() => onPlay(lastGame)}>Continue {GAME_ENTRY_CONTENT[lastGame].name} →</button>}
      </header>

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

      <nav className="product-entry__collection" aria-label="Your Insert Player collection">
        <p>Your characters and rivals, all in one place.</p>
        <button className="product-entry__text-link" type="button" onClick={onOpenCharacters}>My characters →</button>
        <button className="product-entry__text-link" type="button" onClick={onOpenChallenges}>Challenges →</button>
      </nav>
    </div>
  );
}
