import { describe, expect, it } from 'vitest';
import type { GenerationJob } from '../../services/GenerationJobs.ts';
import { describePausedGeneration, pausedAttemptsForCharacter } from './generationFailureCopy.ts';

describe('paused generation copy', () => {
  it('explains a QA rejection in plain words, without internal jargon', () => {
    const copy = describePausedGeneration({ errorCode: 'template_atlas_qa_failed', preservedArtifactCount: 2 }, 1);
    expect(copy.message).toContain('did not come out right');
    expect(copy.message).toContain('2 finished steps are saved.');
    expect(copy.message).toContain('Trying again is free.');
    expect(copy.message).not.toMatch(/gemini|atlas|provider|QA|frame/i);
    expect(copy.stuck).toBe(false);
  });

  it('offers other ways out after repeated failures of the same character', () => {
    const copy = describePausedGeneration({ errorCode: 'qa_rejected_output', preservedArtifactCount: 1 }, 3);
    expect(copy.stuck).toBe(true);
    expect(copy.message).toContain('1 finished step is saved.');
    expect(copy.message).toContain('a different photo usually works better');
  });

  it('treats a blocked photo as stuck immediately and uses a generic line for unknown codes', () => {
    expect(describePausedGeneration({ errorCode: 'provider_content_blocked', preservedArtifactCount: 0 }, 1).stuck).toBe(true);
    const generic = describePausedGeneration({ errorCode: 'generation_failed', preservedArtifactCount: 0 }, 1);
    expect(generic.message).toBe('Your character paused before it was finished. Nothing is lost. Trying again is free.');
  });

  it('counts only paused character runs of the same fighter', () => {
    const job = (fighterId: string, status: GenerationJob['status'], operation = 'fighter_generation') =>
      ({ fighterId, status, operation }) as unknown as GenerationJob;
    expect(pausedAttemptsForCharacter([job('a', 'failed'), job('a', 'cancelled'), job('a', 'succeeded'), job('b', 'failed'), job('a', 'failed', 'fighter_upgrade')], 'a')).toBe(2);
  });
});
