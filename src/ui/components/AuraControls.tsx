import { AURA_INPUT_EVENT, type AuraInputDetail } from '../../game/match/MatchConfig.ts';
import type { AuraLane } from '../../game/aura/AuraChart.ts';
import { AURA_LANES } from '../../game/aura/AuraLanes.ts';

export function AuraControls({ playerIndex = 0, disabled = false, rivalTurn = false }: { playerIndex?: 0 | 1; disabled?: boolean; rivalTurn?: boolean }) {
  const press = (lane: AuraLane) => {
    if (disabled || rivalTurn) return;
    window.dispatchEvent(new CustomEvent<AuraInputDetail>(AURA_INPUT_EVENT, {
      detail: { lane, playerIndex },
    }));
  };

  return (
    <div className={`aura-touch-controls${rivalTurn ? ' is-rival-turn' : ''}`} aria-label={`Aura controls, player ${playerIndex + 1}${rivalTurn ? ', rival’s turn' : ''}`}>
      {AURA_LANES.map(({ name, position }, index) => {
        const lane = index as AuraLane;
        return (
        <button
          key={lane}
          type="button"
          className={`aura-touch-controls__lane is-lane-${lane}`}
          aria-label={`${name} lane, ${position}`}
          disabled={disabled || rivalTurn}
          onPointerDown={(event) => {
            event.preventDefault();
            press(lane);
          }}
          onClick={(event) => {
            // Keyboard/assistive activation has no pointerdown. Pointer clicks
            // were already judged at contact, so never submit them twice.
            if (event.detail === 0) press(lane);
          }}
        >
          <span className="aura-touch-controls__bar" aria-hidden="true" />
        </button>
      ); })}
    </div>
  );
}
