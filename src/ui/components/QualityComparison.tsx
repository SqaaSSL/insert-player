import { useState } from 'react';
import './quality-comparison.css';

const EXAMPLES = [
  { id: 'rookie', label: 'Rookie', description: 'Basic definition', file: 'nova-rookie-idle.png' },
  { id: 'contender', label: 'Champion', description: 'Individually refined frames', file: 'nova-contender-idle.png' },
] as const;

/** View the same first frame from two preserved generation runs, without altering either image. */
export function QualityComparison() {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <details className="quality-comparison" onToggle={(event) => {
      setOpen(event.currentTarget.open);
      if (!event.currentTarget.open) setFailed(false);
    }}>
      <summary>See Rookie vs Champion <span>Same character, two qualities</span></summary>
      {open ? <div className="quality-comparison__content">
        <div className="quality-comparison__intro">
          <div>
            <h3>A closer look</h3>
            <p>Champion refines each frame separately for more detail in your face, hair and clothes.</p>
          </div>
          <div className="quality-comparison__switch" role="group" aria-label="Comparison view">
            <button type="button" aria-pressed={!detail} onClick={() => setDetail(false)}>Full character</button>
            <button type="button" aria-pressed={detail} onClick={() => setDetail(true)}>Face detail</button>
          </div>
        </div>
        {failed ? <p role="status">The comparison images couldn’t load. Close and reopen this comparison to try again.</p>
          : <div className={`quality-comparison__pair${detail ? ' is-detail' : ''}`}>
            {EXAMPLES.map((example) => <figure key={example.id}>
              <figcaption><strong>{example.label}</strong><span>{example.description}</span></figcaption>
              <svg
                viewBox={detail ? '240 80 280 280' : '0 0 768 1024'}
                role="img"
                aria-label={`Nova in ${example.label} quality, ${detail ? 'face detail' : 'full character'}`}
              >
                <image href={`/assets/quality/${example.file}`} width="3072" height="2048" onError={() => setFailed(true)} />
              </svg>
            </figure>)}
          </div>}
        <p className="quality-comparison__caption">Two real generations of Nova, our synthetic demo character, shown at the same scale. Saved Fight example; Aura uses the same quality steps. Results vary with your photo.</p>
      </div> : null}
    </details>
  );
}
