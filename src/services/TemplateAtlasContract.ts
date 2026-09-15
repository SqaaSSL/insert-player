import { TEMPLATE_ATLAS_MANIFEST_SHA256 } from './TemplateAtlasPlayback';

/** Stable renderer provenance. An absent version on older jobs means legacy-v1. */
export const GENERATION_RENDERER_VERSIONS = [
  'legacy-v1', 'rookie-two-atlas-v1', 'champion-animation-sheet-v1',
] as const;
export type GenerationRendererVersion = typeof GENERATION_RENDERER_VERSIONS[number];
export type TemplateAtlasRendererVersion = Exclude<GenerationRendererVersion, 'legacy-v1'>;

export const TEMPLATE_ATLAS_VERSION = 'template-zero-v3' as const;
export const TEMPLATE_ATLAS_MODEL = 'fal-ai/nano-banana-2/edit' as const;
export const TEMPLATE_ATLAS_COMPILER_CONTRACT = Object.freeze({
  schemaVersion: 1,
  rendererVersions: Object.freeze(['rookie-two-atlas-v1', 'champion-animation-sheet-v1']),
  templateVersion: TEMPLATE_ATLAS_VERSION,
  templateManifestSha256: TEMPLATE_ATLAS_MANIFEST_SHA256,
  animationFormat: 'template-atlas-v1',
  processingVersion: 6,
  animationCount: 20,
  model: TEMPLATE_ATLAS_MODEL,
  transport: 'meterkey-fal',
});
export function isTemplateAtlasCompilerContract(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.entries(TEMPLATE_ATLAS_COMPILER_CONTRACT)
    .every(([key, expected]) => JSON.stringify(candidate[key]) === JSON.stringify(expected));
}
export const TEMPLATE_ATLAS_ANIMATION_NAMES = [
  'idle', 'walk', 'high_punch', 'high_kick', 'low_punch', 'low_kick',
  'jump', 'crouch', 'hit', 'ko', 'victory', 'uppercut', 'fireball',
  'aura_unbothered', 'aura_six_seven', 'aura_mog_check', 'aura_glide',
  'aura_floor_worm', 'aura_one_leg', 'aura_shrug',
] as const;
export type TemplateAtlasAnimationName = typeof TEMPLATE_ATLAS_ANIMATION_NAMES[number];

export function isGenerationRendererVersion(value: unknown): value is GenerationRendererVersion {
  return GENERATION_RENDERER_VERSIONS.some(version => version === value);
}
export function isTemplateAtlasRendererVersion(value: unknown): value is TemplateAtlasRendererVersion {
  return value === 'rookie-two-atlas-v1' || value === 'champion-animation-sheet-v1';
}
/** Canonical order makes the selected subset independent of client ordering. */
export function normalizeTemplateAtlasAnimationNames(value: unknown): TemplateAtlasAnimationName[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > TEMPLATE_ATLAS_ANIMATION_NAMES.length
    || value.some(name => !TEMPLATE_ATLAS_ANIMATION_NAMES.some(known => known === name))
    || new Set(value).size !== value.length) {
    throw new Error('Select distinct supported Template Atlas animation names');
  }
  return TEMPLATE_ATLAS_ANIMATION_NAMES.filter(name => value.includes(name));
}
/** Pure Worker/processor agreement; image data remains private to the processor. */
export function getTemplateAtlasPlanIds(rendererVersion: TemplateAtlasRendererVersion, animationNames: unknown): string[] {
  const names = normalizeTemplateAtlasAnimationNames(animationNames);
  if (rendererVersion === 'rookie-two-atlas-v1') {
    return ['rookie-two-atlas-v1:two-01', 'rookie-two-atlas-v1:two-02'];
  }
  if (rendererVersion === 'champion-animation-sheet-v1') return names.map(name => `${rendererVersion}:${name}`);
  throw new Error('Unsupported Template Atlas renderer');
}

export interface TemplateAtlasSelection {
  rendererVersion: TemplateAtlasRendererVersion;
  animationNames: TemplateAtlasAnimationName[];
}
export interface TemplateAtlasProviderContext {
  apiBaseUrl: string;
  generationToken: string;
  providerSessionId: string;
  requestScope: string;
}
export interface TemplateAtlasRawArtifact {
  planId: string;
  rawBase64: string;
}
export interface SubmitTemplateAtlasRequest extends TemplateAtlasSelection, TemplateAtlasProviderContext {
  operation: 'submit';
  planId: string;
  /** The prepared, background-cleaned upright, never the original photograph. */
  uprightBase64: string;
}
export interface TemplateAtlasReceipt {
  requestId: string;
  requestScope: string;
  provenance: TemplateAtlasProvenance;
}
export interface CollectTemplateAtlasRequest extends TemplateAtlasSelection, TemplateAtlasProviderContext {
  operation: 'collect';
  planId: string;
  receipt: TemplateAtlasReceipt;
}
export type GenerateTemplateAtlasRequest = SubmitTemplateAtlasRequest | CollectTemplateAtlasRequest;
export type GenerateTemplateAtlasResult =
  | { status: 'submitted'; receipt: TemplateAtlasReceipt }
  | { status: 'pending'; receipt: TemplateAtlasReceipt; providerStatus: 'IN_QUEUE' | 'IN_PROGRESS' }
  | {
    status: 'completed'; receipt: TemplateAtlasReceipt;
    rawBase64: string; sha256: string; width: number; height: number; mimeType: 'image/png';
  };
export interface CompileTemplateAtlasRequest extends TemplateAtlasSelection {
  /** Every required RAW is checkpointed before entering this inference-free step. */
  atlases: TemplateAtlasRawArtifact[];
}
export interface CompiledTemplateAtlasSprite {
  animationName: TemplateAtlasAnimationName;
  /** Clean canonical HQ animation sheet, with authored holds physically repeated. */
  imageBase64: string;
  /** Same per-animation HQ cells before white cleanup; NOT the native provider atlas. */
  rawBase64: string;
  frameW: 768;
  frameH: 1024;
  frameCount: number;
  columns: number;
  rows: number;
  fps: number;
  loop: boolean;
  originX: number;
  originY: number;
  sequence: string[];
  animationFormat: 'template-atlas-v1';
  processingVersion: 6;
  provenance: {
    rendererVersion: string;
    templateVersion: string;
    templateManifestSha256: string;
    sources: Array<{ planId: string; rawSha256: string; templateImageSha256: string; geometryFingerprint: string }>;
    fullCanvasRegistration: { width: number; height: number; groundY: number; originX: number; originY: number };
  };
  qa: {
    passed: true;
    semanticApprovalClaimed: false;
    warnings: string[];
    perFrameFit: false;
    repeatsAreExact: true;
  };
}
export interface CompileTemplateAtlasResult {
  sprites: CompiledTemplateAtlasSprite[];
}

export interface TemplateAtlasProvenance {
  rendererVersion: TemplateAtlasRendererVersion;
  templateVersion: typeof TEMPLATE_ATLAS_VERSION;
  planId: string;
  templateManifestSha256: string;
  templateImageSha256: string;
  preparedUprightSha256: string;
  inputUprightSha256: string;
  promptSha256: string;
  requestBodySha256: string;
  model: typeof TEMPLATE_ATLAS_MODEL;
  referenceRoles: ['template', 'prepared-upright'];
  originalPhotoIncluded: false;
}
