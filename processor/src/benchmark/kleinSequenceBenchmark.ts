import { createHash } from 'node:crypto';
import {
  BENCHMARK_SEED_REFINE,
  buildHighKickRefinePrompt,
  sha256Text,
} from './rosterProviderBenchmark.ts';
import {
  BIREFNET_MODEL_ID,
  FLASH_SEQUENCE_SOURCES,
  HIGH_KICK_ANCHORS,
  HIGH_KICK_PLAYBACK_ORDER,
} from './flashSequenceBenchmark.ts';

export const KLEIN_SEQUENCE_RUN_ID = 'phase2-klein-high-kick-20260823-v1';
export const KLEIN_SEQUENCE_CONFIRMATION = KLEIN_SEQUENCE_RUN_ID;
export const KLEIN_SEQUENCE_HARD_CAP_USD = 0.20;
export const KLEIN_CLEANUP_GUARD_USD = 0.001;
export const KLEIN_SEQUENCE_EXECUTION_CONTRACT = {
  generationPayload: {
    references: ['identity', 'pose'],
    imageSize: { width: 864, height: 1152 },
    seed: BENCHMARK_SEED_REFINE,
    syncMode: false,
    enableSafetyChecker: true,
    outputFormat: 'png',
    numInferenceSteps: 4,
    numImages: 1,
    guidanceScale: 'absent',
    promptExpansion: 'absent',
  },
  cleanupPayload: {
    fields: ['image_url'],
    resizeMaxDimension: 1024,
    jpegQuality: 0.85,
  },
  headers: {
    noRetry: true,
    storeIo: false,
    outputExpirySeconds: 3_600,
  },
  postprocess: 'neutralizeGreenSpillForSegmentation -> cleanReposedImagePreserveCanvas -> unionForegroundMasks -> decontaminateGreenEdges -> expandMirroredSequence -> cleanSpriteSheet',
} as const;

export const KLEIN_VARIANTS = [
  {
    id: 'klein-4b',
    label: 'FLUX.2 Klein 4B',
    model: 'fal-ai/flux-2/klein/4b/edit',
    endpoint: 'https://queue.fal.run/fal-ai/flux-2/klein/4b/edit',
    unitPriceUsd: 0.009,
    billingUnit: 'megapixels',
    expectedRequestCostUsd: 0.009492188,
    generationGuardUsd: 0.030,
    reusedRaw: {
      path: '.qa/provider-benchmark/phase0-20260822-v1/outputs/plan-b-bfl-klein-4b-via-fal/raw.png',
      width: 864,
      height: 1152,
      sha256: 'd640cd7203b96cf2330c4097aa2f0da84840f40f1e7340d4478eeb87f4da8709',
      metadataPath: '.qa/provider-benchmark/phase0-20260822-v1/outputs/plan-b-bfl-klein-4b-via-fal/provider-metadata.json',
      ledgerEntryId: 'plan-b-bfl-klein-4b-via-fal',
    },
  },
  {
    id: 'klein-9b',
    label: 'FLUX.2 Klein 9B',
    model: 'fal-ai/flux-2/klein/9b/edit',
    endpoint: 'https://queue.fal.run/fal-ai/flux-2/klein/9b/edit',
    unitPriceUsd: 0.011,
    billingUnit: 'megapixels',
    expectedRequestCostUsd: 0.032441406,
    generationGuardUsd: 0.033,
    reusedRaw: {
      path: '.qa/provider-benchmark/phase0-20260822-v1/outputs/plan-b-bfl-klein-9b-via-fal/raw.png',
      width: 864,
      height: 1152,
      sha256: 'e943a59fd7e1882c404d7ba1670d26177bfdab114c670d3367e49c411d0b264c',
      metadataPath: '.qa/provider-benchmark/phase0-20260822-v1/outputs/plan-b-bfl-klein-9b-via-fal/provider-metadata.json',
      ledgerEntryId: 'plan-b-bfl-klein-9b-via-fal',
    },
  },
] as const;

export type KleinVariantId = typeof KLEIN_VARIANTS[number]['id'];
export type KleinRequestKind = 'generation' | 'cleanup';

export interface KleinSequenceRequest {
  id: string;
  kind: KleinRequestKind;
  variantId: KleinVariantId;
  frameIndex: number;
  model: string;
  endpoint: string;
  guardedMaxUsd: number;
}

export const KLEIN_SEQUENCE_SOURCES = {
  identity: FLASH_SEQUENCE_SOURCES.identity,
  highKickSheet: FLASH_SEQUENCE_SOURCES.highKickSheet,
} as const;

export function buildKleinSequenceRequests(): KleinSequenceRequest[] {
  const generations = KLEIN_VARIANTS.flatMap((variant) => [0, 1, 2].map((frameIndex) => ({
    id: `${variant.id}-high-kick-frame-${String(frameIndex).padStart(2, '0')}`,
    kind: 'generation' as const,
    variantId: variant.id,
    frameIndex,
    model: variant.model,
    endpoint: variant.endpoint,
    guardedMaxUsd: variant.generationGuardUsd,
  })));
  const cleanups = KLEIN_VARIANTS.flatMap((variant) => [0, 1, 2, 3].map((frameIndex) => ({
    id: `birefnet-${variant.id}-high-kick-frame-${String(frameIndex).padStart(2, '0')}`,
    kind: 'cleanup' as const,
    variantId: variant.id,
    frameIndex,
    model: BIREFNET_MODEL_ID,
    endpoint: `https://queue.fal.run/${BIREFNET_MODEL_ID}`,
    guardedMaxUsd: KLEIN_CLEANUP_GUARD_USD,
  })));
  return [...generations, ...cleanups];
}

export function kleinSequenceGuardedBudgetUsd(): number {
  return Number(buildKleinSequenceRequests()
    .reduce((sum, request) => sum + request.guardedMaxUsd, 0)
    .toFixed(6));
}

export function kleinSequenceFingerprint(): string {
  const value = JSON.stringify({
    runId: KLEIN_SEQUENCE_RUN_ID,
    promptSha256: sha256Text(buildHighKickRefinePrompt()),
    seed: BENCHMARK_SEED_REFINE,
    anchors: HIGH_KICK_ANCHORS,
    sources: KLEIN_SEQUENCE_SOURCES,
    variants: KLEIN_VARIANTS,
    executionContract: KLEIN_SEQUENCE_EXECUTION_CONTRACT,
    playback: HIGH_KICK_PLAYBACK_ORDER,
    requests: buildKleinSequenceRequests(),
  });
  return createHash('sha256').update(value).digest('hex');
}

export function validateKleinSequencePlan(): void {
  const requests = buildKleinSequenceRequests();
  if (requests.length !== 14) throw new Error('Klein sequence must have 6 generation and 8 cleanup submissions.');
  if (requests.filter((request) => request.kind === 'generation').length !== 6) {
    throw new Error('Klein sequence must reuse both frame-3 impacts and submit exactly 6 new generations.');
  }
  if (requests.filter((request) => request.kind === 'cleanup').length !== 8) {
    throw new Error('Klein sequence must clean all 8 unique model/frame outputs.');
  }
  if (kleinSequenceGuardedBudgetUsd() > KLEIN_SEQUENCE_HARD_CAP_USD) {
    throw new Error('Klein sequence guarded budget exceeds the hard cap.');
  }
  if (sha256Text(buildHighKickRefinePrompt()) !== 'a030e3908944b9bf9ac71030ca4c39e392f54a1b7b3a6a62110e9688e1b01b96') {
    throw new Error('Frozen HIGH_KICK refine prompt changed.');
  }
}
