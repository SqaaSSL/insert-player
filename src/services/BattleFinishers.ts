import { apiFetch, apiUrl, captureApiRequestContext, type ApiRequestContext } from './ApiClient.ts';
import { BATTLE_RECORDING_MAX_BYTES, BATTLE_STILL_MAX_BYTES, type BattleSummary, type SavedBattle } from '../shared/BattleFinisher.ts';
import type { GenerationLegalAttestation } from '../ui/legal.ts';
import type { BattleCaptureDetail } from '../game/match/BattleCapture.ts';

export type { BattleSummary, SavedBattle } from '../shared/BattleFinisher.ts';
export type { BattleCaptureDetail } from '../game/match/BattleCapture.ts';
export type BattleMediaKind = 'still' | 'recording' | 'finisher';
const ID = /^[A-Za-z0-9_-]{20,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class BattleFinisherError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = 'BattleFinisherError'; }
}
export function isBattleId(value: string): boolean { return ID.test(value); }
function battlePath(id: string): string {
  if (!isBattleId(id)) throw new BattleFinisherError('This battle link is incomplete.', 404);
  return `/api/battles/${id}`;
}
async function checked(response: Response): Promise<Record<string, unknown>> {
  let data: Record<string, unknown> = {};
  try { data = await response.json() as Record<string, unknown>; } catch { /* Public fallback below. */ }
  if (!response.ok) {
    const fallback = response.status === 401 ? 'Sign in to save your battle and create its finisher.'
      : response.status === 402 ? 'You need 1 credit to generate this finisher. Your battle is saved.'
        : response.status === 428 ? 'Confirm the generation terms before spending a credit.'
          : response.status === 404 ? 'This battle is private, removed or unavailable.'
            : response.status === 503 ? 'Finishers are temporarily unavailable. Your battle is still saved.'
              : 'This action could not finish. Try again to recover the same battle.';
    throw new BattleFinisherError(typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : fallback, response.status, typeof data.code === 'string' ? data.code : undefined);
  }
  return data;
}
function battleFrom(data: Record<string, unknown>): SavedBattle {
  const battle = data.battle as SavedBattle | undefined;
  if (!battle || !isBattleId(battle.id) || !battle.summary || !['fight', 'aura', 'rush'].includes(battle.summary.game)
    || typeof battle.published !== 'boolean' || typeof battle.isOwner !== 'boolean') throw new Error('The battle response could not be confirmed. Retry to recover it.');
  return battle;
}
export async function getSavedBattle(id: string, signal?: AbortSignal, context?: ApiRequestContext): Promise<SavedBattle> {
  // Let the app's auth bridge finish its mount effect before capturing a token
  // context. Child page effects can otherwise run ahead of the bridge once.
  await Promise.resolve();
  return battleFrom(await checked(await apiFetch(battlePath(id), { signal }, context)));
}
export async function listSavedBattles(signal?: AbortSignal): Promise<SavedBattle[]> {
  await Promise.resolve();
  const data = await checked(await apiFetch('/api/battles', { signal }));
  if (!Array.isArray(data.battles)) throw new Error('Your battles could not load.');
  return data.battles.map(battle => battleFrom({ battle }));
}
export function validateBattleCapture(capture: BattleCaptureDetail): void {
  if (!UUID.test(capture.clientBattleId)) throw new Error('This battle could not be identified. Finish another match and try again.');
  const image = capture.stillBase64.replace(/^data:image\/jpeg;base64,/, '');
  if (!image || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)
    || image.length > Math.ceil(BATTLE_STILL_MAX_BYTES / 3) * 4) throw new Error('The final battle image is missing or too large.');
  if (capture.recording) validateBattleRecording(capture.recording);
}
export function validateBattleRecording(recording: Blob): void {
  if (!['video/mp4', 'video/webm'].includes(recording.type) || !recording.size || recording.size > BATTLE_RECORDING_MAX_BYTES) {
    throw new Error('The battle recording must be an MP4 or WebM video under 64 MB.');
  }
}
export async function saveBattleCapture(capture: BattleCaptureDetail, context = captureApiRequestContext()): Promise<SavedBattle> {
  validateBattleCapture(capture);
  let battle = battleFrom(await checked(await apiFetch('/api/battles', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientBattleId: capture.clientBattleId, summary: capture.summary, stillBase64: capture.stillBase64.replace(/^data:image\/jpeg;base64,/, '') }),
  }, context)));
  if (capture.recording && !battle.recordingUrl) {
    battle = battleFrom(await checked(await apiFetch(`${battlePath(battle.id)}/recording`, {
      method: 'PUT', headers: { 'Content-Type': capture.recording.type }, body: capture.recording,
    }, context)));
  }
  return battle;
}
export async function generateBattleFinisher(id: string, requestId: string, legal: GenerationLegalAttestation, context?: ApiRequestContext): Promise<SavedBattle> {
  if (!UUID.test(requestId)) throw new Error('The generation request could not be identified.');
  return battleFrom(await checked(await apiFetch(`${battlePath(id)}/finisher`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, legal }),
  }, context)));
}
/** This is the sole publication action. Saving and generating remain private. */
export async function publishSavedBattle(id: string, context?: ApiRequestContext): Promise<SavedBattle> {
  return battleFrom(await checked(await apiFetch(`${battlePath(id)}/publish`, { method: 'POST' }, context)));
}
export async function deleteSavedBattle(id: string): Promise<void> {
  const response = await apiFetch(battlePath(id), { method: 'DELETE' });
  if (!response.ok && response.status !== 404) await checked(response);
}
/** Never forward account credentials to a media URL supplied by a provider. */
export function battleMediaUrl(battle: SavedBattle, kind: BattleMediaKind): string {
  const supplied = kind === 'still' ? battle.stillUrl : kind === 'recording' ? battle.recordingUrl : battle.finisher?.videoUrl;
  if (!supplied) throw new Error('This battle media is not ready yet.');
  const base = typeof window === 'undefined' ? 'https://insertplayer.ai' : window.location.href;
  const expected = new URL(apiUrl(`${battlePath(battle.id)}/${kind}`), base);
  if (new URL(apiUrl(supplied), base).href !== expected.href) throw new Error('This battle media address could not be verified.');
  return expected.href;
}
export async function loadBattleMedia(battle: SavedBattle, kind: BattleMediaKind, signal?: AbortSignal): Promise<Blob> {
  const response = await apiFetch(battleMediaUrl(battle, kind), { signal });
  if (!response.ok) { await checked(response); throw new Error('Battle media is unavailable.'); }
  const blob = await response.blob();
  const allowed = kind === 'still' ? ['image/jpeg', 'image/png'] : ['video/mp4', 'video/webm'];
  if (!allowed.includes(blob.type.split(';')[0]) || !blob.size) throw new Error('This browser could not load the battle media.');
  return blob;
}
export function battleHeadline(summary: BattleSummary): string {
  if (summary.winner === 'team') return `${summary.p1Name} cleared the streets.`;
  if (summary.winner === 'rivals') return 'The streets won this round.';
  if (summary.winner === 'draw') return `${summary.p1Name} and ${summary.p2Name} drew.`;
  return `${summary.winner === 'p1' ? summary.p1Name : summary.p2Name} wins.`;
}
export function savedBattleShareData(battle: SavedBattle, finisherOnly = false) {
  const path = `/battles/${battle.id}${finisherOnly ? '/finisher' : ''}`;
  const supplied = finisherOnly ? battle.finisherShareUrl : battle.shareUrl;
  const url = new URL(supplied);
  const origins = new Set(['https://insertplayer.ai', 'https://www.insertplayer.ai']);
  if (typeof window !== 'undefined') origins.add(new URL(window.location.href).origin);
  if (!battle.published || !origins.has(url.origin) || url.pathname !== path || url.search || url.hash || url.username || url.password || !['https:', 'http:'].includes(url.protocol)) {
    throw new Error('Publish this battle before sharing its link.');
  }
  return { title: `${battle.summary.game.toUpperCase()} ${finisherOnly ? 'finisher' : 'battle'} · Insert Player`,
    text: `${battleHeadline(battle.summary)} Watch ${finisherOnly ? 'the finisher' : 'the battle'} on Insert Player.`, url: url.href };
}
