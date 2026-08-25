import { describe, expect, it } from 'vitest';
import rosterSource from '../../arcade/roster-2026.json?raw';
import processorServerSource from '../../processor/src/server.ts?raw';
import geminiApiSource from './GeminiApi.ts?raw';

describe('official Arcade identity pipeline', () => {
  it('sends the approved licensed photo into the first Gemini source call', () => {
    expect(processorServerSource).toContain("strategy === 'official-reference-side'");
    expect(processorServerSource).toContain(
      'geminiReposeDetailed(body.imageBase64, context, generationPrompt)',
    );
    expect(processorServerSource).not.toContain('geminiOfficialPoseDetailed');
  });

  it('does not pay for a duplicate fallback after an official reference is blocked', () => {
    expect(geminiApiSource).toContain('if (promptOverride?.trim()) {');
    expect(geminiApiSource).toContain('Official licensed reference declined; skipping a duplicate paid retry.');
  });

  it('keeps canonical identity artwork attached during scaffold and frame refinement', () => {
    expect(geminiApiSource).toContain('const primaryBase64 = characterBase64;');
    expect(geminiApiSource).toContain("const extras = [{ data: cellBase64, mime: 'image/png' }];");
    expect(geminiApiSource).toContain('IMAGE 1 is the canonical identity');
    expect(geminiApiSource).not.toContain('createIdentityFreePoseGuide');
    expect(geminiApiSource).not.toContain('written description only');
  });

  it('requires every launch fighter prompt to preserve the approved identity input', () => {
    const manifest = JSON.parse(rosterSource) as {
      fighters: Array<{ referencePrompt: string }>;
    };

    expect(manifest.fighters).toHaveLength(13);
    for (const fighter of manifest.fighters) {
      expect(fighter.referencePrompt).toContain('licensed reference photo as the identity anchor');
      expect(fighter.referencePrompt).toContain("Preserve the person's recognizable facial structure");
      expect(fighter.referencePrompt).not.toMatch(/synthetic face|written description only/i);
    }
  });
});
