import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { setVirtualInputAction } from '../../game/systems/VirtualInput.ts';

type Dir = 'left' | 'right' | 'up' | 'down';

const X_THRESHOLD = 18;
const DOWN_THRESHOLD = 22;
/** Jumping is committal — demand a clearly vertical flick before firing it. */
const UP_THRESHOLD = 34;

function directionsFor(dx: number, dy: number): Set<Dir> {
  const dirs = new Set<Dir>();
  if (dx <= -X_THRESHOLD) dirs.add('left');
  if (dx >= X_THRESHOLD) dirs.add('right');
  if (dy >= DOWN_THRESHOLD) dirs.add('down');
  if (dy <= -UP_THRESHOLD) dirs.add('up');
  return dirs;
}

function knobClassFor(dirs: Set<Dir>): string {
  const ns = dirs.has('up') ? 'n' : dirs.has('down') ? 's' : '';
  const ew = dirs.has('left') ? 'w' : dirs.has('right') ? 'e' : '';
  const compass = `${ns}${ew}`;
  return compass ? ` is-${compass}` : '';
}

/**
 * Eight-way virtual stick for the touch fight controls. Directions are held
 * VirtualInput states (down = crouch, down+attack = low, up = jump); the
 * knob snaps to the active compass point.
 */
export function VirtualJoystick({
  playerIndex = 0,
  playerLabel = 'player 1',
}: {
  playerIndex?: 0 | 1;
  playerLabel?: string;
}) {
  const baseRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<number | null>(null);
  const activeRef = useRef<Set<Dir>>(new Set());
  const [knobClass, setKnobClass] = useState('');

  const applyDirections = (next: Set<Dir>) => {
    for (const dir of ['left', 'right', 'up', 'down'] as Dir[]) {
      const isActive = next.has(dir);
      if (activeRef.current.has(dir) !== isActive) {
        setVirtualInputAction(playerIndex, dir, isActive);
      }
    }
    activeRef.current = next;
    setKnobClass(knobClassFor(next));
  };

  const release = () => {
    pointerRef.current = null;
    applyDirections(new Set());
  };

  useEffect(() => {
    const releaseAll = () => release();
    window.addEventListener('blur', releaseAll);
    window.addEventListener('pagehide', releaseAll);
    return () => {
      window.removeEventListener('blur', releaseAll);
      window.removeEventListener('pagehide', releaseAll);
      releaseAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerIndex]);

  const track = (event: PointerEvent<HTMLDivElement>) => {
    const base = baseRef.current;
    if (!base) return;
    const rect = base.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    applyDirections(directionsFor(dx, dy));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (pointerRef.current !== null) return;
    pointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    track(event);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerRef.current !== event.pointerId) return;
    track(event);
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerRef.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    release();
  };

  return (
    <div
      ref={baseRef}
      className="virtual-joystick"
      role="application"
      aria-label={`Movement stick, ${playerLabel}. Drag to walk, down to crouch, up to jump.`}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={release}
    >
      <span className={`virtual-joystick__knob${knobClass}`} aria-hidden="true" />
    </div>
  );
}
