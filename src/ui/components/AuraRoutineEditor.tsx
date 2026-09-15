import { useEffect, useId, useRef, useState } from 'react';
import { buildMatchSeed, type MatchSceneData } from '../../game/match/MatchConfig.ts';
import { AURA_ROUTINE_ANIMATION_NAMES, createAuraPerformanceRoutine, type AuraRoutineAnimationName } from '../../game/aura/AuraPerformance.ts';
import { normalizeAuraSelectedRoutines, type AuraMatchSelection, type AuraRoundSelection, type AuraSelectedRoutines } from '../../game/aura/AuraChoreography.ts';

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
  const routines = [...normalizeAuraSelectedRoutines(initial ?? data.auraRoutines)] as [AuraMatchSelection | null, AuraMatchSelection | null];
  const seed = buildMatchSeed({ ...data, gameMode: 'aura' });
  const seeded = (): AuraMatchSelection => [0, 1, 2].map(round => createAuraPerformanceRoutine(seed, round)) as unknown as AuraMatchSelection;
  for (const slot of auraRoutinePlayerSlots(data)) {
    routines[slot] = copySelection(routines[slot] ?? seeded());
  }
  if (!data.online && !data.cpuVsCpu && !data.auraChallenge && data.vsAI !== false && !routines[1]) {
    routines[1] = seeded();
  }
  return routines;
}

function copySelection(selection: AuraMatchSelection): [[...AuraRoundSelection], [...AuraRoundSelection], [...AuraRoundSelection]] {
  return [[...selection[0]], [...selection[1]], [...selection[2]]];
}

export function replaceAuraGesture(routine: AuraMatchSelection, index: number, name: AuraRoutineAnimationName): AuraMatchSelection {
  const next = copySelection(routine);
  if (Number.isInteger(index) && index >= 0 && index < 9) next[Math.floor(index / 3)][index % 3] = name;
  return next;
}

export function moveAuraGesture(routine: AuraMatchSelection, index: number, direction: -1 | 1): AuraMatchSelection {
  const next = copySelection(routine);
  const target = index + direction;
  if (Number.isInteger(index) && index >= 0 && index < 9 && target >= 0 && target < 9) {
    [next[Math.floor(index / 3)][index % 3], next[Math.floor(target / 3)][target % 3]]
      = [next[Math.floor(target / 3)][target % 3], next[Math.floor(index / 3)][index % 3]];
  }
  return next;
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
  const activeRound = Math.floor(activeIndex / 3);
  const activeMove = activeIndex % 3;
  const playerName = (activeSlot === 0 ? data.p1Name : data.p2Name) || `Player ${activeSlot + 1}`;
  const update = (next: AuraMatchSelection) => {
    setRoutines(current => activeSlot === 0 ? [next, current[1]] : [current[0], next]);
  };
  const selectGesture = (name: AuraRoutineAnimationName) => {
    update(replaceAuraGesture(routine, activeIndex, name));
    setAnnouncement(`${AURA_GESTURE_LABELS[name]} is move ${activeMove + 1} in round ${activeRound + 1}.`);
  };
  const moveGesture = (index: number, direction: -1 | 1) => {
    update(moveAuraGesture(routine, index, direction));
    setActiveIndex(index + direction);
    const target = index + direction;
    setAnnouncement(`${AURA_GESTURE_LABELS[routine[Math.floor(index / 3)][index % 3]]} moved to round ${Math.floor(target / 3) + 1}, move ${target % 3 + 1}.`);
  };

  return <main className="aura-routine" aria-labelledby="aura-routine-heading">
    <header className="aura-routine__header">
      <button type="button" className="asf-btn asf-btn--ghost" onClick={onExit}>Back</button>
      <span className="aura-routine__mode">Aura</span>
    </header>
    <div className="aura-routine__intro">
      <h1 id="aura-routine-heading" ref={headingRef} tabIndex={-1}>Choose your moves</h1>
      <p>Three rounds. Three moves each. Choose all nine and repeat any move you like.</p>
    </div>
    {slots.length > 1 ? <div className="aura-routine__players" role="group" aria-label="Choose whose routine to edit">
      {slots.map(slot => <button type="button" key={slot} aria-pressed={activeSlot === slot}
        onClick={() => { setActiveSlot(slot); setActiveIndex(0); setAnnouncement(''); }}>
        <span>P{slot + 1}</span> {(slot === 0 ? data.p1Name : data.p2Name) || `Player ${slot + 1}`}
      </button>)}
    </div> : null}
    <section className="aura-routine__sequence" aria-label={`${playerName}'s routine`}>
      <h2>{playerName}<span>Your three rounds</span></h2>
      {routine.map((round, roundIndex) => <section key={roundIndex} className="aura-routine__round" aria-labelledby={`aura-round-${roundIndex}`}>
        <h3 id={`aura-round-${roundIndex}`}>Round {roundIndex + 1}</h3>
        <ol className="aura-routine__moves" start={roundIndex * 3 + 1}>
          {round.map((name, moveIndex) => {
            const index = roundIndex * 3 + moveIndex;
            return <li key={index} className={`aura-routine__move${activeIndex === index ? ' is-selected' : ''}`}>
              <button type="button" className="aura-routine__select" aria-pressed={activeIndex === index}
                aria-label={`Change round ${roundIndex + 1} move ${moveIndex + 1}: ${AURA_GESTURE_LABELS[name]}`} onClick={() => setActiveIndex(index)}>
                <span className="aura-routine__position">{index + 1}</span>
                <GestureDiagram name={name} />
                <strong>{AURA_GESTURE_LABELS[name]}</strong>
                <span className="aura-routine__change">{activeIndex === index ? 'Choose below' : 'Change move'}</span>
              </button>
              <div className="aura-routine__reorder" role="group" aria-label={`Reorder move ${index + 1}`}>
                <button type="button" aria-label={`Move gesture ${index + 1} earlier`} disabled={index === 0} onClick={() => moveGesture(index, -1)}>←</button>
                <button type="button" aria-label={`Move gesture ${index + 1} later`} disabled={index === 8} onClick={() => moveGesture(index, 1)}>→</button>
              </div>
            </li>;
          })}
        </ol>
        {activeRound === roundIndex ? <div className="aura-routine__library" aria-labelledby="aura-routine-library-heading">
          <h4 id="aura-routine-library-heading">Round {activeRound + 1}, move {activeMove + 1}: choose an animation</h4>
          <div className="aura-routine__choices">
            {AURA_ROUTINE_ANIMATION_NAMES.map(name => <button type="button" key={name} aria-pressed={routine[activeRound][activeMove] === name}
              onClick={() => selectGesture(name)}>
              <GestureDiagram name={name} /><span>{AURA_GESTURE_LABELS[name]}</span>
            </button>)}
          </div>
        </div> : null}
      </section>)}
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
