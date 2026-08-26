import { useId } from 'react';
import type { CreationFlow } from '../shared/creationFlow.ts';

export type { CreationFlow } from '../shared/creationFlow.ts';

interface CreationFlowPickerProps {
  value: CreationFlow;
  onChange: (value: CreationFlow) => void;
  name: string;
  legend?: string;
  disabled?: boolean;
  videoAvailable?: boolean;
  videoUnavailableReason?: string;
  compact?: boolean;
}

const FLOW_OPTIONS: ReadonlyArray<{
  id: CreationFlow;
  label: string;
  badge: string;
  description: string;
}> = [
  {
    id: 'original',
    label: 'Original',
    badge: 'Default',
    description: 'Build each move from the proven still-image pipeline.',
  },
  {
    id: 'video',
    label: 'Video',
    badge: 'Experimental',
    description: 'Generate one motion clip at a time and review its dense frame sequence before continuing. The price shown for this operation still applies.',
  },
];

export function CreationFlowPicker({
  value,
  onChange,
  name,
  legend = 'Creation flow',
  disabled = false,
  videoAvailable = true,
  videoUnavailableReason,
  compact = false,
}: CreationFlowPickerProps) {
  const id = useId();

  return (
    <fieldset
      className={[
        'creation-flow-picker',
        compact ? 'is-compact' : '',
        disabled ? 'is-disabled' : '',
      ].filter(Boolean).join(' ')}
      disabled={disabled}
    >
      <legend>{legend}</legend>
      <div className="creation-flow-picker__options">
        {FLOW_OPTIONS.map((option) => {
          const unavailable = option.id === 'video' && !videoAvailable;
          const descriptionId = `${id}-${option.id}-description`;
          return (
            <label
              key={option.id}
              className={[
                'creation-flow-picker__option',
                value === option.id ? 'is-active' : '',
                unavailable ? 'is-unavailable' : '',
              ].filter(Boolean).join(' ')}
            >
              <input
                className="creation-flow-picker__radio"
                type="radio"
                name={name}
                value={option.id}
                checked={value === option.id}
                disabled={unavailable}
                aria-describedby={descriptionId}
                onChange={(event) => {
                  if (event.currentTarget.checked) onChange(option.id);
                }}
              />
              <span className="creation-flow-picker__copy">
                <span className="creation-flow-picker__heading">
                  <strong>{option.label}</strong>
                  <span className="creation-flow-picker__badge">{option.badge}</span>
                </span>
                <small id={descriptionId}>
                  {option.description}
                  {unavailable && videoUnavailableReason ? (
                    <span className="creation-flow-picker__reason"> {videoUnavailableReason}</span>
                  ) : null}
                </small>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
