import { useRef, useState } from 'react';
import { Button } from './Button.tsx';
import { StatusMessage } from './StatusMessage.tsx';
import { GameplayEntryPreview } from './GameplayEntryPreview.tsx';
import './trial-game-choice.css';

export type TrialGameMode = 'aura' | 'fight';

export const TRIAL_GAME_CONTENT: Record<TrialGameMode, { name: string; genre: string; blurb: string; playLabel: string }> = {
  aura: {
    name: 'Aura',
    genre: 'Rhythm duel',
    blurb: 'Hit the beat on four lanes. Outscore your rival.',
    playLabel: 'Try Aura',
  },
  fight: {
    name: 'Fight',
    genre: 'One-on-one combat',
    blurb: 'Take on the computer in a 1-on-1 fight.',
    playLabel: 'Try Fight',
  },
};

interface TrialGameChoiceProps {
  onPlay: (mode: TrialGameMode) => void | Promise<void>;
  /** Shows a real gameplay preview per game so the choice is a picture, not a label. */
  showPreviews?: boolean;
  /** Offers a way past the demo. Nothing about the demo is required. */
  onSkip?: () => void;
  skipLabel?: string;
  intro?: string | null;
}

/** The first solo trial uses ready-made characters and needs no account. */
export function TrialGameChoice({
  onPlay,
  showPreviews = false,
  onSkip,
  skipLabel = 'Skip the demo · Create my character',
  intro = 'Try first · choose your game',
}: TrialGameChoiceProps) {
  const launching = useRef(false);
  const [pending, setPending] = useState<TrialGameMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const play = async (mode: TrialGameMode) => {
    if (launching.current) return;
    launching.current = true;
    setPending(mode);
    setError(null);
    try {
      await onPlay(mode);
    } catch {
      setError('The game could not start. Please try again.');
    } finally {
      launching.current = false;
      setPending(null);
    }
  };

  return (
    <div className={`trial-game-choice${showPreviews ? ' trial-game-choice--cards' : ''}`} role="group" aria-label="Try first">
      {intro ? <p className="trial-game-choice__intro">{intro}</p> : null}
      <div className="trial-game-choice__options">
        {(['aura', 'fight'] as const).map((mode) => {
          const content = TRIAL_GAME_CONTENT[mode];
          return (
            <div key={mode} className="trial-game-choice__option">
              {showPreviews ? (
                <div className="trial-game-choice__preview">
                  <GameplayEntryPreview mode={mode} compact />
                  <span className="trial-game-choice__genre">{content.genre}</span>
                </div>
              ) : null}
              <Button variant="primary" size="lg" disabled={pending !== null} onClick={() => void play(mode)}>
                {content.playLabel}
              </Button>
              <p>{content.blurb}</p>
            </div>
          );
        })}
      </div>
      <p className="trial-game-choice__hint" role="status">
        {pending ? `Preparing ${TRIAL_GAME_CONTENT[pending].name}…` : 'Play solo for free with ready-made characters. No account needed.'}
      </p>
      {error ? <StatusMessage severity="error">{error}</StatusMessage> : null}
      {onSkip ? (
        <button type="button" className="trial-game-choice__skip" disabled={pending !== null} onClick={onSkip}>
          {skipLabel}
        </button>
      ) : null}
    </div>
  );
}
