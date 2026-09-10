import { useState } from 'react';
import type { FighterGameMode } from '../../services/FighterAssetPacks.ts';
import { quoteGenerationPackage } from '../../services/GenerationPackages.ts';
import { Button } from '../components/Button.tsx';
import { AuraEntryPreview } from '../components/AuraEntryPreview.tsx';
import { CombatEntryPreview } from '../components/CombatEntryPreview.tsx';
import './product-entry.css';

export type PlayGameHandler = (mode: FighterGameMode) => void | Promise<void>;

export const GAME_ENTRY_CONTENT = {
  aura: {
    name: 'Aura',
    genre: 'A rhythm duel starring you',
    promise: 'Farm Aura. Win the crowd.',
    description: 'Hit the notes. Nail the moves. Take more Aura than your rival. Play a free battle, then turn your photo into the main character.',
    playLabel: 'Play my first battle',
    playHint: 'Free to play · no account or photo · learn in the battle',
    personal: 'Next round, make it you.',
    personalDescription: 'Start with Rookie Aura: one photo, your name, six performance moves. Your first Rookie is included with your account. Then take your character straight into a duel.',
    previewCaption: 'Take turns. Hit the beat. The higher Aura wins.',
  },
  fight: {
    name: 'Fight',
    genre: 'One-on-one combat',
    promise: 'Your character. Your corner.',
    description: 'Face a rival, find your opening, and take the round. Try a match before building a fighter from your own photo.',
    playLabel: 'Play Fight',
    playHint: 'Start with a ready-made fighter.',
    personal: 'Step into your own fight.',
    personalDescription: 'Create your fighter once. The same character can clear Rush with a CPU ally and join Aura with compatible moves.',
    previewCaption: 'Fight preview from the Insert Player roster.',
  },
  rush: {
    name: 'Rush',
    genre: 'Side-scrolling action · Beta',
    promise: 'Take the street together.',
    description: 'Move through Side Street, clear enemy groups, and break through obstacles with a CPU ally at your side.',
    playLabel: 'Play Rush',
    playHint: 'You + a CPU ally. Ready-made fighters included.',
    personal: 'Bring your character along.',
    personalDescription: 'Your Fight character is ready for Rush too. Create one from a photo and take the same identity into both games.',
    previewCaption: 'Rush preview: one player teams up with a CPU ally.',
  },
} as const;

/** Existing product art and animation. Previews never download the Phaser runtime. */
export function GameEntryPreview({ mode, compact = false }: { mode: FighterGameMode; compact?: boolean }) {
  if (mode === 'aura') {
    return <AuraEntryPreview compact={compact} />;
  }
  return <CombatEntryPreview key={mode} mode={mode} compact={compact} />;
}

export function GameEntryPlayButton({ mode, onPlay, label }: { mode: FighterGameMode; onPlay: PlayGameHandler; label?: string }) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function play() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      await onPlay(mode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The game could not start. Please try again.');
    } finally {
      setStarting(false);
    }
  }
  return (
    <div className="product-entry__play-action">
      <Button variant="primary" size="lg" onClick={() => void play()} disabled={starting} aria-busy={starting}>
        {starting ? 'Starting game…' : label ?? GAME_ENTRY_CONTENT[mode].playLabel}
        {!starting && <span aria-hidden="true">↗</span>}
      </Button>
      {error && <p className="product-entry__error" role="alert">{error}</p>}
    </div>
  );
}

export interface GameLandingPageProps {
  mode: FighterGameMode;
  onPlay: PlayGameHandler;
  onCreate: (mode: FighterGameMode) => void;
  onExplore: (mode: FighterGameMode) => void;
  onOpenCharacters: () => void;
  onOpenCredits: () => void;
  onBack?: () => void;
  onLocalVersus?: () => void;
  onOnlineVersus?: () => void;
  onWatch?: () => void;
}

