import type { FighterGameMode } from '../../services/FighterAssetPacks.ts';
import { LaunchFilm } from '../components/LaunchFilm.tsx';
import { TrialGameChoice, type TrialGameMode } from '../components/TrialGameChoice.tsx';
import './product-entry.css';

export interface FirstRunPageProps {
  /** Starts the free solo demo of the chosen game with ready-made characters. */
  onPlay: (mode: TrialGameMode) => void | Promise<void>;
  /** Goes straight to character creation without playing a demo. */
  onSkip: () => void;
  onExplore: (mode: FighterGameMode) => void;
  onSignIn?: () => void;
}

/**
 * First visit: Aura and Fight side by side, a free demo of either, or skip
 * straight to creating a character. Game-specific landings stay at /games/*.
 */
export function FirstRunPage({ onPlay, onSkip, onExplore, onSignIn }: FirstRunPageProps) {
  return (
    <div className="product-entry product-entry--first-run">
      <section className="first-run__hero" aria-labelledby="first-run-title">
        <p className="product-entry__genre">Insert Player</p>
        <h1 id="first-run-title">Turn one photo into a playable character.</h1>
        <p className="product-entry__promise">
          Pick a game and play a free demo with ready-made characters. Then insert yourself:
          one photo becomes your character for Aura, Fight and Rush.
        </p>
        <TrialGameChoice showPreviews intro="Step 1 · Pick your game" onPlay={onPlay} onSkip={onSkip} />
      </section>

      <nav className="product-entry__other-games" aria-label="Learn more">
        <span>Want the details first?</span>
        <button className="product-entry__text-link" type="button" onClick={() => onExplore('aura')}>Explore Aura →</button>
        <button className="product-entry__text-link" type="button" onClick={() => onExplore('fight')}>Explore Fight →</button>
        <button className="product-entry__text-link" type="button" onClick={() => onExplore('rush')}>Rush · Beta →</button>
        {onSignIn ? <button className="product-entry__text-link" type="button" onClick={onSignIn}>Already a player? Sign in</button> : null}
      </nav>

      <LaunchFilm />
    </div>
  );
}
