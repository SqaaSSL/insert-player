import type { FighterGameMode } from '../../services/FighterAssetPacks.ts';
import { HomeHero } from '../components/LaunchFilm.tsx';
import { TrialGameChoice, type TrialGameMode } from '../components/TrialGameChoice.tsx';
import './product-entry.css';

export interface FirstRunPageProps {
  /** Starts the free solo demo of the chosen game with ready-made characters. */
  onPlay: (mode: TrialGameMode) => void | Promise<void>;
  /** Goes straight to character creation without playing a demo. */
  onSkip: () => void;
  onExplore: (mode: FighterGameMode) => void;
  onSignIn?: () => void;
  /** The first run, optionally with a game already chosen. */
  onTry?: (mode?: TrialGameMode) => void;
}

/**
 * First visit: Aura and Fight side by side, a free demo of either, or skip
 * straight to creating a character. Game-specific landings stay at /games/*.
 */
export function FirstRunPage({ onPlay, onSkip, onExplore, onSignIn, onTry }: FirstRunPageProps) {
  return (
    <div className="product-entry product-entry--first-run">
      <HomeHero ctaLabel={onTry ? 'Try it free' : undefined} onCta={onTry ? () => onTry() : undefined} />
      <section className="first-run__hero" aria-label="Pick a game">
        <TrialGameChoice showPreviews intro="Or pick a game" onPlay={onTry ? (mode) => onTry(mode) : onPlay} onSkip={onSkip} />
      </section>

      <nav className="product-entry__other-games" aria-label="Learn more">
        <span>Want the details first?</span>
        <button className="product-entry__text-link" type="button" onClick={() => onExplore('aura')}>Explore Aura →</button>
        <button className="product-entry__text-link" type="button" onClick={() => onExplore('fight')}>Explore Fight →</button>
        <button className="product-entry__text-link" type="button" onClick={() => onExplore('rush')}>Rush · Beta →</button>
        {onSignIn ? <button className="product-entry__text-link" type="button" onClick={onSignIn}>Already a player? Sign in</button> : null}
      </nav>

    </div>
  );
}