export function GameLandingPage({ mode, onPlay, onCreate, onExplore, onOpenCharacters, onOpenCredits, onBack, onLocalVersus, onOnlineVersus, onWatch }: GameLandingPageProps) {
  const content = GAME_ENTRY_CONTENT[mode];
  const rookieQuote = quoteGenerationPackage('rookie', 'aura');
  const auraQuote = quoteGenerationPackage('contender', 'aura');
  const completeQuote = quoteGenerationPackage('contender', 'complete');
  const otherModes = (['aura', 'fight', 'rush'] as const).filter((game) => game !== mode);
  return (
    <div className={`product-entry product-entry--${mode}`}>
      {onBack && <button className="product-entry__text-link product-entry__back" type="button" onClick={onBack}>← All games</button>}

      <section className="product-entry__hero" aria-labelledby="game-entry-title">
        <div className="product-entry__hero-copy">
          <p className="product-entry__genre">{content.genre}</p>
          <h1 id="game-entry-title">{content.name}</h1>
          <p className="product-entry__promise">{content.promise}</p>
          <p className="product-entry__description">{content.description}</p>
          <GameEntryPlayButton key={mode} mode={mode} onPlay={onPlay} />
          <p className="product-entry__play-hint">{content.playHint}</p>
          <button className="product-entry__text-link" type="button" onClick={() => onCreate(mode)}>{mode === 'aura' ? 'Create my Rookie Aura' : 'Create my character'}</button>
        </div>
        <figure className="product-entry__hero-art">
          <GameEntryPreview mode={mode} />
          <figcaption>{content.previewCaption}</figcaption>
        </figure>
      </section>

      {mode === 'aura' && <ol className="product-entry__first-run" aria-label="Your first Aura run">
        <li><strong>Play a battle</strong><span>Catch four notes to learn. Then the duel is on.</span></li>
        <li><strong>Make it personal</strong><span>One photo becomes your Rookie Aura.</span></li>
        <li><strong>Settle it with a friend</strong><span>Send your score. Same track, same notes, their turn.</span></li>
      </ol>}

      {mode !== 'rush' && (onLocalVersus || onOnlineVersus || onWatch) && (
        <nav className="product-entry__variants" aria-label={`${content.name} play options`}>
          {onLocalVersus && <button className="product-entry__text-link" type="button" onClick={onLocalVersus}>Play local versus</button>}
          {onOnlineVersus && <button className="product-entry__text-link" type="button" onClick={onOnlineVersus}>Play online · Beta</button>}
          {onWatch && <button className="product-entry__text-link" type="button" onClick={onWatch}>Watch {content.name}</button>}
        </nav>
      )}

      <section className="product-entry__identity" aria-labelledby="game-personal-title">
        <div className="product-entry__identity-copy">
          <h2 id="game-personal-title">{content.personal}</h2>
          <p>{content.personalDescription}</p>
          {mode === 'aura' && <Button variant="primary" onClick={() => onCreate('aura')}>Create my Rookie Aura</Button>}
          <button className="product-entry__text-link" type="button" onClick={onOpenCharacters}>Open my characters →</button>
        </div>
        <div className="product-entry__pricing">
          <p className="product-entry__pricing-context">{mode === 'aura' ? 'Start Rookie. Upgrade when you want.' : 'Create at Contender quality'}</p>
          <dl>
            {mode === 'aura' && <div>
              <dt>Rookie Aura <span>First Rookie included with your account</span></dt>
              <dd>{rookieQuote.priceLabel}<small>after your first Rookie</small></dd>
            </div>}
            <div>
              <dt>{mode === 'aura' ? 'Contender Aura' : 'Aura'} <span>Six dedicated performance moves</span></dt>
              <dd>{auraQuote.priceLabel}</dd>
            </div>
            <div>
              <dt>Fight + Rush <span>{mode === 'aura' ? 'Contender · ' : ''}Combat moves for both games</span></dt>
              <dd>{completeQuote.priceLabel}</dd>
            </div>
          </dl>
          <p className="product-entry__pricing-note">Aura includes its six performance moves. Fight + Rush is a separate pack. You see the exact cost before creating.</p>
          <button className="product-entry__text-link" type="button" onClick={onOpenCredits}>View credit packs →</button>
        </div>
      </section>

      <nav className="product-entry__other-games" aria-label="Other Insert Player games">
        <span>One identity. More ways to play.</span>
        {otherModes.map((game) => <button key={game} className="product-entry__text-link" type="button" onClick={() => onExplore(game)}>Explore {GAME_ENTRY_CONTENT[game].name} →</button>)}
      </nav>
    </div>
  );
}
