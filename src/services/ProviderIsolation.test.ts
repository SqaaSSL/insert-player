import { describe, expect, it } from 'vitest';
import animationProfilesSource from './AnimationProfiles.ts?raw';
import geminiApiSource from './GeminiApi.ts?raw';
import geminiRequestPolicySource from './GeminiRequestPolicy.ts?raw';
import processorPackageSource from '../../processor/package.json?raw';
import processorServerSource from '../../processor/src/server.ts?raw';

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const isolatedProviderSources = import.meta.glob(
  ['./Bfl*.ts', './Fal*.ts', './ArcadeImageApi.ts'],
  { eager: true, import: 'default', query: '?raw' },
) as Record<string, string>;

const productionRuntimeSources = import.meta.glob(
  [
    './**/*.{ts,tsx}',
    '../../processor/src/**/*.{ts,tsx}',
    '../../worker/src/**/*.{ts,tsx}',
    '../../scripts/**/*.mjs',
    '!./**/*.test.ts',
    '!../../processor/src/**/*.test.ts',
    '!../../processor/src/benchmark/**',
    '!../../worker/src/**/*.test.ts',
  ],
  { eager: true, import: 'default', query: '?raw' },
) as Record<string, string>;

describe('provider isolation', () => {
  it('keeps the approved Gemini implementation byte-for-byte untouched', async () => {
    // These hashes are deliberate safety fuses. Updating one requires an
    // explicit Gemini-specific review; provider work must never update them.
    await expect(sha256Text(geminiApiSource)).resolves.toBe(
      '9fc6f8bc32fcf637ff086ae979995824bc603c916a132159e2a98d4da52fabaa',
    );
    await expect(sha256Text(geminiRequestPolicySource)).resolves.toBe(
      '49aa2840a510538852fbfb68ac310bbcd78c7403d8fab53d3b9ac9c59eb4d37b',
    );
    await expect(sha256Text(animationProfilesSource)).resolves.toBe(
      'd8806f1385911cc0b8c3b2df2ab06dee5ee4927ab32542d8a64b093b72eebac4',
    );
  });

  it('prevents BFL/FAL/Arcade modules from depending on Gemini internals', () => {
    expect(Object.keys(isolatedProviderSources)).toContain('./BflFlux2Prompts.ts');

    for (const [path, source] of Object.entries(isolatedProviderSources)) {
      expect(source, `${path} must not import GeminiApi`).not.toMatch(
        /(?:from\s*['"][^'"]*GeminiApi|import\s*\(\s*['"][^'"]*GeminiApi)/,
      );
      expect(source, `${path} must not import Gemini prompt profiles`).not.toMatch(
        /(?:from\s*['"][^'"]*AnimationProfiles|import\s*\(\s*['"][^'"]*AnimationProfiles)/,
      );
      expect(source, `${path} must own its post-processing instead of changing Gemini's`).not.toMatch(
        /(?:from\s*['"][^'"]*SpritePostProcess|import\s*\(\s*['"][^'"]*SpritePostProcess)/,
      );
    }
  });

  it('keeps the existing processor sprite route Gemini-only', () => {
    const start = processorServerSource.indexOf('async function generateSprite(');
    const end = processorServerSource.indexOf('\nasync function readJsonBody(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const generateSpriteSource = processorServerSource.slice(start, end);
    expect(generateSpriteSource).toContain("import('../../src/services/GeminiApi.ts')");
    expect(generateSpriteSource).toContain('geminiSheetRefined');
    expect(generateSpriteSource).toContain('geminiSpriteSheet');
    expect(generateSpriteSource).not.toMatch(/Bfl|Fal|Arcade/);
  });

  it('rebuilds the local processor before start so an obsolete bundle cannot run', () => {
    const processorPackage = JSON.parse(processorPackageSource) as {
      scripts?: Record<string, string>;
    };
    expect(processorPackage.scripts?.prestart).toBe('npm run build');
    expect(processorPackage.scripts?.start).toBe('node dist/server.mjs');
  });

  it('keeps experimental BFL image models out of every production runtime', () => {
    for (const [path, source] of Object.entries(productionRuntimeSources)) {
      expect(source, `${path} must not select an experimental BFL image model`).not.toMatch(
        /fal-ai\/flux-2|api(?:\.eu)?\.bfl\.ai|\/v1\/flux-2-(?:klein|pro|max|flex)/i,
      );
      expect(source, `${path} must not import the experimental BFL prompt contract`).not.toMatch(
        /(?:from\s*['"][^'"]*BflFlux2Prompts|import\s*\(\s*['"][^'"]*BflFlux2Prompts)/,
      );
    }
  });
});
