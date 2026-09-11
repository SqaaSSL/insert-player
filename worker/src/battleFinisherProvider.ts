import { createHash } from 'node:crypto';
import { storeBattleVideo } from './battleVideoStorage';
import type { BattleSummary } from '../../src/shared/BattleFinisher';
import type { Env } from './types';
import { generateId } from './auth';
import { battleStillKey, finisherVideoKey, loadBattle, loadFinisherJob, type FinisherJobRow } from './battleMedia';

export const FINISHER_MODEL = 'minimax/h3-max-turbo/image-to-video';
export const FINISHER_PROMPT_VERSION = 'arcade-finisher-v1';
const QUEUE_ORIGIN = 'https://queue.fal.run';
const VIDEO_MAX_BYTES = 48 * 1024 * 1024;
export function buildBattleFinisherPrompt(summary: BattleSummary): string {
  const winner = (summary.winner === 'p1' || summary.winner === 'p2') && summary.winnerSide ? `the ${summary.winnerSide}-side player`
    : summary.winner === 'p2' ? 'the player identified as P2 in the game HUD, wherever they stand' : summary.winner === 'p1' ? 'the player identified as P1 in the game HUD, wherever they stand'
    : summary.winner === 'team' ? 'the player team' : summary.winner === 'rivals' ? 'the rival team' : 'both players';
  const action = summary.game === 'aura'
    ? 'The winner performs a spectacular playful aura-farming victory move. A glowing aura ripples across the stage; the defeated player gives a funny stunned reaction. The crowd cheers.'
    : summary.game === 'rush'
      ? 'The winning side lands one spectacular fantastical arcade energy finisher; the defeated side tumbles comically and safely, then the winning side celebrates.'
      : 'The winner performs one spectacular fantastical arcade energy finisher. The defeated player recoils into a comic knockout pose; the winner holds a triumphant final pose.';
  return `Animate this exact final frame of a fictional stylized arcade videogame. Preserve its characters, faces, clothing, pixel-art appearance, stage, player positions and winner/loser relationship. The winner is ${winner}. ${summary.winner === 'draw' ? 'Both players trade a friendly salute and celebrate a dazzling shared finish.' : action} Five seconds, one continuous shot: start on the supplied frame, build anticipation, deliver one clear spectacle, and end on a readable victory pose. Synchronized energetic game sound effects and a short victory sting. No speech or written text. No photorealism, gore, blood, wounds, dismemberment, death, sexual content or harm to bystanders. All bystanders remain safe. Do not invent another player or reverse the result.`;
}
export function validFalQueueUrl(value: unknown, requestId?: string): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.origin !== QUEUE_ORIGIN || url.username || url.password || url.hash || url.search
      || !/^\/minimax\/h3-max-turbo(?:\/image-to-video)?\/requests\/[A-Za-z0-9_-]+(?:\/status)?$/.test(url.pathname)
      || (requestId && url.pathname.match(/\/requests\/([^/]+)/)?.[1] !== requestId)) return null;
    return url.toString();
  } catch { return null; }
}
export function validFalVideoUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.port && !url.username && !url.password
    && (url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media')) ? url.href : null; } catch { return null; }
}
function toBase64(bytes: Uint8Array): string {
  let binary = ''; for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(binary);
}
async function falJson(env: Env, url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, redirect: 'error', headers: { Authorization: `Key ${env.FAL_API_KEY}`, 'Content-Type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`fal_http_${response.status}`);
  const text = await response.text(); if (text.length > 128 * 1024) throw new Error('fal_response_too_large');
  const data = JSON.parse(text); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('fal_invalid_response');
  return data as Record<string, unknown>;
}
/** Every paid POST has a durable claim before dispatch. Unknown outcomes never cause another automatic POST. */
export async function submitFinisher(env: Env, id: string): Promise<FinisherJobRow | null> {
  const job = await loadFinisherJob(env, id);
  if (!job || ['ready', 'failed'].includes(job.status)) return job;
  if (job.provider_request_id) return job;
  if (job.provider_attempt_id) throw new Error('provider_submission_unconfirmed');
  const battle = await loadBattle(env, job.battle_id);
  if (!battle || battle.status !== 'ready' || !battle.owner_user_id || battle.owner_user_id !== job.owner_user_id) throw new Error('battle_removed');
  const source = await env.SPRITES.get(battleStillKey(battle)); if (!source) throw new Error('source_unavailable');
  const bytes = new Uint8Array(await source.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== battle.still_sha256) throw new Error('source_changed');
  const prompt = buildBattleFinisherPrompt(JSON.parse(battle.summary_json));
  const payload = { image_url: `data:image/jpeg;base64,${toBase64(bytes)}`, prompt, duration: 5, resolution: '768P', prompt_expansion_mode: 'fast', enable_safety_checker: true, sync_mode: false };
  const attemptId = generateId(), period = new Date().toISOString().slice(0, 7);
  await env.DB.batch([
    env.DB.prepare(`UPDATE battle_finisher_jobs SET status = 'submitting', provider_attempt_id = ?, provider_audit_json = ?, updated_at = ?
      WHERE id = ? AND status = 'queued' AND credit_state = 'reserved' AND provider_attempt_id IS NULL
      AND EXISTS (SELECT 1 FROM battle_media battle JOIN users ON users.id = battle.owner_user_id WHERE battle.id = battle_id AND battle.status = 'ready')`)
      .bind(attemptId, JSON.stringify({ model: FINISHER_MODEL, promptVersion: FINISHER_PROMPT_VERSION, sourceSha256: battle.still_sha256,
        promptSha256: createHash('sha256').update(prompt).digest('hex'), duration: 5, resolution: '768P', estimatedCostCents: 20 }), new Date().toISOString(), id),
    env.DB.prepare(`INSERT INTO provider_spend_months (period, estimated_cost_cents, provider_calls)
      SELECT ?, 20, 1 WHERE EXISTS (SELECT 1 FROM battle_finisher_jobs WHERE id = ? AND provider_attempt_id = ?)
      ON CONFLICT(period) DO UPDATE SET estimated_cost_cents = estimated_cost_cents + 20, provider_calls = provider_calls + 1, updated_at = datetime('now')`).bind(period, id, attemptId),
  ]);
  const claimed = await loadFinisherJob(env, id); if (claimed?.provider_attempt_id !== attemptId) throw new Error('provider_submission_unconfirmed');
  const response = await falJson(env, `${QUEUE_ORIGIN}/${FINISHER_MODEL}`, { method: 'POST', body: JSON.stringify(payload) });
  const requestId = typeof response.request_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(response.request_id) ? response.request_id : null;
  const statusUrl = validFalQueueUrl(response.status_url, requestId ?? undefined), responseUrl = validFalQueueUrl(response.response_url, requestId ?? undefined);
  if (!requestId || !statusUrl || !responseUrl || !statusUrl.endsWith('/status') || responseUrl.endsWith('/status')) throw new Error('provider_invalid_submission');
  await env.DB.prepare(`UPDATE battle_finisher_jobs SET status = 'generating', provider_request_id = ?, provider_status_url = ?, provider_response_url = ?, updated_at = ?
    WHERE id = ? AND provider_attempt_id = ? AND status = 'submitting' AND credit_state = 'reserved'`)
    .bind(requestId, statusUrl, responseUrl, new Date().toISOString(), id, attemptId).run();
  return loadFinisherJob(env, id);
}
export async function pollFinisher(env: Env, id: string): Promise<'pending' | 'ready' | 'stopped'> {
  const job = await loadFinisherJob(env, id);
  if (!job || job.status === 'failed') return 'stopped';
  if (job.status === 'ready') return 'ready';
  const battle = await loadBattle(env, job.battle_id);
  if (!battle || battle.status !== 'ready' || !battle.owner_user_id || battle.owner_user_id !== job.owner_user_id) throw new Error('battle_removed');
  if (!job.provider_request_id || !validFalQueueUrl(job.provider_status_url, job.provider_request_id) || !validFalQueueUrl(job.provider_response_url, job.provider_request_id)) throw new Error('provider_invalid_submission');
  const status = await falJson(env, job.provider_status_url!);
  if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') return 'pending';
  if (status.status !== 'COMPLETED') throw new Error('provider_failed');
  const result = await falJson(env, job.provider_response_url!);
  const video = result.video && typeof result.video === 'object' ? result.video as Record<string, unknown> : null;
  const videoUrl = validFalVideoUrl(video?.url); if (!videoUrl || result.error || result.has_nsfw_concepts === true) throw new Error('provider_no_video');
  const response = await fetch(videoUrl, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body || Number(response.headers.get('Content-Length')) > VIDEO_MAX_BYTES) throw new Error('video_unavailable');
  const key = finisherVideoKey(battle, job);
  try {
    const stored = await storeBattleVideo(env.SPRITES, key, response.body, 'video/mp4', VIDEO_MAX_BYTES);
    const updated = await env.DB.prepare(`UPDATE battle_finisher_jobs SET status = 'ready', credit_state = 'spent', video_sha256 = ?, video_bytes = ?, updated_at = ?
      WHERE id = ? AND status = 'generating' AND credit_state = 'reserved'
      AND EXISTS (SELECT 1 FROM battle_media battle JOIN users ON users.id = battle.owner_user_id WHERE battle.id = battle_id AND battle.status = 'ready' AND battle.owner_user_id = ?)
      RETURNING id`).bind(stored.sha256, stored.size, new Date().toISOString(), id, job.owner_user_id).first<{ id: string }>();
    if (!updated) {
      const current = await loadFinisherJob(env, id);
      if (current?.status === 'ready') return 'ready';
      await env.SPRITES.delete(key); return 'stopped';
    }
    return 'ready';
  } catch (error) { await env.SPRITES.delete(key).catch(() => undefined); throw error; }
}
