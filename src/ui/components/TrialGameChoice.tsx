import { useRef, useState } from 'react';
import { Button } from './Button.tsx';
import { StatusMessage } from './StatusMessage.tsx';
import './trial-game-choice.css';

export type TrialGameMode = 'aura' | 'fight';

interface TrialGameChoiceProps {
  onPlay: (mode: TrialGameMode) => void | Promise<void>;
}

/** The first solo trial uses ready-made characters and needs no account. */
export function TrialGameChoice({ onPlay }: TrialGameChoiceProps) {
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
    <div className="trial-game-choice" role="group" aria-label="Try first">
      <p className="trial-game-choice__intro">Try first · choose your game</p>
      <div className="trial-game-choice__options">
        <div>
          <Button variant="primary" size="lg" disabled={pending !== null} onClick={() => void play('aura')}>
            Try Aura
          </Button>
          <p>Hit the beat in a rhythm battle.</p>
        </div>
        <div>
          <Button variant="primary" size="lg" disabled={pending !== null} onClick={() => void play('fight')}>
            Try Fight
          </Button>
          <p>Take on the computer in a 1-on-1 fight.</p>
        </div>
      </div>
      <p className="trial-game-choice__hint" role="status">
        {pending ? `Preparing ${pending === 'aura' ? 'Aura' : 'Fight'}…` : 'Play solo for free with ready-made characters.'}
      </p>
      {error ? <StatusMessage severity="error">{error}</StatusMessage> : null}
    </div>
  );
}
