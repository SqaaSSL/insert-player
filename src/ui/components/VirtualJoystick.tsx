import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { setVirtualInputAction } from '../../game/systems/VirtualInput.ts';

type Dir = 'left' | 'right' | 'up' | 'down';

const X_THRESHOLD = 20;
const DOWN_THRESHOLD = 24;
/** Jumping is committal — demand a clearly vertical pull before firing it. */
const UP_THRESHOLD = 40;

const ROTATED_QUERY = '(pointer: coarse) and (orientation: portrait)';

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
 * Driving-game style movement control: the whole left side of the arena is
 * the touch zone, and the point where the finger lands becomes the stick's
 * origin — drag relative to it to walk, pull down to crouch, pull clearly
 * up to jump. The drawn stick is a visual reference of the resting center;
 * its knob mirrors the active direction.
 *
 * Inside the CSS-rotated portrait shell, pointer coordinates arrive in
 * screen (portrait) space while the game reads shell-space directions, so
 * deltas are axis-mapped before thresholding.
 */
export function VirtualJoystick({
  playerIndex = 0,
  playerLabel = 'player 1',
}: {
  playerIndex?: 0 | 1;
  playerLabel?: string;
}) {
  const pointerRef = useRef<number | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
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
    originRef.current = null;
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
    const origin = originRef.current;
    if (!origin) return;
    const sdx = event.clientX - origin.x;
    const sdy = event.clientY - origin.y;
    // Rotated shell: screen-down is shell-right, screen-right is shell-up.
    const rotated = window.matchMedia?.(ROTATED_QUERY).matches;
    const dx = rotated ? sdy : sdx;
    const dy = rotated ? -sdx : sdy;
    applyDirections(directionsFor(dx, dy));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (pointerRef.current !== null) return;
    pointerRef.current = event.pointerId;
    originRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
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
      className="virtual-joystick-zone"
      role="application"
      aria-label={`Movement zone, ${playerLabel}. Touch anywhere on the left side and drag: sideways to walk, down to crouch, up to jump.`}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={release}
    >
      <div className="virtual-joystick" aria-hidden="true">
        <span className={`virtual-joystick__knob${knobClass}`} />
      </div>
    </div>
  );
}
