import { generateId, hashString } from './auth';
import { canManageCrew } from './crewAuthorization';
import { crewStageEligibilityError, getCrewStageEligibility } from './crewStageEligibility';
import { readMultipartFormData } from './requestBody';
import type { AuthContext, Env } from './types';

const MAX_CREW_STAGE_BYTES = 5 * 1024 * 1024;
const MAX_CREW_STAGE_MULTIPART_BYTES = MAX_CREW_STAGE_BYTES + 256 * 1024;
const DIRECT_UPLOAD_RESERVATION_MINUTES = 5;
const STAGE_WIDTH = 1024;
const STAGE_HEIGHT = 576;

type CrewStageKind = 'photo' | 'photo-direct';
type CrewStageStatus = 'reserved' | 'ready';

interface CrewStageRow {
  clerk_organization_id: string;
  id: string;
  created_by_user_id: string | null;
  generation_charge_id: string | null;
  status: CrewStageStatus;
  label: string;
  kind: CrewStageKind | null;
  blob_key: string | null;
  content_hash: string | null;
  source_json: string | null;
  reservation_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CrewStageSource {
  provider: 'google-street-view';
  panoId: string;
  latitude: number;
  longitude: number;
  heading: number;
  pitch: number;
  fov: number;
  locationLabel?: string;
  imageDate?: string | null;
  copyright?: string | null;
  capturedAt: number;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

function activeOrganization(auth: AuthContext): string | Response {
  const organizationId = auth.activeOrganizationId?.trim();
  return organizationId || json({
    error: 'Create or select a Crew before choosing its stage',
    code: 'active_organization_required',
  }, 409);
}

function normalizeStageLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!label || label.length > 42) return null;
  return label;
}

function parseStageKind(value: unknown): CrewStageKind | null {
  return value === 'photo' || value === 'photo-direct' ? value : null;
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function parseStageSource(value: unknown): CrewStageSource | null {
  if (typeof value !== 'string' || !value || value.length > 2_048) return null;
  try {
    const source = JSON.parse(value) as Partial<CrewStageSource>;
    const finite = [source.latitude, source.longitude, source.heading, source.pitch, source.fov, source.capturedAt]
      .every((item) => typeof item === 'number' && Number.isFinite(item));
    if (
      source.provider !== 'google-street-view'
      || typeof source.panoId !== 'string'
      || !/^[A-Za-z0-9_-]{1,180}$/.test(source.panoId)
      || !finite
      || source.latitude! < -90 || source.latitude! > 90
      || source.longitude! < -180 || source.longitude! > 180
      || source.fov! < 10 || source.fov! > 120
    ) return null;
    return {
      provider: 'google-street-view',
      panoId: source.panoId,
      latitude: source.latitude!,
      longitude: source.longitude!,
      heading: source.heading!,
      pitch: source.pitch!,
      fov: source.fov!,
      capturedAt: source.capturedAt!,
      ...(boundedText(source.locationLabel, 180) ? { locationLabel: boundedText(source.locationLabel, 180)! } : {}),
      imageDate: boundedText(source.imageDate, 32),
      copyright: boundedText(source.copyright, 240),
    };
  } catch {
    return null;
  }
}

function isPngAtStageDimensions(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 24) return false;
  const view = new DataView(bytes);
  const signature = new Uint8Array(bytes, 0, 8);
  if (![
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ].every((value, index) => signature[index] === value)) return false;
  const chunk = String.fromCharCode(...new Uint8Array(bytes, 12, 4));
  return chunk === 'IHDR'
    && view.getUint32(16) === STAGE_WIDTH
    && view.getUint32(20) === STAGE_HEIGHT;
}

function assetUrl(request: Request, stage: CrewStageRow): string {
  const url = new URL(`/api/crew/stage/${encodeURIComponent(stage.id)}/asset`, request.url);
  if (stage.content_hash) url.searchParams.set('v', stage.content_hash.slice(0, 16));
  return url.toString();
}

function serializeReadyStage(request: Request, stage: CrewStageRow) {
  let source: CrewStageSource | null = null;
  if (stage.source_json) {
    try { source = JSON.parse(stage.source_json) as CrewStageSource; } catch { /* malformed legacy metadata stays hidden */ }
  }
  return {
    id: stage.id,
    label: stage.label,
    kind: stage.kind,
    contentHash: stage.content_hash,
    assetUrl: assetUrl(request, stage),
    source,
    createdAt: stage.created_at,
    updatedAt: stage.updated_at,
  };
}

async function getCrewStageRow(env: Env, organizationId: string): Promise<CrewStageRow | null> {
  return env.DB.prepare(`
    SELECT * FROM crew_stages WHERE clerk_organization_id = ? LIMIT 1
  `).bind(organizationId).first<CrewStageRow>();
}

