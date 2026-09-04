import { describe, expect, it } from 'vitest';
import {
  buildGeminiStageBackgroundPrompt,
  STAGE_GAMEPLAY_CLEARANCE_PROMPT_MARKER,
} from './StageBackgroundPrompt.ts';

describe('stage background prompt', () => {
  it('pins the transform-scene contract used by product and admin publication', () => {
    const prompt = buildGeminiStageBackgroundPrompt({
      stageLabel: 'INSERT PLAYER ARENA',
      stageBlurb: 'Red corner, blue corner, and main-event lights.',
      sourceImage: { data: 'seed', mime: 'image/png' },
      sourceMode: 'transform-scene',
    });

    expect(prompt).toContain('Theme: INSERT PLAYER ARENA. Red corner, blue corner, and main-event lights.');
    expect(prompt).toContain('The uploaded image is the actual place to transform into the arena.');
    expect(prompt).toContain('Preserve the location\'s recognizable layout');
    expect(prompt).toContain('If the gameplay space is already clear, preserve the original geometry and prop placement.');
    expect(prompt).toContain('Edit only the minimum set of objects that genuinely obstruct gameplay.');
    expect(prompt).toContain(STAGE_GAMEPLAY_CLEARANCE_PROMPT_MARKER);
    expect(prompt).toContain('entire lower 38% of the image, from the left edge to the right edge');
    expect(prompt).toContain('No signs, signposts, poles, bins, bollards, railings, barriers');
    expect(prompt).toContain('fighters centered at 30% and 70% of the image width');
    expect(prompt).toContain('Do not empty, redesign, or rearrange a scene that already satisfies');
    expect(prompt).toContain('make the smallest possible change to the obstructing object');
    expect(prompt).toContain('Produce a single widescreen 16:9 arena background.');
    expect(prompt).toContain('No text, no logos, no UI, no watermarks');
    expect(prompt).not.toContain('REFERENCE USAGE RULES:');
  });

  it('includes matchup context and visual references only when supplied', () => {
    const prompt = buildGeminiStageBackgroundPrompt({
      stageLabel: 'TEST STAGE',
      stageBlurb: 'A test arena.',
      fighterOneName: 'One',
      fighterTwoName: 'Two',
      fighterOneStyle: 'Technical',
      fighterTwoStyle: 'Aggressive',
      referenceImages: [{ data: 'reference', mime: 'image/png' }],
    });

    expect(prompt).toContain('Fighter one: One (Technical).');
    expect(prompt).toContain('Fighter two: Two (Aggressive).');
    expect(prompt).toContain('REFERENCE USAGE RULES:');
    expect(prompt).toContain(STAGE_GAMEPLAY_CLEARANCE_PROMPT_MARKER);
    expect(prompt).not.toContain('SOURCE IMAGE RULES:');
  });
});
