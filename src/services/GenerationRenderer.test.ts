import { describe, expect, it } from 'vitest';
import { rendererForNewFighter, rendererForSprite } from './GenerationRenderer';
import { assertGenerationRendererAcknowledged } from './GenerationJobs';
import { normalizeSpriteAnimationFormat } from '../SpriteAnimationFormat';

describe('versioned character rendering', () => {
  it('maps commercial qualities without changing historical tier IDs', () => {
    expect(rendererForNewFighter('rookie')).toBe('rookie-two-atlas-v1');
    expect(rendererForNewFighter('contender')).toBe('champion-animation-sheet-v1');
    expect(rendererForSprite({ qualityTier: 'contender', animationFormat: 'legacy' })).toBe('legacy-v1');
    expect(rendererForSprite({ qualityTier: 'champion', animationFormat: 'video-dense-v1' })).toBe('legacy-v1');
    expect(rendererForSprite({ qualityTier: 'rookie', animationFormat: 'template-atlas-v1' })).toBe('rookie-two-atlas-v1');
    expect(normalizeSpriteAnimationFormat('template-atlas-v1')).toBe('template-atlas-v1');
  });
  it('requires an exact new renderer acknowledgement without breaking older jobs', () => {
    expect(() => assertGenerationRendererAcknowledged('legacy-v1', undefined)).not.toThrow();
    expect(() => assertGenerationRendererAcknowledged('rookie-two-atlas-v1', undefined)).toThrow();
    expect(() => assertGenerationRendererAcknowledged('rookie-two-atlas-v1', 'legacy-v1')).toThrow();
    expect(() => assertGenerationRendererAcknowledged('rookie-two-atlas-v1', 'champion-animation-sheet-v1')).toThrow();
    expect(() => assertGenerationRendererAcknowledged('rookie-two-atlas-v1', 'rookie-two-atlas-v1')).not.toThrow();
  });
});
