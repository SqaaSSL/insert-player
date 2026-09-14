import { Modal } from './Modal.tsx';

interface AuraStartReadyProps {
  playerName: string;
  rivalName: string;
  practiceAvailable: boolean;
  practiceRecommended?: boolean;
  onStart: (practice: boolean) => void;
  onExit: () => void;
  busy?: boolean;
}

export function AuraStartReady({ playerName, rivalName, practiceAvailable, practiceRecommended = true, onStart, onExit, busy = false }: AuraStartReadyProps) {
  const practiceFirst = practiceAvailable && practiceRecommended;
  const start = (practice: boolean) => {
    if (!busy) onStart(practice);
  };
  const exit = () => {
    if (!busy) onExit();
  };

  return <Modal title={practiceFirst ? 'Learn Aura in 4 notes' : 'Ready for your Aura duel?'} onClose={exit} busy={busy} showClose={false}>
    <section className="aura-start-ready" aria-label="Start your Aura duel" aria-busy={busy}>
      <p className="aura-start-ready__identity">
        Play as <strong>{playerName}</strong>
        <span>vs {rivalName}</span>
      </p>
      <div className="aura-start-ready__instruction">
        <p>Hit the notes when they reach the line.</p>
        <p>{practiceFirst ? 'Four practice hits, then your duel.' : 'Take turns. More Aura wins.'}</p>
      </div>
      <div className="aura-start-ready__actions">
        <button type="button" className="asf-btn aura-start-ready__primary" disabled={busy} onClick={() => start(practiceFirst)}>
          {busy ? 'Starting…' : practiceFirst ? 'Practice 4 notes' : 'Start duel'}
        </button>
        <div className="aura-start-ready__secondary-actions">
          {practiceAvailable && <button type="button" className="aura-start-ready__skip" disabled={busy} onClick={() => start(!practiceFirst)}>
            {practiceFirst ? 'Start duel' : 'Practice 4 notes'}
          </button>}
          <button type="button" className="aura-start-ready__back" disabled={busy} onClick={exit}>Back</button>
        </div>
      </div>
    </section>
  </Modal>;
}
