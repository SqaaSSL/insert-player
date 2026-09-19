import {
  apiFetch,
  captureApiRequestContext,
  type ApiRequestContext,
} from './ApiClient.ts';
import {
  deleteCachedStageBackground,
  getAllCachedStageBackgrounds,
  getActiveSpriteCacheScope,
  getCachedStageBackground,
  setCachedStageBackground,
  type CachedStageBackground,
  type CachedStageSource,
} from './SpriteCache.ts';
import { trackProductEvent } from './ProductEvents.ts';

const MAX_CREW_STAGE_BYTES = 5 * 1024 * 1024;
const CREW_STAGE_CACHE_VERSION = 'crew-stage-v1';

export interface CrewStageSummary {
  id: string;
  label: string;
  kind: 'photo' | 'photo-direct';
  contentHash: string;
  assetUrl: string;
  source?: CachedStageSource | null;
  createdAt: string;
  updatedAt: string;
}

export interface CrewStageStatus {
  claimState: 'available' | 'reserved' | 'ready';
  canCreate: boolean;
  canResumeCreate?: boolean;
  eligibilityReason: 'crew_stage_friend_required' | 'crew_stage_verification_unavailable' | null;
  stage: CrewStageSummary | null;
}

export interface CrewStageIdentity {
  id: string;
  name: string;
}

function isLocalDevWithoutApi(): boolean {
  return !String(import.meta.env.VITE_API_BASE_URL ?? '').trim() && import.meta.env.DEV;
}

async function apiError(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => ({})) as { error?: unknown };
  return new Error(typeof body.error === 'string' && body.error.trim() ? body.error : fallback);
}

function parseCrewStageSummary(value: unknown): CrewStageSummary | null {
  if (!value || typeof value !== 'object') return null;
  const stage = value as Partial<CrewStageSummary>;
  if (
    typeof stage.id !== 'string' || !stage.id
    || typeof stage.label !== 'string' || !stage.label
    || (stage.kind !== 'photo' && stage.kind !== 'photo-direct')
    || typeof stage.contentHash !== 'string' || !/^[a-f0-9]{64}$/i.test(stage.contentHash)
    || typeof stage.assetUrl !== 'string' || !stage.assetUrl
    || typeof stage.createdAt !== 'string' || !stage.createdAt
    || typeof stage.updatedAt !== 'string' || !stage.updatedAt
  ) return null;
  return stage as CrewStageSummary;
}

export function crewStageCacheKey(crewId: string, stageId: string): string {
  return `${CREW_STAGE_CACHE_VERSION}:${crewId}:${stageId}`;
}

export function isStageVisibleToActiveCrew(
  stage: CachedStageBackground,
  crew: Pick<CrewStageIdentity, 'id'> | null,
): boolean {
  return stage.cloudManagement !== 'crew'
    || Boolean(!stage.cloudUploadPending && crew && stage.cloudCrewId === crew.id);
}

