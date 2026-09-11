interface AuraStartReadyProps {
  playerName: string;
  rivalName: string;
  practiceAvailable: boolean;
  practiceRecommended?: boolean;
  onStart: (practice: boolean) => void;
  busy?: boolean;
}

export function AuraStartReady({ playerName, rivalName, practiceAvailable, practiceRecommended = true, onStart, busy = false }: AuraStartReadyProps) {
  const practiceFirst = practiceAvailable && practiceRecommended;
  const start = (practice: boolean) => {
    if (!busy) onStart(practice);
  };

  return <section className="aura-start-ready" aria-label="Start your Aura duel" aria-busy={busy}>
    <div className="aura-start-ready__identity">
      <h2>Play as {playerName}</h2>
      <p>vs {rivalName}</p>
    </div>
    <p className="aura-start-ready__instruction">
      {practiceFirst ? 'Four practice hits, then the duel.' : 'Hit the beat. More Aura wins.'}
    </p>
    <div className="aura-start-ready__actions">
      <button type="button" className="asf-btn aura-start-ready__primary" disabled={busy} onClick={() => start(practiceFirst)}>
        {busy ? 'Starting…' : practiceFirst ? 'Practice 4 notes' : 'Start duel'}
      </button>
      {practiceAvailable && <button type="button" className="aura-start-ready__skip" disabled={busy} onClick={() => start(!practiceFirst)}>
        {practiceFirst ? 'Start duel' : 'Practice 4 notes'}
      </button>}
    </div>
  </section>;
}
