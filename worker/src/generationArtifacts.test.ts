import { describe, expect, it } from 'vitest';
import { pendingGenerationStages } from './generationArtifacts';

describe('durable generation artifact resume', () => {
  it('resumes only low_punch and later work after 3 sources plus 4 animations succeeded', () => {
    const completed = [
      'source:side',
      'source:upright',
      'source:crouch',
      'sprite:idle',
      'sprite:walk',
      'sprite:high_punch',
      'sprite:high_kick',
    ];
    const resumed = pendingGenerationStages(
      'fighter_generation',
      null,
      completed,
    ).map((stage) => stage.key);

    expect(resumed).toEqual([
      'sprite:low_punch',
      'sprite:low_kick',
      'sprite:jump',
      'sprite:crouch',
      'sprite:hit',
      'sprite:ko',
      'sprite:victory',
    ]);
  });
});
