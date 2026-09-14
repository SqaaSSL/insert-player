import { useEffect } from 'react';
import { CombatMovePreview } from './CombatMovePreview.tsx';

/** A cabinet start button, with time to inspect the live controls below it. */
export function CombatStartReady({ mode, playerName, photoHash, onStart }: {
  mode: 'fight' | 'rush';
  playerName: string;
  photoHash?: string;
  onStart: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'Enter' || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable], button, a')) return;
      event.preventDefault();
      onStart();
    };
    const heldStarts = new Set<number>();
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (pad?.buttons[9]?.pressed) heldStarts.add(pad.index);
    }
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      for (const pad of navigator.getGamepads?.() ?? []) {
        if (!pad) continue;
        const down = Boolean(pad.buttons[9]?.pressed);
        if (down && !heldStarts.has(pad.index)) {
          heldStarts.add(pad.index);
          onStart();
          return;
        }
        if (!down) heldStarts.delete(pad.index);
      }
    }, 50);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.clearInterval(timer);
    };
  }, [onStart]);

  return <section className="combat-start" aria-label={`Start ${mode === 'rush' ? 'Rush' : 'Fight'}`}>
    {photoHash && <CombatMovePreview key={photoHash} photoHash={photoHash} mode={mode} />}
    <div className="combat-start__copy">
      <p className="combat-start__player">You are {playerName}</p>
      <h2>Ready when you are.</h2>
      <p>Try the controls below. They light up as you press.</p>
    </div>
    <div className="combat-start__actions">
      <button type="button" className="asf-btn asf-btn--primary" onClick={onStart}>
        {mode === 'rush' ? 'Start Rush' : 'Start Fight'}
      </button>
      <small>Enter / controller Start</small>
    </div>
  </section>;
}
