import { useEffect, useId, useRef, useState } from 'react';
import { buildMatchSeed, type MatchSceneData } from '../../game/match/MatchConfig.ts';
import { AURA_ROUTINE_ANIMATION_NAMES, type AuraPerformanceRoutine, type AuraRoutineAnimationName } from '../../game/aura/AuraPerformance.ts';
import { normalizeAuraSelectedRoutines, resolveAuraPerformanceRoutine, type AuraSelectedRoutines } from '../../game/aura/AuraChoreography.ts';

export const AURA_GESTURE_LABELS: Record<AuraRoutineAnimationName, string> = {
  aura_six_seven: 'Six seven', aura_mog_check: 'Mog check', aura_glide: 'Glide',
  aura_floor_worm: 'Floor worm', aura_one_leg: 'One-leg hop',
};

/** Gesture diagrams use the neutral template, never another player's identity. */
function GestureDiagram({ name }: { name: AuraRoutineAnimationName }) {
  const clipId = useId();
  const width = name === 'aura_floor_worm' ? 384 : name === 'aura_one_leg' ? 256 : 192;
  const frame = name === 'aura_mog_check' ? 5 : name === 'aura_floor_worm' ? 4 : name === 'aura_six_seven' ? 1 : 3;
  return <svg className="aura-routine__gesture" viewBox={`0 0 ${width} 256`} aria-hidden="true" focusable="false">
    <defs><clipPath id={clipId}><rect width={width} height={256} /></clipPath></defs>
    <g clipPath={`url(#${clipId})`}><image href={`/assets/aura/template-zero/${name}.png`}
      x={-(frame % 4) * width} y={-Math.floor(frame / 4) * 256} width={width * 4} height={512} /></g>
  </svg>;
}

export function auraRoutinePlayerSlots(data: MatchSceneData): readonly (0 | 1)[] {
  if (data.cpuVsCpu || data.auraChallenge) return [];
  if (data.online) return [data.online.localSlot];
  return data.vsAI === false ? [0, 1] : [0];
}

export function prepareAuraRoutines(data: MatchSceneData, initial?: AuraSelectedRoutines): AuraSelectedRoutines {
  const routines = [...normalizeAuraSelectedRoutines(initial ?? data.auraRoutines)] as [AuraPerformanceRoutine | null, AuraPerformanceRoutine | null];
  const seed = buildMatchSeed({ ...data, gameMode: 'aura' });
  for (const slot of auraRoutinePlayerSlots(data)) {
    routines[slot] = [...resolveAuraPerformanceRoutine(seed, 0, slot, routines)] as unknown as AuraPerformanceRoutine;
  }
  return routines;
}

export function replaceAuraGesture(routine: AuraPerformanceRoutine, index: number, name: AuraRoutineAnimationName): AuraPerformanceRoutine {
  const next = [...routine];
  if (Number.isInteger(index) && index >= 0 && index < 3) next[index] = name;
  return next as unknown as AuraPerformanceRoutine;
}

export function moveAuraGesture(routine: AuraPerformanceRoutine, index: number, direction: -1 | 1): AuraPerformanceRoutine {
  const next = [...routine];
  const target = index + direction;
  if (Number.isInteger(index) && index >= 0 && index < 3 && target >= 0 && target < 3) {
    [next[index], next[target]] = [next[target], next[index]];
  }
  return next as unknown as AuraPerformanceRoutine;
}

interface AuraRoutineEditorProps {
  data: MatchSceneData;
  initialRoutines?: AuraSelectedRoutines;
  error?: string | null;
  onPlay: (routines: AuraSelectedRoutines) => void;
  onExit: () => void;
}

