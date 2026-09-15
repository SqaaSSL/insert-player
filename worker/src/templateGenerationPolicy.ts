import {
  isGenerationRendererVersion, isTemplateAtlasRendererVersion,
  normalizeTemplateAtlasAnimationNames, TEMPLATE_ATLAS_ANIMATION_NAMES, TEMPLATE_ATLAS_VERSION,
  type GenerationRendererVersion, type TemplateAtlasRendererVersion,
} from '../../src/services/TemplateAtlasContract';

export interface RendererPlanOwner { animation_plan_json?: string | null }

/** Versioned envelopes live in the existing immutable authorization/charge/run plan. */
export function storedGenerationRenderer(owner: RendererPlanOwner): GenerationRendererVersion {
  if (!owner.animation_plan_json) return 'legacy-v1';
  const plan: unknown = JSON.parse(owner.animation_plan_json);
  if (Array.isArray(plan)) return 'legacy-v1';
  if (!plan || typeof plan !== 'object') throw new Error('Invalid generation renderer plan');
  const envelope = plan as Record<string, unknown>;
  if (envelope.version !== 1 || !isTemplateAtlasRendererVersion(envelope.rendererVersion)
    || envelope.templateVersion !== TEMPLATE_ATLAS_VERSION) {
    throw new Error('Unsupported generation renderer or template version');
  }
  normalizeTemplateAtlasAnimationNames(envelope.animations);
  return envelope.rendererVersion;
}

export function atlasAnimationPlan(rendererVersion: TemplateAtlasRendererVersion): string {
  return JSON.stringify({ version: 1, rendererVersion, templateVersion: TEMPLATE_ATLAS_VERSION,
    animations: TEMPLATE_ATLAS_ANIMATION_NAMES });
}

export function requestedGenerationRenderer(value: unknown): GenerationRendererVersion | null {
  return value === undefined ? 'legacy-v1' : isGenerationRendererVersion(value) ? value : null;
}

export function rendererMatchesTier(renderer: GenerationRendererVersion, tier: string): boolean {
  return renderer === 'legacy-v1' || (tier === 'rookie' && renderer === 'rookie-two-atlas-v1')
    || (tier === 'contender' && renderer === 'champion-animation-sheet-v1');
}
