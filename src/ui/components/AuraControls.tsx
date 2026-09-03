import { AURA_INPUT_EVENT, type AuraInputDetail } from '../../game/match/MatchConfig.ts';
import type { AuraLane } from '../../game/aura/AuraChart.ts';

const LANES: ReadonlyArray<{ lane: AuraLane; shape: string; label: string }> = [
  { lane: 0, shape: '●', label: 'Circle' },
  { lane: 1, shape: '◆', label: 'Diamond' },
  { lane: 2, shape: '■', label: 'Square' },
  { lane: 3, shape: '▲', label: 'Triangle' },
];

export function AuraControls({ playerIndex = 0 }: { playerIndex?: 0 | 1 }) {
  const press = (lane: AuraLane) => {
    window.dispatchEvent(new CustomEvent<AuraInputDetail>(AURA_INPUT_EVENT, {
      detail: { lane, playerIndex },
    }));
  };

  return (
    <div className="aura-touch-controls" aria-label="Aura controls">
      {LANES.map(({ lane, shape, label }) => (
        <button
          key={lane}
          type="button"
          className={`aura-touch-controls__lane is-lane-${lane}`}
          aria-label={label}
          onPointerDown={(event) => {
            event.preventDefault();
            press(lane);
          }}
        >
          <span aria-hidden="true">{shape}</span>
        </button>
      ))}
    </div>
  );
}