async function clearExpiredDirectReservation(env: Env, organizationId: string): Promise<void> {
  await env.DB.prepare(`
    DELETE FROM crew_stages
    WHERE clerk_organization_id = ?
      AND status = 'reserved'
      AND generation_charge_id IS NULL
      AND datetime(reservation_expires_at) <= datetime('now')
  `).bind(organizationId).run();
}

export async function getCrewStageStatus(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const organizationId = activeOrganization(auth);
  if (organizationId instanceof Response) return organizationId;
  await clearExpiredDirectReservation(env, organizationId);
  const stage = await getCrewStageRow(env, organizationId);
  const eligibility = !stage && canManageCrew(auth)
    ? await getCrewStageEligibility(env, organizationId)
    : null;
  const canResumeCreate = stage?.status === 'reserved'
    && stage.created_by_user_id === auth.userId
    && Boolean(stage.generation_charge_id)
    && canManageCrew(auth)
    && Boolean(await env.DB.prepare(`
      SELECT 1 AS resumable
      FROM generation_charges charge
      JOIN provider_sessions session ON session.charge_id = charge.id
      WHERE charge.id = ? AND charge.user_id = ? AND charge.reason = 'crew_stage_included'
        AND charge.status = 'reserved' AND datetime(charge.expires_at) > datetime('now')
        AND session.status = 'active' AND datetime(session.expires_at) > datetime('now')
        AND session.provider_calls_used = 0
      LIMIT 1
    `).bind(stage.generation_charge_id, auth.userId).first());
  return json({
    claimState: stage?.status ?? 'available',
    canCreate: Boolean(eligibility?.eligible),
    canResumeCreate: Boolean(canResumeCreate),
    eligibilityReason: eligibility && !eligibility.eligible
      ? (eligibility.unavailable ? 'crew_stage_verification_unavailable' : 'crew_stage_friend_required')
      : null,
    stage: stage?.status === 'ready' ? serializeReadyStage(request, stage) : null,
  });
}

