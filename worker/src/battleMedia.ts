import { createHash } from 'node:crypto';
import { storeBattleVideo } from './battleVideoStorage';
import { BATTLE_RECORDING_MAX_BYTES, BATTLE_STILL_MAX_BYTES, type BattleSummary, type SavedBattle } from '../../src/shared/BattleFinisher';
import { generateId } from './auth';
import { publicFrontendOrigin } from './branding';
import { readJsonBody, createBoundedRequestStream } from './requestBody';
import { parseGenerationLegalAttestation, prepareLegalAcceptance } from './legal';
import { enforceRateLimit } from './rateLimit';
import type { Env, PublicAuthContext } from './types';
import { FINISHER_MODEL, FINISHER_PROMPT_VERSION } from './battleFinisherProvider';

export interface BattleRow {
  id: string; owner_user_id: string | null; client_battle_id: string; summary_json: string;
  still_sha256: string; storage_prefix: string; status: 'preparing' | 'ready' | 'revoked';
  published: number; recording_type: string | null; recording_sha256: string | null; recording_key: string | null;
  created_at: string; updated_at: string;
}
export interface FinisherJobRow {
  id: string; battle_id: string; owner_user_id: string | null; request_id: string;
  status: 'queued' | 'submitting' | 'generating' | 'ready' | 'failed'; credit_state: 'reserved' | 'spent' | 'refunded';
  model: string; prompt_version: string; provider_attempt_id: string | null; provider_request_id: string | null;
  provider_status_url: string | null; provider_response_url: string | null; provider_cost_cents: number;
  video_sha256: string | null; video_bytes: number | null; error_code: string | null; created_at: string; updated_at: string;
}
const ID = /^[a-f0-9]{32}$/;
const CLIENT_ID = /^[a-zA-Z0-9_-]{16,100}$/;
const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
export const battleJson = (value: unknown, status = 200) => Response.json(value, { status, headers: HEADERS });
const unavailable = () => battleJson({ error: 'This battle is unavailable.', code: 'battle_unavailable' }, 404);
export function battleStillKey(battle: BattleRow): string { return `${battle.storage_prefix}still.jpg`; }
export function finisherVideoKey(battle: BattleRow, job: FinisherJobRow): string { return `${battle.storage_prefix}finishers/${job.id}.mp4`; }
export async function loadBattle(env: Env, id: string): Promise<BattleRow | null> {
  if (!ID.test(id)) return null;
  return env.DB.prepare('SELECT * FROM battle_media WHERE id = ?').bind(id).first<BattleRow>();
}
export async function loadFinisherJob(env: Env, id: string): Promise<FinisherJobRow | null> {
  return env.DB.prepare('SELECT * FROM battle_finisher_jobs WHERE id = ?').bind(id).first<FinisherJobRow>();
}
async function latestJob(env: Env, battleId: string): Promise<FinisherJobRow | null> {
  return env.DB.prepare("SELECT * FROM battle_finisher_jobs WHERE battle_id = ? ORDER BY CASE WHEN status = 'ready' THEN 0 ELSE 1 END, created_at DESC, rowid DESC LIMIT 1").bind(battleId).first<FinisherJobRow>();
}
function canRead(row: BattleRow | null, userId: string | null): row is BattleRow {
  return Boolean(row && row.status === 'ready' && row.owner_user_id && (row.published || row.owner_user_id === userId));
}
export async function serializeBattle(request: Request, env: Env, row: BattleRow, userId: string | null): Promise<SavedBattle> {
  const api = `${new URL(request.url).origin}/api/battles/${row.id}`;
  const job = await latestJob(env, row.id);
  return { id: row.id, summary: JSON.parse(row.summary_json), createdAt: row.created_at,
    published: Boolean(row.published), isOwner: row.owner_user_id === userId,
    stillUrl: `${api}/still`, ...(row.recording_key ? { recordingUrl: `${api}/recording` } : {}),
    ...(job ? { finisher: { id: job.id, status: job.status === 'submitting' ? 'generating' as const : job.status,
      creditRefunded: job.credit_state === 'refunded', ...(job.status === 'failed' ? { error: 'Your finisher could not be completed. The credit was returned.' } : {}),
      ...(job.status === 'ready' ? { videoUrl: `${api}/finisher` } : {}) } } : {}),
    shareUrl: `${publicFrontendOrigin(env)}/battles/${row.id}`,
    finisherShareUrl: `${publicFrontendOrigin(env)}/battles/${row.id}/finisher`,
    ogImageUrl: `${new URL(request.url).origin}/share/battles/${row.id}/og.png`,
  };
}
function textField(value: unknown, max = 64): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 && text.length <= max && !/[\x00-\x1f\x7f]/.test(text) ? text : null;
}
export function parseBattleSummary(value: unknown): BattleSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const { game, winner, durationSeconds } = data;
  if (!['fight', 'aura', 'rush'].includes(String(game)) || !['p1', 'p2', 'draw', 'team', 'rivals'].includes(String(winner))
    || (game === 'rush' ? !['team', 'rivals'].includes(String(winner)) : ['team', 'rivals'].includes(String(winner)))
    || typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 86400) return null;
  const p1Name = textField(data.p1Name), p2Name = textField(data.p2Name), stageLabel = textField(data.stageLabel, 100);
  if (!p1Name || !p2Name || !stageLabel) return null;
  const summary: BattleSummary = { game: game as BattleSummary['game'], winner: winner as BattleSummary['winner'], p1Name, p2Name, stageLabel, durationSeconds };
  if (data.winnerSide !== undefined) { if (data.winnerSide !== 'left' && data.winnerSide !== 'right') return null; summary.winnerSide = data.winnerSide; }
  for (const key of ['p1Score', 'p2Score', 'seed'] as const) {
    const value = data[key];
    if (value !== undefined) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) return null;
      summary[key] = value;
    }
  }
  for (const key of ['stageId', 'rank'] as const) {
    if (data[key] !== undefined) { const value = textField(data[key], key === 'rank' ? 24 : 100); if (!value) return null; summary[key] = value; }
  }
  return summary;
}
export function decodeBattleStill(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value.length > Math.ceil(BATTLE_STILL_MAX_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  try {
    const raw = atob(value), bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
    if (bytes.length < 24 || bytes.length > BATTLE_STILL_MAX_BYTES || btoa(raw) !== value
      || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
    // A real JPEG frame header with bounded dimensions; no arbitrary asset URLs.
    for (let i = 2; i + 8 < bytes.length;) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1], length = bytes[i + 2] * 256 + bytes[i + 3];
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        const height = bytes[i + 5] * 256 + bytes[i + 6], width = bytes[i + 7] * 256 + bytes[i + 8];
        return width >= 64 && height >= 64 && width <= 4096 && height <= 4096 ? bytes : null;
      }
      if (length < 2) return null;
      i += length + 2;
    }
    return null;
  } catch { return null; }
}
export async function createBattle(request: Request, env: Env, auth: PublicAuthContext): Promise<Response> {
  if (!auth.userId) return battleJson({ error: 'Sign in to save your battle.' }, 401);
  const body = await readJsonBody<Record<string, unknown>>(request, Math.ceil(BATTLE_STILL_MAX_BYTES / 3) * 4 + 8192);
  const summary = parseBattleSummary(body.summary), still = decodeBattleStill(body.stillBase64);
  if (typeof body.clientBattleId !== 'string' || !CLIENT_ID.test(body.clientBattleId) || !summary || !still) return battleJson({ error: 'The battle snapshot is incomplete.', code: 'invalid_battle' }, 400);
  const summaryJson = JSON.stringify(summary), hash = createHash('sha256').update(still).digest('hex');
  let existing = await env.DB.prepare('SELECT * FROM battle_media WHERE owner_user_id = ? AND client_battle_id = ?').bind(auth.userId, body.clientBattleId).first<BattleRow>();
  if (!existing) {
    const limit = await enforceRateLimit(env, 'battle:create', auth); if (limit) return limit;
    const id = generateId(), now = new Date().toISOString();
    await env.DB.prepare(`INSERT OR IGNORE INTO battle_media (id, owner_user_id, client_battle_id, summary_json, still_sha256, storage_prefix, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)`)
      .bind(id, auth.userId, body.clientBattleId, summaryJson, hash, `users/${auth.userId}/battles/${id}/`, now, now, auth.userId).run();
    existing = await env.DB.prepare('SELECT * FROM battle_media WHERE owner_user_id = ? AND client_battle_id = ?').bind(auth.userId, body.clientBattleId).first<BattleRow>();
  }
  if (!existing || existing.status === 'revoked') return unavailable();
  if (existing.summary_json !== summaryJson || existing.still_sha256 !== hash) return battleJson({ error: 'This battle already has a different snapshot.', code: 'battle_conflict' }, 409);
  if (existing.status === 'preparing') {
    const stillKey = battleStillKey(existing);
    await env.SPRITES.put(stillKey, still, { httpMetadata: { contentType: 'image/jpeg', cacheControl: 'private, no-store' } });
    const updated = await env.DB.prepare(`UPDATE battle_media SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'preparing'
      AND EXISTS (SELECT 1 FROM users WHERE id = owner_user_id) RETURNING *`).bind(new Date().toISOString(), existing.id).first<BattleRow>();
    existing = updated ?? await loadBattle(env, existing.id);
    if (!existing || existing.status !== 'ready') { await env.SPRITES.delete(stillKey); return unavailable(); }
  }
  return battleJson({ battle: await serializeBattle(request, env, existing, auth.userId) }, 201);
}
export async function getBattle(request: Request, env: Env, auth: PublicAuthContext, id: string): Promise<Response> {
  const battle = await loadBattle(env, id); if (!canRead(battle, auth.userId)) return unavailable();
  return battleJson({ battle: await serializeBattle(request, env, battle, auth.userId) });
}
export async function listBattles(request: Request, env: Env, auth: PublicAuthContext): Promise<Response> {
  if (!auth.userId) return battleJson({ error: 'Sign in to see your battles.' }, 401);
  const rows = await env.DB.prepare("SELECT * FROM battle_media WHERE owner_user_id = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 50").bind(auth.userId).all<BattleRow>();
  return battleJson({ battles: await Promise.all((rows.results ?? []).map(row => serializeBattle(request, env, row, auth.userId))) });
}
export async function publishBattle(request: Request, env: Env, auth: PublicAuthContext, id: string): Promise<Response> {
  if (!auth.userId) return battleJson({ error: 'Sign in to publish your battle.' }, 401);
  const row = await env.DB.prepare("UPDATE battle_media SET published = 1, updated_at = ? WHERE id = ? AND owner_user_id = ? AND status = 'ready' RETURNING *")
    .bind(new Date().toISOString(), id, auth.userId).first<BattleRow>();
  return row ? battleJson({ battle: await serializeBattle(request, env, row, auth.userId) }) : unavailable();
}
export async function deleteBattle(_request: Request, env: Env, auth: PublicAuthContext, id: string): Promise<Response> {
  if (!auth.userId) return battleJson({ error: 'Sign in to remove your battle.' }, 401);
  const battle = await loadBattle(env, id); if (!battle || battle.owner_user_id !== auth.userId) return unavailable();
  await env.DB.prepare("UPDATE battle_media SET status = 'revoked', published = 0, updated_at = ? WHERE id = ? AND owner_user_id = ?").bind(new Date().toISOString(), id, auth.userId).run();
  const jobs = await env.DB.prepare("SELECT id FROM battle_finisher_jobs WHERE battle_id = ? AND credit_state = 'reserved'").bind(id).all<{ id: string }>();
  for (const job of jobs.results ?? []) await failFinisher(env, job.id, 'battle_removed');
  return new Response(null, { status: 204, headers: HEADERS });
}
export async function uploadBattleRecording(request: Request, env: Env, auth: PublicAuthContext, id: string): Promise<Response> {
  const battle = await loadBattle(env, id);
  if (!auth.userId) return battleJson({ error: 'Sign in to save your recording.' }, 401);
  if (!battle || battle.owner_user_id !== auth.userId || battle.status !== 'ready') return unavailable();
  const limited = await enforceRateLimit(env, 'battle:recording', auth); if (limited) return limited;
  const type = request.headers.get('Content-Type')?.split(';')[0];
  if (type !== 'video/mp4' && type !== 'video/webm') return battleJson({ error: 'Use an MP4 or WebM recording.' }, 415);
  const bounded = createBoundedRequestStream(request, BATTLE_RECORDING_MAX_BYTES); if (!bounded.body) return battleJson({ error: 'Recording is empty.' }, 400);
  const key = `${battle.storage_prefix}recordings/${generateId()}`;
  try {
    const stored = await storeBattleVideo(env.SPRITES, key, bounded.body, type, BATTLE_RECORDING_MAX_BYTES);
    const digest = stored.sha256;
    const updated = await env.DB.prepare(`UPDATE battle_media SET recording_key = ?, recording_type = ?, recording_sha256 = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND status = 'ready' AND recording_key IS NULL
      AND EXISTS (SELECT 1 FROM users WHERE id = owner_user_id) RETURNING *`)
      .bind(key, type, digest, new Date().toISOString(), id, auth.userId).first<BattleRow>();
    if (updated) return battleJson({ battle: await serializeBattle(request, env, updated, auth.userId) });
    await env.SPRITES.delete(key);
    const current = await loadBattle(env, id);
    if (!canRead(current, auth.userId) || current.owner_user_id !== auth.userId) return unavailable();
    if (current.recording_sha256 !== digest) return battleJson({ error: 'This battle already has a different recording.' }, 409);
    return battleJson({ battle: await serializeBattle(request, env, current, auth.userId) });
  } catch (error) { await env.SPRITES.delete(key).catch(() => undefined); throw error; }
}
export async function getBattleMedia(request: Request, env: Env, auth: PublicAuthContext, id: string, kind: string): Promise<Response> {
  const battle = await loadBattle(env, id); if (!canRead(battle, auth.userId)) return unavailable();
  const job = kind === 'finisher' ? await latestJob(env, id) : null;
  const key = kind === 'still' ? battleStillKey(battle) : kind === 'recording' ? battle.recording_key : job?.status === 'ready' ? finisherVideoKey(battle, job) : null;
  if (!key) return unavailable();
  const object = await env.SPRITES.get(key, { range: request.headers }); if (!object) return unavailable();
  const headers = new Headers(HEADERS); object.writeHttpMetadata(headers); headers.set('Cache-Control', 'private, no-store');
  headers.set('Accept-Ranges', 'bytes'); headers.set('ETag', object.httpEtag);
  const range = request.headers.has('Range') && object.range && 'offset' in object.range && typeof object.range.offset === 'number' && typeof object.range.length === 'number' ? object.range as { offset: number; length: number } : null;
  if (range) { headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`); headers.set('Content-Length', String(range.length)); }
  else headers.set('Content-Length', String(object.size));
  if (new URL(request.url).searchParams.get('download') === '1') headers.set('Content-Disposition', `attachment; filename="insert-player-${kind}-${id}.${kind === 'still' ? 'jpg' : kind === 'recording' && battle.recording_type === 'video/webm' ? 'webm' : 'mp4'}"`);
  return new Response(request.method === 'HEAD' ? null : object.body, { status: range ? 206 : 200, headers });
}
export async function startFinisherWorkflow(env: Env, jobId: string): Promise<void> {
  if (!env.BATTLE_FINISHER) throw new Error('Finisher workflow unavailable');
  try { await env.BATTLE_FINISHER.create({ id: jobId, params: { jobId }, retention: { successRetention: '30 days', errorRetention: '30 days' } }); }
  catch (error) { const status = await env.BATTLE_FINISHER.get(jobId).then(instance => instance.status()).catch(() => null); if (!status || status.status === 'unknown') throw error; }
}
export async function createBattleFinisher(request: Request, env: Env, auth: PublicAuthContext, id: string): Promise<Response> {
  if (!auth.userId) return battleJson({ error: 'Sign in to create a finisher.' }, 401);
  const battle = await loadBattle(env, id); if (!battle || battle.owner_user_id !== auth.userId || battle.status !== 'ready') return unavailable();
  const body = await readJsonBody<Record<string, unknown>>(request, 8192);
  if (typeof body.requestId !== 'string' || !CLIENT_ID.test(body.requestId)) return battleJson({ error: 'A stable requestId is required.' }, 400);
  const existing = await env.DB.prepare('SELECT * FROM battle_finisher_jobs WHERE owner_user_id = ? AND request_id = ?').bind(auth.userId, body.requestId).first<FinisherJobRow>();
  if (existing && existing.battle_id !== id) return battleJson({ error: 'This request belongs to another battle.' }, 409);
  const active = existing ?? await env.DB.prepare("SELECT * FROM battle_finisher_jobs WHERE battle_id = ? AND status IN ('queued','submitting','generating','ready')").bind(id).first<FinisherJobRow>();
  if (active) {
    if (active.status === 'queued') await startFinisherWorkflow(env, active.id).catch(() => undefined);
    return battleJson({ battle: await serializeBattle(request, env, battle, auth.userId) });
  }
  const legal = parseGenerationLegalAttestation(body.legal); if (!legal) return battleJson({ error: 'Current generation consent is required.' }, 428);
  if (!env.FAL_API_KEY || !env.BATTLE_FINISHER) return battleJson({ error: 'Finishers are temporarily unavailable. No credit was used.' }, 503);
  const limit = await enforceRateLimit(env, 'battle:finisher', auth); if (limit) return limit;
  const jobId = generateId(), now = new Date().toISOString();
  // Durable rows and a single ledger marker make two clicks, retries, and two tabs one purchase.
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO battle_finisher_jobs (id, battle_id, owner_user_id, request_id, status, credit_state, model, prompt_version, created_at, updated_at)
      SELECT ?, ?, ?, ?, 'queued', 'reserved', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND credits_balance >= 1)
      AND EXISTS (SELECT 1 FROM battle_media WHERE id = ? AND owner_user_id = ? AND status = 'ready')`)
      .bind(jobId, id, auth.userId, body.requestId, FINISHER_MODEL, FINISHER_PROMPT_VERSION, now, now, auth.userId, id, auth.userId),
    env.DB.prepare(`INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
      SELECT ?, owner_user_id, -1, 'battle_finisher', NULL FROM battle_finisher_jobs WHERE id = ?`).bind(`finisher:${jobId}:reserve`, jobId),
    env.DB.prepare(`UPDATE users SET credits_balance = credits_balance - 1, updated_at = datetime('now')
      WHERE id = ? AND EXISTS (SELECT 1 FROM credit_ledger WHERE id = ?)`).bind(auth.userId, `finisher:${jobId}:reserve`),
    // Existing intro_video consent category covers one-off generated video; context identifies this feature.
    await prepareLegalAcceptance(env, auth, 'intro_video', legal, `battle-finisher:${jobId}`),
  ]);
  const created = await loadFinisherJob(env, jobId);
  if (!created) {
    const requestOwner = await env.DB.prepare('SELECT battle_id FROM battle_finisher_jobs WHERE owner_user_id = ? AND request_id = ?').bind(auth.userId, body.requestId).first<{ battle_id: string }>();
    if (requestOwner && requestOwner.battle_id !== id) return battleJson({ error: 'This request belongs to another battle.' }, 409);
    const concurrent = await latestJob(env, id);
    if (concurrent && concurrent.status !== 'failed') return battleJson({ battle: await serializeBattle(request, env, battle, auth.userId) });
    return battleJson({ error: 'You need 1 credit to create a finisher.', requiredCredits: 1, code: 'insufficient_credits' }, 402);
  }
  try { await startFinisherWorkflow(env, jobId); }
  catch { /* Accepted work remains queued; maintenance starts the same immutable workflow ID. */ }
  return battleJson({ battle: await serializeBattle(request, env, battle, auth.userId) }, 202);
}
/** Returning a credit is independent of provider spend; the product charges only for a durable playable result. */
export async function failFinisher(env: Env, id: string, code: string): Promise<void> {
  const refundId = `finisher:${id}:refund`;
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO credit_ledger (id, user_id, delta, reason, fighter_id)
      SELECT ?, job.owner_user_id, 1, 'battle_finisher_refund', NULL FROM battle_finisher_jobs job
      JOIN users ON users.id = job.owner_user_id WHERE job.id = ? AND job.credit_state = 'reserved' AND job.status <> 'ready'`).bind(refundId, id),
    env.DB.prepare(`UPDATE users SET credits_balance = credits_balance + 1, updated_at = datetime('now')
      WHERE id = (SELECT owner_user_id FROM battle_finisher_jobs WHERE id = ? AND credit_state = 'reserved')
      AND EXISTS (SELECT 1 FROM credit_ledger WHERE id = ?)`).bind(id, refundId),
    env.DB.prepare(`UPDATE battle_finisher_jobs SET status = 'failed', credit_state = 'refunded', error_code = ?, updated_at = ?
      WHERE id = ? AND status <> 'ready' AND credit_state = 'reserved'`).bind(code.slice(0, 100), new Date().toISOString(), id),
  ]);
}
export async function cleanupBattleMedia(env: Env): Promise<void> {
  const queued = await env.DB.prepare("SELECT id, created_at FROM battle_finisher_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 50").all<{ id: string; created_at: string }>();
  for (const job of queued.results ?? []) {
    if (Date.parse(job.created_at) < Date.now() - 60 * 60 * 1000) await failFinisher(env, job.id, 'queue_expired');
    else await startFinisherWorkflow(env, job.id).catch(() => undefined);
  }
  const stale = await env.DB.prepare("SELECT id FROM battle_finisher_jobs WHERE status IN ('submitting','generating') AND updated_at < ?").bind(new Date(Date.now() - 60 * 60 * 1000).toISOString()).all<{ id: string }>();
  for (const job of stale.results ?? []) await failFinisher(env, job.id, 'generation_timeout');
  const rows = await env.DB.prepare("SELECT * FROM battle_media WHERE (status = 'revoked' OR (status = 'preparing' AND updated_at < ?)) AND (cleanup_at IS NULL OR cleanup_at < ?) ORDER BY COALESCE(cleanup_at, '') ASC LIMIT 50").bind(new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() - 86400000).toISOString()).all<BattleRow>();
  for (const battle of rows.results ?? []) {
    const objects = await env.SPRITES.list({ prefix: battle.storage_prefix, limit: 1000 });
    if (objects.objects.length) await env.SPRITES.delete(objects.objects.map(object => object.key));
    // Retain the tombstone for late provider completions, but remove personal metadata.
    await env.DB.prepare("UPDATE battle_media SET status = 'revoked', owner_user_id = NULL, published = 0, summary_json = '{}', recording_key = NULL, cleanup_at = ? WHERE id = ?").bind(objects.truncated ? null : new Date().toISOString(), battle.id).run();
  }
}
