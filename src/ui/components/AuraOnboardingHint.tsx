import type { AuraOnboardingDetail } from '../../game/aura/AuraOnboarding.ts';

const SHAPES = ['●', '◆', '■', '▲'];
const NAMES = ['circle', 'diamond', 'square', 'triangle'];

export function AuraOnboardingHint({ detail, onSkip }: { detail: AuraOnboardingDetail; onSkip: () => void }) {
  if (!detail.cue || detail.phase === 'complete' || detail.phase === 'skipped') return null;

  const lane = detail.practiceLane ?? 0;
  const practice = detail.phase === 'practice';
  const message = practice
    ? detail.cue === 'hit' ? 'Hit now' : 'Wait for the line'
    : detail.cue === 'score' ? `+${detail.scoreDelta?.toLocaleString()} Aura`
      : detail.cue === 'rival' ? 'Rival’s turn. Watch their moves.'
        : detail.cue === 'your-turn' ? 'Your turn. Hit the beat.'
          : 'Duel on. More Aura wins.';

  return <aside className={`aura-onboarding${practice ? ' is-practice' : ' is-battle'}`} aria-label={practice ? 'Aura practice' : 'Aura duel tip'}>
    <div className="aura-onboarding__copy" role="status" aria-live="polite" aria-atomic="true">
      {practice && <strong>Practice <span>{Math.min(detail.completedLanes + 1, 4)}/4</span></strong>}
      <p>
        <span className="aura-onboarding__message">{message}</span>
        {practice && <span className="aura-onboarding__short-message" aria-hidden="true">{detail.cue === 'hit' ? 'Hit now' : 'Wait'}</span>}
        {practice && <span className={`aura-onboarding__input is-lane-${lane}`}>
          <kbd>{detail.laneKeys[lane]}</kbd>
          <span aria-hidden="true">/</span>
          <span role="img" aria-label={`tap ${NAMES[lane]}`}>{SHAPES[lane]}</span>
        </span>}
      </p>
    </div>
    <button type="button" onClick={onSkip} aria-label={practice ? 'Skip practice and start duel' : 'Hide duel tips'}>
      {practice ? 'Skip' : 'Hide'}
    </button>
  </aside>;
}