export async function uploadCrewStage(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const organizationId = activeOrganization(auth);
  if (organizationId instanceof Response) return organizationId;
  if (!canManageCrew(auth)) {
    return json({ error: 'Only a Crew admin can lock the shared Crew stage' }, 403);
  }

  const form = await readMultipartFormData(request, MAX_CREW_STAGE_MULTIPART_BYTES);
  const label = normalizeStageLabel(form.get('label'));
  const kind = parseStageKind(form.get('kind'));
  const purchaseIdValue = form.get('purchaseId');
  const purchaseId = typeof purchaseIdValue === 'string' && /^[a-f0-9]{32}$/.test(purchaseIdValue)
    ? purchaseIdValue
    : null;
  const fileValue = form.get('file');
  const source = parseStageSource(form.get('source'));
  if (!label) return json({ error: 'Stage name must be between 1 and 42 characters' }, 400);
  if (!kind) return json({ error: 'Stage kind must be forged or direct photo' }, 400);
  if (!fileValue || typeof fileValue === 'string') return json({ error: 'Stage image is required' }, 400);
  const file = fileValue as File;
  if (file.size > MAX_CREW_STAGE_BYTES) return json({ error: 'Stage image is too large' }, 413);
  if (file.type && file.type.toLowerCase() !== 'image/png') {
    return json({ error: 'Crew stages must be uploaded as PNG' }, 415);
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_CREW_STAGE_BYTES) return json({ error: 'Stage image is too large' }, 413);
  if (!isPngAtStageDimensions(bytes)) {
    return json({ error: `Crew stages must be ${STAGE_WIDTH}×${STAGE_HEIGHT} PNG images` }, 415);
  }

  await clearExpiredDirectReservation(env, organizationId);
  let claim = await getCrewStageRow(env, organizationId);
  let directClaimCreated = false;
  if (kind === 'photo-direct') {
    if (claim) {
      return json({
        error: claim.status === 'ready'
          ? 'This Crew has already locked its one included stage'
          : 'This Crew stage is already being created',
        code: claim.status === 'ready' ? 'crew_stage_already_claimed' : 'crew_stage_reserved',
      }, 409);
    }
    const eligibilityError = crewStageEligibilityError(await getCrewStageEligibility(env, organizationId));
    if (eligibilityError) return eligibilityError;
    const stageId = generateId();
    const reservationExpiresAt = new Date(
      Date.now() + DIRECT_UPLOAD_RESERVATION_MINUTES * 60 * 1000,
    ).toISOString();
    claim = await env.DB.prepare(`
      INSERT INTO crew_stages (
        clerk_organization_id, id, created_by_user_id, status, label, reservation_expires_at
      )
      SELECT ?, ?, ?, 'reserved', 'CREW STAGE', ?
      WHERE NOT EXISTS (
        SELECT 1 FROM crew_stages WHERE clerk_organization_id = ?
      )
      RETURNING *
    `).bind(
      organizationId,
      stageId,
      auth.userId,
      reservationExpiresAt,
      organizationId,
    ).first<CrewStageRow>();
    if (!claim) {
      return json({ error: 'This Crew stage is already being created', code: 'crew_stage_reserved' }, 409);
    }
    directClaimCreated = true;
  } else {
    if (!purchaseId) {
      return json({ error: 'The included Crew forge authorization is required' }, 409);
    }
    const authorized = await env.DB.prepare(`
      SELECT cs.*
      FROM crew_stages cs
      JOIN generation_charges charge
        ON charge.id = cs.generation_charge_id
       AND charge.user_id = ?
       AND charge.reason = 'crew_stage_included'
       AND charge.status = 'committed'
      WHERE cs.clerk_organization_id = ?
        AND cs.generation_charge_id = ?
        AND cs.created_by_user_id = ?
        AND cs.status = 'reserved'
      LIMIT 1
    `).bind(auth.userId, organizationId, purchaseId, auth.userId).first<CrewStageRow>();
    if (!authorized) {
      return json({
        error: claim?.status === 'ready'
          ? 'This Crew has already locked its one included stage'
          : 'This forge is not the active included Crew stage',
        code: claim?.status === 'ready' ? 'crew_stage_already_claimed' : 'crew_stage_authorization_required',
      }, 409);
    }
    claim = authorized;
  }

  const contentHash = await hashString(bytes);
  // Each upload writes its own object. Concurrent forged-upload retries may
  // race to finalize the same claim; the losing request must never overwrite
  // or delete the winner's image.
  const blobKey = `crews/${organizationId}/stages/${claim.id}/${generateId()}.png`;
  try {
    await env.SPRITES.put(blobKey, bytes, { httpMetadata: { contentType: 'image/png' } });
    const ready = await env.DB.prepare(`
      UPDATE crew_stages
      SET status = 'ready', label = ?, kind = ?, blob_key = ?, content_hash = ?, source_json = ?,
          reservation_expires_at = NULL, updated_at = datetime('now')
      WHERE clerk_organization_id = ? AND id = ? AND status = 'reserved'
      RETURNING *
    `).bind(
      label,
      kind,
      blobKey,
      contentHash,
      source ? JSON.stringify(source) : null,
      organizationId,
      claim.id,
    ).first<CrewStageRow>();
    if (!ready) {
      await env.SPRITES.delete(blobKey);
      return json({ error: 'The Crew stage slot changed before it could be saved' }, 409);
    }
    return json({ stage: serializeReadyStage(request, ready), claimState: 'ready', canCreate: false }, 201);
  } catch (error) {
    try {
      await env.SPRITES.delete(blobKey);
      if (directClaimCreated) {
        await env.DB.prepare(`
          DELETE FROM crew_stages
          WHERE clerk_organization_id = ? AND id = ? AND status = 'reserved'
            AND generation_charge_id IS NULL
        `).bind(organizationId, claim.id).run();
      }
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Crew stage save and cleanup both failed');
    }
    throw error;
  }
}

export async function getCrewStageAsset(
  env: Env,
  auth: AuthContext,
  stageId: string,
): Promise<Response> {
  const organizationId = activeOrganization(auth);
  if (organizationId instanceof Response) return organizationId;
  if (!/^[a-f0-9]{32}$/.test(stageId)) return json({ error: 'Crew stage not found' }, 404);
  const stage = await env.DB.prepare(`
    SELECT blob_key, content_hash
    FROM crew_stages
    WHERE id = ? AND clerk_organization_id = ? AND status = 'ready'
    LIMIT 1
  `).bind(stageId, organizationId).first<{ blob_key: string; content_hash: string }>();
  if (!stage) return json({ error: 'Crew stage not found' }, 404);
  const object = await env.SPRITES.get(stage.blob_key);
  if (!object) return json({ error: 'Crew stage asset is missing' }, 404);
  const headers = new Headers({
    'Content-Type': 'image/png',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    ETag: `"${stage.content_hash}"`,
  });
  return new Response(object.body, { headers });
}

export async function deleteCrewStageForOrganization(
  env: Env,
  organizationId: string,
): Promise<void> {
  const stage = await getCrewStageRow(env, organizationId);
  if (stage?.blob_key) await env.SPRITES.delete(stage.blob_key);
  await env.DB.prepare('DELETE FROM crew_stages WHERE clerk_organization_id = ?')
    .bind(organizationId).run();
}
