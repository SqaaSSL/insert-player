import { useEffect, useRef, useState } from 'react';
import { INTRO_STATE_EVENT } from '../../game/match/MatchConfig.ts';

interface KeyDef {
  label: string;
  caption?: string;
  wide?: boolean;
}

const MOVE_ROWS: KeyDef[][] = [
  [
    { label: 'Q' },
    { label: 'W', caption: 'JUMP' },
    { label: 'E' },
    { label: 'R' },
    { label: 'T' },
  ],
  [
    { label: 'A', caption: 'MOVE' },
    { label: 'S', caption: 'CROUCH' },
    { label: 'D', caption: 'MOVE' },
    { label: 'F' },
    { label: 'G', caption: 'GUARD' },
  ],
];

const ATTACK_ROWS: KeyDef[][] = [
  [
    { label: 'Y' },
    { label: 'U', caption: 'PUNCH' },
    { label: 'I', caption: 'FIREBALL' },
    { label: 'O', caption: 'SUPER' },
    { label: 'P' },
  ],
  [
    { label: 'H' },
    { label: 'J', caption: 'KICK' },
    { label: 'K', caption: 'UPPERCUT' },
    { label: 'L' },
  ],
];

function Key({ def }: { def: KeyDef }) {
  return (
    <span className={`fight-keys__key${def.caption ? ' is-active' : ''}`}>
      <kbd>{def.label}</kbd>
      {def.caption ? <small>{def.caption}</small> : null}
    </span>
  );
}

function Cluster({ rows, label }: { rows: KeyDef[][]; label: string }) {
  return (
    <div className="fight-keys__cluster" role="group" aria-label={label}>
      {rows.map((row, index) => (
        <div className={`fight-keys__row${index > 0 ? ' fight-keys__row--home' : ''}`} key={index}>
          {row.map((def) => (
            <Key key={def.label} def={def} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * First-round onboarding over the fight canvas. Desktop gets a drawn
 * keyboard with the active keys lit; touch devices get one recipe line
 * (their buttons are already labeled).
 */
export function FightControlsHint() {
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [hasShown, setHasShown] = useState(false);
  const hideTimerRef = useRef(0);
  const leaveTimerRef = useRef(0);
  const [coarse] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches,
  );

  const clearHintTimers = () => {
    window.clearTimeout(hideTimerRef.current);
    window.clearTimeout(leaveTimerRef.current);
  };

  useEffect(() => {
    const onIntro = (event: WindowEventMap[typeof INTRO_STATE_EVENT]) => {
      if (event.detail.visible && event.detail.roundNumber === 1) {
        setHasShown(true);
        setVisible(true);
        setLeaving(false);
        clearHintTimers();
        hideTimerRef.current = window.setTimeout(() => {
          setLeaving(true);
          leaveTimerRef.current = window.setTimeout(() => setVisible(false), 700);
        }, 9000);
      }
    };
    window.addEventListener(INTRO_STATE_EVENT, onIntro);
    return () => {
      window.removeEventListener(INTRO_STATE_EVENT, onIntro);
      clearHintTimers();
    };
  }, []);

  if (!hasShown) return null;

  const toggle = (
    <button
      type="button"
      className="fight-keys__toggle"
      aria-expanded={visible}
      onClick={() => {
        clearHintTimers();
        setLeaving(false);
        setVisible((current) => !current);
      }}
    >
      {visible ? 'Hide controls' : 'Show controls'}
    </button>
  );

  if (!visible) return toggle;

  if (coarse) {
    return (
      <>
        <div className={`fight-keys fight-keys--touch${leaving ? ' is-leaving' : ''}`} role="region" aria-label="Fight controls">
          <p className="fight-keys__recipe">
            <kbd>P</kbd> on hit <span className="fight-keys__arrow" aria-hidden="true">&#9654;</span> <kbd>F</kbd> = fireball combo
          </p>
        </div>
        {toggle}
      </>
    );
  }

  return (
    <>
      <div className={`fight-keys${leaving ? ' is-leaving' : ''}`} role="region" aria-label="Fight controls">
        <p className="sr-only">
          Move with A and D, crouch with S, jump with W, and guard with G. Punch with U,
          kick with J, fireball with I, uppercut with K, and use super with O.
        </p>
        <div className="fight-keys__board" aria-hidden="true">
          <Cluster rows={MOVE_ROWS} label="Movement keys" />
          <Cluster rows={ATTACK_ROWS} label="Attack keys" />
        </div>
        <p className="fight-keys__recipe" aria-hidden="true">
          <kbd>U</kbd> on hit <span className="fight-keys__arrow">&#9654;</span> <kbd>I</kbd> = fireball combo
          &nbsp;·&nbsp; <kbd>G</kbd> block a fireball standing = reflect it
        </p>
      </div>
      {toggle}
    </>
  );
}