export async function loadCrewStage(
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<CrewStageStatus> {
  if (isLocalDevWithoutApi()) return { claimState: 'available', canCreate: true, eligibilityReason: null, stage: null };
  const res = await apiFetch('/api/crew/stage', {}, context);
  if (!res.ok) throw await apiError(res, `Crew stage failed (${res.status})`);
  const body = await res.json() as Partial<CrewStageStatus>;
  const stage = body.stage == null ? null : parseCrewStageSummary(body.stage);
  if (body.stage != null && !stage) throw new Error('Crew stage returned an invalid stage.');
  if (!['available', 'reserved', 'ready'].includes(body.claimState ?? '')) {
    throw new Error('Crew stage returned an invalid claim state.');
  }
  const eligibilityReason = body.eligibilityReason ?? null;
  if (eligibilityReason !== null && !['crew_stage_friend_required', 'crew_stage_verification_unavailable'].includes(eligibilityReason)) {
    throw new Error('Crew stage returned an invalid eligibility reason. Try checking again.');
  }
  return {
    claimState: body.claimState as CrewStageStatus['claimState'],
    canCreate: body.canCreate === true && body.claimState === 'available' && eligibilityReason === null,
    canResumeCreate: body.canResumeCreate === true && body.claimState === 'reserved',
    eligibilityReason,
    stage,
  };
}

async function cacheCrewStage(
  summary: CrewStageSummary,
  pngBlob: Blob,
  crew: CrewStageIdentity,
): Promise<CachedStageBackground> {
  const cached: CachedStageBackground = {
    ownerScope: getActiveSpriteCacheScope(),
    stageKey: crewStageCacheKey(crew.id, summary.id),
    prompt: 'Shared Crew home stage.',
    pngBlob,
    createdAt: Date.parse(summary.createdAt) || Date.now(),
    kind: summary.kind,
    label: summary.label,
    source: summary.source ?? undefined,
    cloudManagement: 'crew',
    cloudStageId: summary.id,
    cloudContentHash: summary.contentHash,
    cloudCrewId: crew.id,
    cloudCrewName: crew.name,
  };
  await setCachedStageBackground(cached);
  return cached;
}

export async function cachePendingCrewStageUpload(
  stage: CachedStageBackground,
  crew: CrewStageIdentity,
  stageClaimId: string,
  purchaseId: string,
): Promise<CachedStageBackground> {
  const pending: CachedStageBackground = {
    ...stage,
    ownerScope: getActiveSpriteCacheScope(),
    stageKey: crewStageCacheKey(crew.id, stageClaimId),
    cloudManagement: 'crew',
    cloudStageId: stageClaimId,
    cloudCrewId: crew.id,
    cloudCrewName: crew.name,
    cloudUploadPending: true,
    cloudUploadPurchaseId: purchaseId,
  };
  await setCachedStageBackground(pending);
  return pending;
}

export async function findPendingCrewStageUpload(
  crew: Pick<CrewStageIdentity, 'id'>,
): Promise<CachedStageBackground | null> {
  const stages = await getAllCachedStageBackgrounds();
  return stages
    .filter((stage) => (
      stage.cloudManagement === 'crew'
      && stage.cloudCrewId === crew.id
      && stage.cloudUploadPending === true
      && typeof stage.cloudUploadPurchaseId === 'string'
      && Boolean(stage.cloudUploadPurchaseId)
    ))
    .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
}

export async function saveCrewStage(
  stage: CachedStageBackground,
  crew: CrewStageIdentity,
  purchaseId?: string | null,
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<CachedStageBackground> {
  if (isLocalDevWithoutApi()) {
    const now = new Date().toISOString();
    return cacheCrewStage({
      id: `local-${Date.now().toString(16)}`,
      label: stage.label ?? 'CREW STAGE',
      kind: stage.kind === 'photo-direct' ? 'photo-direct' : 'photo',
      contentHash: '0'.repeat(64),
      assetUrl: '',
      source: stage.source ?? null,
      createdAt: now,
      updatedAt: now,
    }, stage.pngBlob, crew);
  }

  const form = new FormData();
  form.append('label', stage.label ?? 'CREW STAGE');
  form.append('kind', stage.kind === 'photo-direct' ? 'photo-direct' : 'photo');
  if (purchaseId) form.append('purchaseId', purchaseId);
  if (stage.source) form.append('source', JSON.stringify(stage.source));
  form.append('file', new File([stage.pngBlob], 'crew-stage.png', { type: 'image/png' }));
  const res = await apiFetch('/api/crew/stage', { method: 'POST', body: form }, context);
  if (!res.ok) throw await apiError(res, `Crew stage save failed (${res.status})`);
  const body = await res.json() as { stage?: unknown };
  const summary = parseCrewStageSummary(body.stage);
  if (!summary) throw new Error('Crew stage save returned an invalid stage.');
  trackProductEvent('stage_completed', { source: 'crew' });
  return cacheCrewStage(summary, stage.pngBlob, crew);
}

export async function syncCrewStageToLocal(
  crew: CrewStageIdentity | null,
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<boolean> {
  if (!crew || isLocalDevWithoutApi()) return false;
  const status = await loadCrewStage(context);
  const summary = status.stage;
  if (!summary) return false;
  const stageKey = crewStageCacheKey(crew.id, summary.id);
  const existing = await getCachedStageBackground(stageKey);
  if (
    existing?.cloudContentHash === summary.contentHash
    && existing.label === summary.label
    && existing.cloudCrewId === crew.id
  ) return false;

  const response = await apiFetch(summary.assetUrl, {}, context);
  if (!response.ok) throw await apiError(response, `Crew stage download failed (${response.status})`);
  const declaredSize = Number(response.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_CREW_STAGE_BYTES) {
    throw new Error('Crew stage download is too large.');
  }
  const pngBlob = await response.blob();
  if (pngBlob.size > MAX_CREW_STAGE_BYTES || (pngBlob.type && pngBlob.type !== 'image/png')) {
    throw new Error('Crew stage download is not a supported PNG.');
  }
  await cacheCrewStage(summary, pngBlob, crew);
  return true;
}

export async function resumePendingCrewStageUpload(
  pending: CachedStageBackground,
  crew: CrewStageIdentity,
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<CachedStageBackground | null> {
  if (
    pending.cloudManagement !== 'crew'
    || pending.cloudCrewId !== crew.id
    || !pending.cloudUploadPending
    || !pending.cloudUploadPurchaseId
  ) return null;

  const status = await loadCrewStage(context);
  if (status.stage) {
    await syncCrewStageToLocal(crew, context);
    const readyKey = crewStageCacheKey(crew.id, status.stage.id);
    const ready = await getCachedStageBackground(readyKey);
    if (pending.stageKey !== readyKey) await deleteCachedStageBackground(pending.stageKey);
    return ready;
  }
  if (status.claimState === 'available') {
    await deleteCachedStageBackground(pending.stageKey);
    return null;
  }
  return saveCrewStage(pending, crew, pending.cloudUploadPurchaseId, context);
}
