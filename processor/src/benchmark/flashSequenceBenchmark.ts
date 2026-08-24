import { createHash } from 'node:crypto';
import {
  BENCHMARK_SEED_REFINE,
  buildHighKickRefinePrompt,
  sha256Text,
} from './rosterProviderBenchmark.ts';

export const FLASH_SEQUENCE_RUN_ID = 'phase1-flux2-flash-high-kick-20260822-v1';
export const FLASH_SEQUENCE_CONFIRMATION = FLASH_SEQUENCE_RUN_ID;
export const FLASH_SEQUENCE_HARD_CAP_USD = 0.06;
export const FLASH_MODEL_ID = 'fal-ai/flux-2/flash/edit';
export const BIREFNET_MODEL_ID = 'fal-ai/birefnet';
export const LIVE_COMPUTE_SECOND_PRICE_USD = 0.0008;
export const FLASH_GENERATION_GUARD_USD = 0.012;
export const BIREFNET_GUARD_USD = 0.003;
export const FLASH_OBSERVED_BILLED_REQUEST_USD = 0.015;
export const FLASH_SEQUENCE_BILLING_CORRECTED_GUARD_USD = Number((
  3 * FLASH_OBSERVED_BILLED_REQUEST_USD + 4 * BIREFNET_GUARD_USD
).toFixed(6));
export const HIGH_KICK_UNIQUE_FRAME_COUNT = 4;
export const HIGH_KICK_PLAYBACK_ORDER = [0, 1, 2, 3, 2, 1, 0] as const;

export const FLASH_SEQUENCE_SOURCES = {
  identity: {
    path: '.artifacts/qa/durable-rookie/side.png',
    width: 768,
    height: 1400,
    sha256: '1ddbc7bf6dbc23ebc5eafff891ecb5242dfba70d78562eeef45c9316d6a6eddd',
  },
  highKickSheet: {
    path: '.artifacts/qa/durable-rookie/high_kick.png',
    width: 3072,
    height: 2048,
    sha256: '4129ad291fde9885a4d4d43420239cde2f3b62ea919d4d4b2a4abcbd8152788a',
  },
  reusedImpact: {
    path: '.qa/provider-benchmark/phase0-20260822-v1/outputs/plan-b-flux2-flash-via-fal/raw.png',
    width: 864,
    height: 1152,
    sha256: 'bc38ee630859ffc5039c94ba9dca9d645ff21159ca9df28905c86821ebf3980b',
    metadataPath: '.qa/provider-benchmark/phase0-20260822-v1/outputs/plan-b-flux2-flash-via-fal/provider-metadata.json',
  },
} as const;

export const HIGH_KICK_ANCHORS = [
  { frameIndex: 0, x: 0, y: 0, width: 768, height: 1024, sha256: 'fe721bd2b49d503c12cf2cea5371824d0f0243ef5373d9ae1ad6174233c11782' },
  { frameIndex: 1, x: 768, y: 0, width: 768, height: 1024, sha256: '310f4a6d8301f585aca1b6ab7c5c85c048daea000a58666f68c8899f2fcf528f' },
  { frameIndex: 2, x: 1536, y: 0, width: 768, height: 1024, sha256: 'd37fd950f24429f97d7f029bcc7609b992cb6bfc260d5237ff0cfcf7665bd449' },
  { frameIndex: 3, x: 2304, y: 0, width: 768, height: 1024, sha256: '6e01230a26a3c979a0c95c62cde7bd05a73d9576c106b11ef12479834e341bee' },
] as const;

export type FlashSequenceRequestKind = 'generation' | 'cleanup';

export interface FlashSequenceRequest {
  id: string;
  kind: FlashSequenceRequestKind;
  frameIndex: number;
  model: string;
  endpoint: string;
  guardedMaxUsd: number;
}

export function buildFlashSequenceRequests(): FlashSequenceRequest[] {
  const generation = [0, 1, 2].map((frameIndex) => ({
    id: `flash-high-kick-frame-${String(frameIndex).padStart(2, '0')}`,
    kind: 'generation' as const,
    frameIndex,
    model: FLASH_MODEL_ID,
    endpoint: `https://queue.fal.run/${FLASH_MODEL_ID}`,
    guardedMaxUsd: FLASH_GENERATION_GUARD_USD,
  }));
  const cleanup = [0, 1, 2, 3].map((frameIndex) => ({
    id: `birefnet-high-kick-frame-${String(frameIndex).padStart(2, '0')}`,
    kind: 'cleanup' as const,
    frameIndex,
    model: BIREFNET_MODEL_ID,
    endpoint: `https://queue.fal.run/${BIREFNET_MODEL_ID}`,
    guardedMaxUsd: BIREFNET_GUARD_USD,
  }));
  return [...generation, ...cleanup];
}

export function flashSequenceGuardedBudgetUsd(): number {
  return Number(buildFlashSequenceRequests()
    .reduce((sum, request) => sum + request.guardedMaxUsd, 0)
    .toFixed(6));
}

export function flashSequenceFingerprint(): string {
  const value = JSON.stringify({
    runId: FLASH_SEQUENCE_RUN_ID,
    promptSha256: sha256Text(buildHighKickRefinePrompt()),
    seed: BENCHMARK_SEED_REFINE,
    anchors: HIGH_KICK_ANCHORS,
    sources: FLASH_SEQUENCE_SOURCES,
    playback: HIGH_KICK_PLAYBACK_ORDER,
    requests: buildFlashSequenceRequests(),
  });
  return createHash('sha256').update(value).digest('hex');
}

export function validateFlashSequencePlan(): void {
  const requests = buildFlashSequenceRequests();
  if (requests.length !== 7) throw new Error('Flash sequence must have 3 generation and 4 cleanup submissions.');
  if (requests.filter((request) => request.kind === 'generation').length !== 3) {
    throw new Error('Flash sequence must reuse frame 3 and submit exactly 3 new generations.');
  }
  if (requests.filter((request) => request.kind === 'cleanup').length !== 4) {
    throw new Error('Flash sequence must clean all 4 unique frames.');
  }
  if (flashSequenceGuardedBudgetUsd() > FLASH_SEQUENCE_HARD_CAP_USD) {
    throw new Error('Flash sequence guarded budget exceeds the hard cap.');
  }
  if (sha256Text(buildHighKickRefinePrompt()) !== 'a030e3908944b9bf9ac71030ca4c39e392f54a1b7b3a6a62110e9688e1b01b96') {
    throw new Error('Frozen HIGH_KICK refine prompt changed.');
  }
}
