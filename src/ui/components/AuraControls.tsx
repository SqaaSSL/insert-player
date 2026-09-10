import { AURA_INPUT_EVENT, type AuraInputDetail } from '../../game/match/MatchConfig.ts';
import type { AuraLane } from '../../game/aura/AuraChart.ts';

const LANES: ReadonlyArray<{ lane: AuraLane; shape: string; label: string }> = [
  { lane: 0, shape: '●', label: 'Circle' },
  { lane: 1, shape: '◆', label: 'Diamond' },
  { lane: 2, shape: '■', label: 'Square' },
  { lane: 3, shape: '▲', label: 'Triangle' },
];

export function AuraControls({ playerIndex = 0, disabled = false }: { playerIndex?: 0 | 1; disabled?: boolean }) {
  const press = (lane: AuraLane) => {
    if (disabled) return;
    window.dispatchEvent(new CustomEvent<AuraInputDetail>(AURA_INPUT_EVENT, {
      detail: { lane, playerIndex },
    }));
  };

  return (
    <div className="aura-touch-controls" aria-label={`Aura controls, player ${playerIndex + 1}`}>
      {LANES.map(({ lane, shape, label }) => (
        <button
          key={lane}
          type="button"
          className={`aura-touch-controls__lane is-lane-${lane}`}
          aria-label={label}
          disabled={disabled}
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
          <span aria-hidden="true">{shape}</span>
        </button>
      ))}
    </div>
  );
}
