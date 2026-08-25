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

  it('separates motion, approved canonical, and real identity for frame transfer', () => {
    const prompt = buildArcadeProviderPrompt({
      fighter: trump,
      promptProfile: ARCADE_PROMPT_PROFILES.xaiCanonicalMotionTransfer,
    });

    expect(prompt).toContain('IMAGE 1 is the MOTION POSE AND COMPOSITION MASTER only');
    expect(prompt).toContain('IMAGE 2 is the APPROVED CANONICAL CHARACTER AND RENDERING MASTER');
    expect(prompt).toContain('IMAGE 3 is the REAL IDENTITY SAFEGUARD only');
    expect(prompt).toContain('same canonical character from IMAGE 2 captured at a different animation frame');
    expect(prompt).toContain('Return exactly one full-body animation frame');
    expect(prompt).toContain('not a sprite sheet, contact sheet, sequence, or collage');
    expect(prompt).toContain('exact high-kick impact pose from IMAGE 1');
    expect(prompt).not.toContain('neutral ready stance');
    expect(prompt).toContain('navy tailored suit, white shirt, vivid red tie');
  });

  it('binds the XAI motion contract to the requested HIGH_PUNCH without retaining a static pose', () => {
    const milei = manifest.fighters.find((fighter) => fighter.slug === 'javier-milei');
    const prompt = buildArcadeProviderPrompt({
      fighter: milei,
      promptProfile: ARCADE_PROMPT_PROFILES.xaiCanonicalMotionTransfer,
      motionAnimation: 'high_punch',
    });

    expect(prompt).toContain('exact standing high-punch impact pose from IMAGE 1');
    expect(prompt).toContain('both feet visible and planted');
    expect(prompt).toContain('rear guarding hand near the face');
    expect(prompt).toContain('dark tailored suit, black shirt');
    expect(prompt).not.toContain('high-kick');
    expect(prompt).not.toContain('forward neutral ready stance');
  });

  it('fails closed for a motion without a reviewed anatomy contract', () => {
    expect(() => buildArcadeProviderPrompt({
      fighter: trump,
      promptProfile: ARCADE_PROMPT_PROFILES.xaiCanonicalMotionTransfer,
      motionAnimation: 'provider_improvises',
    })).toThrow(/unsupported Arcade motion transfer/i);
  });

  it('fails closed for unknown prompt profiles', () => {
    expect(() => buildArcadeProviderPrompt({
      fighter: trump,
      promptProfile: 'provider-decides',
    })).toThrow(/unsupported Arcade prompt profile/i);
  });
});
