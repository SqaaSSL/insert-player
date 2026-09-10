import type { AuraOnboardingDetail } from '../../game/aura/AuraOnboarding.ts';

const SHAPES = ['●', '◆', '■', '▲'];
const NAMES = ['circle', 'diamond', 'square', 'triangle'];
export function AuraOnboardingHint({ detail, onSkip }: { detail: AuraOnboardingDetail; onSkip: () => void }) {
  if (!detail.cue || detail.phase === 'complete' || detail.phase === 'skipped') return null;
  const lane = detail.practiceLane ?? 0;
  const practice = detail.phase === 'practice';
  const message = detail.cue === 'score'
    ? `+${detail.scoreDelta?.toLocaleString()} Aura. That was you. Keep the streak going.`
    : detail.cue === 'rival' ? 'Rival’s turn. Watch their moves; your score is safe.'
    : detail.cue === 'your-turn' ? 'Your turn again. Hit the notes and take the lead.'
    : detail.cue === 'timing' ? 'The duel is on. Hit as each note meets the line. More Aura wins.'
    : detail.cue === 'wait' ? 'Almost. Wait until the note touches the bright line.'
    : detail.cue === 'hit' ? `Now! Press ${detail.laneKeys[lane]} or tap ${SHAPES[lane]} ${NAMES[lane]}.`
    : `Follow the note down to the bright line. Get ${detail.laneKeys[lane]} or ${SHAPES[lane]} ready.`;
  return <aside className={`aura-onboarding${practice ? ' is-practice' : ''}`} aria-label="Learn Aura">
    <div className="aura-onboarding__copy" role="status" aria-live="polite" aria-atomic="true">
      <strong>{practice ? `Warm-up · ${detail.completedLanes + 1} / 4` : 'Your first duel'}</strong>
      <p>{message}</p>
      {practice && <small>Practice only. No points lost.</small>}
    </div>
    <button type="button" onClick={onSkip}>{practice ? 'Skip practice' : 'Hide tips'}</button>
  </aside>;
}
