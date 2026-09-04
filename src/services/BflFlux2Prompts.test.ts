import { describe, expect, it } from 'vitest';
import { buildBflFlux2FramePrompt } from './BflFlux2Prompts';

describe('BFL FLUX.2 frame prompt contract', () => {
  it('keeps a resting anchor free of attack semantics', () => {
    const prompt = buildBflFlux2FramePrompt({
      pose: 'Neutral resting guard. Both feet are planted, both knees are relaxed, and both forearms form the guard shown in IMAGE 2.',
    });

    expect(prompt).toContain('Replace the person in IMAGE 2 with the person from IMAGE 1.');
    expect(prompt).toContain('Neutral resting guard. Both feet are planted');
    expect(prompt).toContain('exactly one complete, continuous adult human body');
    expect(prompt).toContain('two arms ending in two hands');
    expect(prompt).toContain('two legs ending in two feet');
    expect(prompt).not.toMatch(/high.?kick|roundhouse|attack/i);
  });

  it('requires every animation plan to supply its own frame-specific pose', () => {
    expect(() => buildBflFlux2FramePrompt({ pose: '   ' })).toThrow(
      'BFL FLUX.2 requires an explicit frame-specific pose.',
    );
  });

  it('describes an impact pose without changing the reference roles', () => {
    const prompt = buildBflFlux2FramePrompt({
      pose: 'Fully extended high side-kick impact. One support foot is planted and one kicking leg is straight at the exact height shown in IMAGE 2.',
      appearance: 'the same recognizable face, navy suit, white shirt, red tie, black shoes, body proportions, and realistic 2.5D rendering from IMAGE 1',
    });

    expect(prompt).toContain('Keep IMAGE 2 as the exact structural template');
    expect(prompt).toContain('Use IMAGE 1 only for appearance');
    expect(prompt).toContain('One support foot is planted and one kicking leg is straight');
  });
});
