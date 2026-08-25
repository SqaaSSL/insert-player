import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ARCADE_PROMPT_PROFILES,
  buildArcadeProviderPrompt,
} from './arcade-provider-prompts.mjs';

const manifest = JSON.parse(readFileSync(new URL('../arcade/roster-2026.json', import.meta.url), 'utf8'));
const trump = manifest.fighters.find((fighter) => fighter.slug === 'donald-trump');

describe('Arcade provider prompt profiles', () => {
  it('preserves the canonical prompt exactly for providers without an override', () => {
    expect(buildArcadeProviderPrompt({ fighter: trump })).toBe(trump.referencePrompt);
  });

  it('gives XAI a deterministic realistic-adult rendering contract', () => {
    const prompt = buildArcadeProviderPrompt({
      fighter: trump,
      promptProfile: ARCADE_PROMPT_PROFILES.xaiRealisticAdult,
    });

    expect(prompt).not.toBe(trump.referencePrompt);
    expect(prompt).toContain('close facial identity reference');
    expect(prompt).toContain('premium semi-realistic 3D fighting-game roster art');
    expect(prompt).toContain('never stylize anatomy, head size, apparent age, or identity');
    expect(prompt).toContain('approximately 7.5 heads');
    expect(prompt).toContain('about 13 percent of total body height');
    expect(prompt).toContain('70-85 mm equivalent camera');
    expect(prompt).toContain('no oversized head');
    expect(prompt).toContain('navy tailored suit, white shirt, vivid red tie');
    expect(prompt).toContain('Pure bright green (#00FF00) background');
    expect(prompt).not.toMatch(/clearly AI-generated|realistic 2\.5D|documentary photography/i);
  });

  it('keeps pose/style and target identity in separate ordered reference roles', () => {
    const prompt = buildArcadeProviderPrompt({
      fighter: trump,
      promptProfile: ARCADE_PROMPT_PROFILES.xaiIdentityPoseTransfer,
    });

    expect(prompt).toContain('IMAGE 1 is the POSE, COMPOSITION, AND RENDERING MASTER only');
    expect(prompt).toContain('IMAGE 2 is the IDENTITY AND PHYSIQUE ANCHOR only');
    expect(prompt).toContain('Never blend the two faces');
    expect(prompt).toContain('must not resemble IMAGE 1');
    expect(prompt).toContain('Identity and physique from IMAGE 2');
    expect(prompt).toContain('Pose, camera, framing, proportions, and rendering finish from IMAGE 1');
    expect(prompt).toContain('navy tailored suit, white shirt, vivid red tie');
  });

  it('fails closed for unknown prompt profiles', () => {
    expect(() => buildArcadeProviderPrompt({
      fighter: trump,
      promptProfile: 'provider-decides',
    })).toThrow(/unsupported Arcade prompt profile/i);
  });
});
