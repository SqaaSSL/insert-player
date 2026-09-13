import { useEffect, useRef, useState } from 'react';
import './quality-comparison.css';

const EXAMPLES = [
  { id: 'rookie', label: 'Rookie', description: 'Basic definition' },
  { id: 'contender', label: 'Champion', description: 'Individually refined frames' },
] as const;

const CHARACTERS = [
  { id: 'casual', name: 'Casual', caption: 'Casual, the guy in grey from our launch video. His real Rookie and Champion animations, generated from the same photo.' },
  { id: 'nova', name: 'Nova', caption: 'Two preserved generations of Nova, our synthetic demo character.' },
] as const;

/** Both quality versions share one eight-frame idle playback clock. */
export function QualityComparison() {
  const [open, setOpen] = useState(false);
  const [characterId, setCharacterId] = useState('casual');
  const character = CHARACTERS.find((item) => item.id === characterId) ?? CHARACTERS[0];
  const [detail, setDetail] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState<string[]>([]);
  const [playing, setPlaying] = useState(() => typeof window === 'undefined'
    || !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const [frame, setFrame] = useState(0);
  const pairRef = useRef<HTMLDivElement>(null);
  const ready = loaded.length === EXAMPLES.length;

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => { if (motion.matches) setPlaying(false); };
    motion.addEventListener('change', onMotion);
    return () => motion.removeEventListener('change', onMotion);
  }, []);

  useEffect(() => {
    if (!open || !playing || detail || !ready || failed || !pairRef.current) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    let inView = false;
    const stop = () => { clearInterval(timer); timer = undefined; };
    const update = () => {
      stop();
      if (inView && !document.hidden) {
        // Fight's idle advances every ten simulation ticks, or six frames per second.
        timer = setInterval(() => setFrame((value) => (value + 1) % 8), 1000 / 6);
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      update();
    });
    observer.observe(pairRef.current);
    document.addEventListener('visibilitychange', update);
    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, [open, playing, detail, ready, failed]);

  return (
    <details className="quality-comparison" onToggle={(event) => {
      setOpen(event.currentTarget.open);
      if (!event.currentTarget.open) { setFailed(false); setLoaded([]); setFrame(0); }
    }}>
      <summary>See Rookie vs Champion <span>Same character, two qualities</span></summary>
      {open ? <div className="quality-comparison__content">
        <div className="quality-comparison__intro">
          <div>
            <div className="quality-comparison__heading">
              <h3>A closer look</h3>
              <select aria-label="Example character" value={character.id} onChange={(event) => {
                setCharacterId(event.target.value); setLoaded([]); setFailed(false); setFrame(0);
              }}>
                {CHARACTERS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </div>
            <p>Champion refines each frame separately for more detail in your face, hair and clothes.</p>
          </div>
          <div className="quality-comparison__controls">
            <div className="quality-comparison__switch" role="group" aria-label="Comparison view">
              <button type="button" aria-pressed={!detail} onClick={() => setDetail(false)}>Full character</button>
              <button type="button" aria-pressed={detail} onClick={() => { setDetail(true); setPlaying(false); setFrame(0); }}>Face detail</button>
            </div>
            {!failed ? <button
              type="button"
              className="quality-comparison__playback"
              disabled={!ready}
              onClick={() => { setDetail(false); setPlaying(!playing); }}
            >
              <span aria-hidden="true">{playing && ready ? 'Ⅱ' : '▶'}</span>
              {!ready ? 'Loading animation…' : playing ? 'Pause animation' : 'Play animation'}
            </button> : null}
          </div>
        </div>
        {failed ? <p role="status">The comparison images couldn’t load. Close and reopen this comparison to try again.</p>
          : <div ref={pairRef} className={`quality-comparison__pair${detail ? ' is-detail' : ''}`}>
            {EXAMPLES.map((example) => <figure key={`${character.id}-${example.id}`}>
              <figcaption><strong>{example.label}</strong><span>{example.description}</span></figcaption>
              <svg
                viewBox={detail ? '240 80 280 280' : '0 0 768 1024'}
                role="img"
                aria-label={`${character.name} in ${example.label} quality, ${detail ? 'face detail' : 'full character'}`}
              >
                <image
                  href={`/assets/quality/${character.id}-${example.id}-idle.png`}
                  width="3072" height="2048"
                  x={-(frame % 4) * 768} y={-Math.floor(frame / 4) * 1024}
                  onLoad={() => setLoaded((value) => value.includes(example.id) ? value : [...value, example.id])}
                  onError={() => setFailed(true)}
                />
              </svg>
            </figure>)}
          </div>}
        <p className="quality-comparison__caption">{character.caption} Same idle animation, scale and playback speed. Aura uses the same quality steps. Results vary with your photo.</p>
      </div> : null}
    </details>
  );
}
