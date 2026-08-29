import { describe, expect, it } from 'vitest';
import { buildGeminiStageBackgroundPrompt } from './StageBackgroundPrompt.ts';

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
    expect(prompt).not.toContain('SOURCE IMAGE RULES:');
  });
});
