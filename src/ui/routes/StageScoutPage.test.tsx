import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CrewStageAvailability, StageScoutPage } from './StageScoutPage.tsx';
import type { CrewStageStatus } from '../../services/CrewStages.ts';

describe('Stage Scout Crew mission', () => {
  it('preserves the Stage Scout UI while making the single Crew slot explicit', () => {
    const markup = renderToStaticMarkup(
      <StageScoutPage
        crew={{ id: 'org_alpha', name: 'Alpha Crew' }}
        onBack={vi.fn()}
        onComplete={vi.fn()}
      />,
    );
    expect(markup).toContain('stage-scout');
    expect(markup).toContain('Crew Home Stage · One Included');
    expect(markup).toContain("Choose Alpha Crew&#x27;s Stage");
    expect(markup).toContain('Decide together');
    expect(markup).toContain('bar, park, pitch, or corner');
  });

  it.each([
    ['crew_stage_friend_required', 'Invite a friend first'],
    ['crew_stage_verification_unavailable', 'could not check your Crew'],
  ] as const)('explains %s with an explicit retry instead of a false permission error', (eligibilityReason, text) => {
    const markup = renderToStaticMarkup(<CrewStageAvailability
      status={{ claimState: 'available', canCreate: false, eligibilityReason, stage: null }}
      checking={false} error={null} working={false} onRetry={vi.fn()} onBack={vi.fn()}
    />);
    expect(markup).toContain(text);
    expect(markup).toContain('Retry Crew Check');
    expect(markup).toContain('Back to Crew');
    expect(markup).not.toContain('admin');
  });

  it('distinguishes checking, existing reservations and ready stages', () => {
    const render = (status: CrewStageStatus | null, checking = false) => renderToStaticMarkup(<CrewStageAvailability
      status={status} checking={checking} error={null} working={false} onRetry={vi.fn()} onBack={vi.fn()}
    />);
    expect(render(null, true)).toContain('Checking your Crew');
    expect(render(null, true)).not.toContain('Retry Crew Check');
    const reserved = { claimState: 'reserved', canCreate: false, eligibilityReason: null, stage: null } as const;
    expect(render(reserved)).toContain('Finish any saved upload');
    expect(render({ ...reserved, canResumeCreate: true })).toContain('retry the same forge');
    expect(render({ ...reserved, claimState: 'ready' })).toContain('already chosen its one included stage');
    expect(render({ ...reserved, claimState: 'available', canCreate: true })).toBe('');
  });
});