export function AuraRoutineEditor({ data, initialRoutines, error, onPlay, onExit }: AuraRoutineEditorProps) {
  const slots = auraRoutinePlayerSlots(data);
  const [routines, setRoutines] = useState(() => prepareAuraRoutines(data, initialRoutines));
  const [activeSlot, setActiveSlot] = useState<0 | 1>(slots[0] ?? 0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  const routine = routines[activeSlot]!;
  const playerName = (activeSlot === 0 ? data.p1Name : data.p2Name) || `Player ${activeSlot + 1}`;
  const update = (next: AuraPerformanceRoutine) => {
    setRoutines(current => activeSlot === 0 ? [next, current[1]] : [current[0], next]);
  };
  const selectGesture = (name: AuraRoutineAnimationName) => {
    update(replaceAuraGesture(routine, activeIndex, name));
    setAnnouncement(`${AURA_GESTURE_LABELS[name]} is move ${activeIndex + 1}.`);
  };
  const moveGesture = (index: number, direction: -1 | 1) => {
    update(moveAuraGesture(routine, index, direction));
    setActiveIndex(index + direction);
    setAnnouncement(`${AURA_GESTURE_LABELS[routine[index]]} moved to position ${index + direction + 1}.`);
  };

  return <main className="aura-routine" aria-labelledby="aura-routine-heading">
    <header className="aura-routine__header">
      <button type="button" className="asf-btn asf-btn--ghost" onClick={onExit}>Back</button>
      <span className="aura-routine__mode">Aura</span>
    </header>
    <div className="aura-routine__intro">
      <h1 id="aura-routine-heading" ref={headingRef} tabIndex={-1}>Choose your moves</h1>
      <p>Three gestures. Your order. Repeat any move you like.</p>
    </div>
    {slots.length > 1 ? <div className="aura-routine__players" role="group" aria-label="Choose whose routine to edit">
      {slots.map(slot => <button type="button" key={slot} aria-pressed={activeSlot === slot}
        onClick={() => { setActiveSlot(slot); setActiveIndex(0); setAnnouncement(''); }}>
        <span>P{slot + 1}</span> {(slot === 0 ? data.p1Name : data.p2Name) || `Player ${slot + 1}`}
      </button>)}
    </div> : null}
    <section className="aura-routine__sequence" aria-label={`${playerName}'s routine`}>
      <h2>{playerName}<span>Your routine</span></h2>
      <ol className="aura-routine__moves">
        {routine.map((name, index) => <li key={index} className={`aura-routine__move${activeIndex === index ? ' is-selected' : ''}`}>
          <button type="button" className="aura-routine__select" aria-pressed={activeIndex === index}
            aria-label={`Change move ${index + 1}: ${AURA_GESTURE_LABELS[name]}`} onClick={() => setActiveIndex(index)}>
            <span className="aura-routine__position">{index + 1}</span>
            <GestureDiagram name={name} />
            <strong>{AURA_GESTURE_LABELS[name]}</strong>
            <span className="aura-routine__change">{activeIndex === index ? 'Choose below' : 'Change move'}</span>
          </button>
          <div className="aura-routine__reorder" role="group" aria-label={`Reorder move ${index + 1}`}>
            <button type="button" aria-label={`Move gesture ${index + 1} earlier`} disabled={index === 0} onClick={() => moveGesture(index, -1)}>←</button>
            <button type="button" aria-label={`Move gesture ${index + 1} later`} disabled={index === 2} onClick={() => moveGesture(index, 1)}>→</button>
          </div>
        </li>)}
      </ol>
      <p className="aura-routine__repeat">This order repeats each round.</p>
    </section>
    <section className="aura-routine__library" aria-labelledby="aura-routine-library-heading">
      <h2 id="aura-routine-library-heading">Pick gesture {activeIndex + 1}</h2>
      <div className="aura-routine__choices">
        {AURA_ROUTINE_ANIMATION_NAMES.map(name => <button type="button" key={name} aria-pressed={routine[activeIndex] === name}
          onClick={() => selectGesture(name)}>
          <GestureDiagram name={name} /><span>{AURA_GESTURE_LABELS[name]}</span>
        </button>)}
      </div>
    </section>
    <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    {error ? <p className="aura-routine__error" role="alert">{error}</p> : null}
    <footer className="aura-routine__footer">
      <p>Follow the notes to keep your moves clean.<br />Your timing earns the Aura.</p>
      {slots.length > 1 && activeSlot === 0
        ? <button type="button" className="asf-btn asf-btn--primary" onClick={() => { setActiveSlot(1); setActiveIndex(0); }}>Choose P2 moves</button>
        : <button type="button" className="asf-btn asf-btn--primary" disabled={Boolean(error)} onClick={() => { if (!error) onPlay(routines); }}>
          {slots.length > 1 ? 'Use both routines' : 'Use this routine'}
        </button>}
    </footer>
  </main>;
}
