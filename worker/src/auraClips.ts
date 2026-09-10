import { publicFrontendOrigin } from './branding';
import { decodeAuraChallengePreview } from './auraChallengePreview';
import { AURA_CHALLENGE_OG_VERSION } from './auraChallengeOgTemplate';
import { readJsonBody } from './requestBody';
import { enforceRateLimit } from './rateLimit';
import { enforceTurnstileAction } from './turnstile';
import type { Env, PublicAuthContext } from './types';

export const MAX_AURA_CLIP_BYTES = 64 * 1024 * 1024;
const UPLOAD_TTL_MS = 15 * 60 * 1000;
const CLIP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const PRIVATE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
};

interface AuraClipRecord {
  id: string;
  owner_user_id: string | null;
  challenge_token: string;
  content_type: 'video/mp4' | 'video/webm';
  byte_length: number;
  has_poster: number;
  upload_token_hash: string;
  delete_token_hash: string;
  status: 'pending' | 'uploading' | 'ready' | 'revoked' | 'failed';
  created_at: string;
  expires_at: string;
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { ...PRIVATE_HEADERS, ...headers } });
}

function unavailable(): Response {
  return json({ error: 'This battle is unavailable or has expired.', code: 'clip_unavailable' }, 404);
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function blobKey(id: string): string {
  return `public-aura-clips/${id}/video`;
}

function posterKey(id: string): string {
  return `public-aura-clips/${id}/poster.jpg`;
}

function decodePoster(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value.length > Math.ceil(256 * 1024 / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  try {
    const decoded = atob(value);
    if (decoded.length < 5 || decoded.length > 256 * 1024 || btoa(decoded) !== value) return null;
    const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9 ? bytes : null;
  } catch { return null; }
}

function publicMetadata(request: Request, env: Env, record: AuraClipRecord) {
  const apiOrigin = new URL(request.url).origin;
  const videoUrl = `${apiOrigin}/api/aura/clips/${record.id}/video`;
  return {
    id: record.id,
    challengeToken: record.challenge_token,
    contentType: record.content_type,
    byteLength: record.byte_length,
    videoUrl,
    ...(record.has_poster ? { posterUrl: `${apiOrigin}/api/aura/clips/${record.id}/poster` } : {}),
    downloadUrl: `${videoUrl}?download=1`,
    shareUrl: new URL(`/watch/${record.id}`, publicFrontendOrigin(env)).toString(),
    ogImageUrl: `${apiOrigin}/challenges/aura/${record.challenge_token}/og.png?v=${AURA_CHALLENGE_OG_VERSION}`,
    createdAt: record.created_at,
    expiresAt: record.expires_at,
  };
}

/** Only the chosen public challenge label and recording are published. */
export async function createAuraClip(request: Request, env: Env, auth: PublicAuthContext): Promise<Response> {
  const body = await readJsonBody<{
    challengeToken?: unknown; byteLength?: unknown; contentType?: unknown; turnstileToken?: unknown; posterBase64?: unknown;
  }>(request, 384 * 1024);
  if (typeof body.challengeToken !== 'string' || !decodeAuraChallengePreview(body.challengeToken)) {
    return json({ error: 'Choose a valid Aura challenge before sharing.', code: 'invalid_challenge' }, 400);
  }
  if (body.contentType !== 'video/mp4' && body.contentType !== 'video/webm') {
    return json({ error: 'Use an MP4 or WebM match recording.', code: 'invalid_video_type' }, 415);
  }
  if (typeof body.byteLength !== 'number' || !Number.isSafeInteger(body.byteLength) || body.byteLength < 16) {
    return json({ error: 'This recording is empty or incomplete.', code: 'invalid_video_size' }, 400);
  }
  if (body.byteLength > MAX_AURA_CLIP_BYTES) {
    return json({ error: 'This recording exceeds the 64 MB sharing limit. You can still download it.', code: 'video_too_large' }, 413);
  }
  const poster = body.posterBase64 === undefined ? null : decodePoster(body.posterBase64);
  if (body.posterBase64 !== undefined && !poster) {
    return json({ error: 'The recording preview is invalid. Please try sharing again.', code: 'invalid_poster' }, 400);
  }
  if (!auth.userId) {
    const verification = await enforceTurnstileAction(request, env, body.turnstileToken, 'aura_share');
    if (verification) return verification;
  }
  const limited = await enforceRateLimit(env, 'aura:clip', auth);
  if (limited) return limited;
  const id = randomToken();
  const uploadToken = randomToken();
  const deleteToken = randomToken();
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + UPLOAD_TTL_MS).toISOString();
  const inserted = await env.DB.prepare(`
    INSERT INTO aura_clips (
      id, owner_user_id, challenge_token, content_type, byte_length,
      upload_token_hash, delete_token_hash, status, created_at, expires_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
    WHERE ? IS NULL OR EXISTS (SELECT 1 FROM users WHERE id = ?)
    RETURNING id
  `).bind(id, auth.userId, body.challengeToken, body.contentType, body.byteLength,
    await hashToken(uploadToken), await hashToken(deleteToken), createdAt, expiresAt, auth.userId, auth.userId).first<{ id: string }>();
  if (!inserted) return json({ error: 'Sign in again before sharing this battle.', code: 'account_unavailable' }, 401);
  if (poster) {
    try {
      await env.SPRITES.put(posterKey(id), poster, { httpMetadata: { contentType: 'image/jpeg', cacheControl: 'no-store' } });
      const live = await env.DB.prepare(`UPDATE aura_clips SET has_poster = 1
        WHERE id = ? AND status = 'pending' AND expires_at > ? RETURNING id`)
        .bind(id, new Date().toISOString()).first<{ id: string }>();
      if (!live) {
        await env.SPRITES.delete(posterKey(id));
        return unavailable();
      }
    } catch { /* The recording can still be shared if its optional preview fails. */ }
  }
  return json({ id, uploadUrl: `${new URL(request.url).origin}/api/aura/clips/${id}/video`, uploadToken, deleteToken, expiresAt }, 201);
}

async function readReadyClip(env: Env, id: string): Promise<AuraClipRecord | null> {
  if (!ID_PATTERN.test(id)) return null;
  return env.DB.prepare(`SELECT * FROM aura_clips
    WHERE id = ? AND status = 'ready' AND expires_at > ? LIMIT 1`)
    .bind(id, new Date().toISOString()).first<AuraClipRecord>();
}

export async function getAuraClip(request: Request, env: Env, id: string): Promise<Response> {
  const record = await readReadyClip(env, id);
  if (record) return json(publicMetadata(request, env, record));
  // Only the publishing browser can distinguish an unfinished upload.
  const capability = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32})$/)?.[1];
  if (ID_PATTERN.test(id) && capability) {
    const pending = await env.DB.prepare(`SELECT status FROM aura_clips WHERE id = ?
      AND upload_token_hash = ? AND status IN ('pending', 'uploading') AND expires_at > ? LIMIT 1`)
      .bind(id, await hashToken(capability), new Date().toISOString()).first<{ status: string }>();
    if (pending) return json({ error: 'The recording is still being uploaded.', code: `clip_${pending.status}` }, 409);
  }
  return unavailable();
}

function hasVideoHeader(header: Uint8Array, type: AuraClipRecord['content_type']): boolean {
  if (type === 'video/webm') {
    return header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3;
  }
  // Native MP4 recordings start with an ISO BMFF file-type box.
  return header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70;
}

class InvalidVideoUpload extends Error {}

/** R2 requires a known-length stream. Enforce that exact length while copying
 * only one network chunk at a time; never buffer the whole recording in memory. */
async function storeVideo(request: Request, env: Env, record: AuraClipRecord): Promise<void> {
  if (!request.body) throw new InvalidVideoUpload('The recording is empty.');
  const reader = request.body.getReader();
  const firstChunks: Uint8Array[] = [];
  const header = new Uint8Array(16);
  let headerBytes = 0;
  let total = 0;
  try {
    while (headerBytes < header.length) {
      const { done, value } = await reader.read();
      if (done) throw new InvalidVideoUpload('The recording is incomplete.');
      total += value.byteLength;
      if (total > record.byte_length) throw new InvalidVideoUpload('The recording size changed.');
      firstChunks.push(value);
      const count = Math.min(header.length - headerBytes, value.byteLength);
      header.set(value.subarray(0, count), headerBytes);
      headerBytes += count;
    }
    if (!hasVideoHeader(header, record.content_type)) throw new InvalidVideoUpload('The file is not a supported match recording.');
    const stream = new FixedLengthStream(record.byte_length);
    const writer = stream.writable.getWriter();
    const copy = (async () => {
      try {
        for (const chunk of firstChunks) await writer.write(chunk);
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > record.byte_length) throw new InvalidVideoUpload('The recording size changed.');
          await writer.write(value);
        }
        if (total !== record.byte_length) throw new InvalidVideoUpload('The recording is incomplete.');
        await writer.close();
      } catch (error) {
        await writer.abort(error).catch(() => {});
        throw error;
      } finally {
        writer.releaseLock();
      }
    })();
    const store = env.SPRITES.put(blobKey(record.id), stream.readable, {
      httpMetadata: { contentType: record.content_type, cacheControl: 'no-store' },
    });
    // Both sides must settle, including stream cancellation on an R2 error.
    const outcomes = await Promise.allSettled([
      copy,
      store.catch(async error => {
        await stream.readable.cancel(error).catch(() => {});
        await reader.cancel().catch(() => {});
        throw error;
      }),
    ]);
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function uploadAuraClip(request: Request, env: Env, id: string): Promise<Response> {
  const capability = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32})$/)?.[1];
  if (!ID_PATTERN.test(id) || !capability) return unavailable();
  const record = await env.DB.prepare(`SELECT * FROM aura_clips
    WHERE id = ? AND upload_token_hash = ? AND status IN ('pending', 'uploading', 'ready') AND expires_at > ? LIMIT 1`)
    .bind(id, await hashToken(capability), new Date().toISOString()).first<AuraClipRecord>();
  if (!record) return unavailable();
  if (record.status === 'ready') return json({ clip: publicMetadata(request, env, record) });
  if (record.status === 'uploading') return json({ error: 'The recording is still being uploaded.', code: 'clip_uploading' }, 409);
  const lengthHeader = request.headers.get('Content-Length');
  if (lengthHeader !== null && (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) !== record.byte_length)) {
    return json({ error: 'The recording size changed.', code: 'invalid_video_size' }, 400);
  }
  if ((request.headers.get('Content-Type') ?? '').split(';')[0].trim() !== record.content_type) {
    return json({ error: 'The recording type changed.', code: 'invalid_video_type' }, 415);
  }
  const reserved = await env.DB.prepare(`UPDATE aura_clips SET status = 'uploading'
    WHERE id = ? AND status = 'pending' AND expires_at > ? RETURNING id`)
    .bind(id, new Date().toISOString()).first<{ id: string }>();
  if (!reserved) return unavailable();
  try {
    await storeVideo(request, env, record);
    const ready = await env.DB.prepare(`UPDATE aura_clips SET status = 'ready', expires_at = ?
      WHERE id = ? AND status = 'uploading' AND expires_at > ? RETURNING *`)
      .bind(new Date(Date.now() + CLIP_TTL_MS).toISOString(), id, new Date().toISOString()).first<AuraClipRecord>();
    if (!ready) {
      await env.SPRITES.delete([blobKey(id), posterKey(id)]);
      return unavailable();
    }
    return json({ clip: publicMetadata(request, env, ready) }, 201);
  } catch (error) {
    // Leave a durable cleanup row if deleting a failed/partial object fails.
    await env.DB.prepare(`UPDATE aura_clips SET status = 'failed', expires_at = ? WHERE id = ? AND status = 'uploading'`)
      .bind(new Date().toISOString(), id).run();
    await env.SPRITES.delete([blobKey(id), posterKey(id)]).catch(() => {});
    return error instanceof InvalidVideoUpload
      ? json({ error: error.message, code: 'invalid_video' }, 400)
      : json({ error: 'The recording could not be uploaded. Please try again.', code: 'upload_failed' }, 503);
  }
}

export async function deleteAuraClip(request: Request, env: Env, id: string): Promise<Response> {
  if (!ID_PATTERN.test(id)) return unavailable();
  const body = await readJsonBody<{ deleteToken?: unknown }>(request, 1024);
  if (typeof body.deleteToken !== 'string' || !ID_PATTERN.test(body.deleteToken)) return unavailable();
  const record = await env.DB.prepare(`UPDATE aura_clips SET status = 'revoked', expires_at = ?
    WHERE id = ? AND delete_token_hash = ? RETURNING id`)
    .bind(new Date().toISOString(), id, await hashToken(body.deleteToken)).first<{ id: string }>();
  if (!record) return unavailable();
  // Public access is already revoked. A failed R2 delete is retried by maintenance.
  await env.SPRITES.delete([blobKey(id), posterKey(id)]).catch(() => {});
  return new Response(null, { status: 204, headers: PRIVATE_HEADERS });
}

function videoRange(value: string | null, size: number): { offset: number; length: number } | null | 'invalid' {
  if (value === null) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return 'invalid';
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    const length = Math.min(size, suffix);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset >= size || end < offset) return 'invalid';
  return { offset, length: Math.min(end, size - 1) - offset + 1 };
}

export async function getAuraClipVideo(request: Request, env: Env, id: string): Promise<Response> {
  const record = await readReadyClip(env, id);
  if (!record) return unavailable();
  const range = videoRange(request.headers.get('Range'), record.byte_length);
  if (range === 'invalid') return new Response(null, {
    status: 416, headers: { ...PRIVATE_HEADERS, 'Content-Range': `bytes */${record.byte_length}`, 'Accept-Ranges': 'bytes' },
  });
  const headers = new Headers({ ...PRIVATE_HEADERS,
    'Content-Type': record.content_type,
    'Content-Length': String(range?.length ?? record.byte_length),
    'Accept-Ranges': 'bytes',
  });
  if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${record.byte_length}`);
  if (new URL(request.url).searchParams.get('download') === '1') {
    headers.set('Content-Disposition', `attachment; filename="Insert-Player-Aura-${id}.${record.content_type === 'video/mp4' ? 'mp4' : 'webm'}"`);
  }
  if (request.method === 'HEAD') {
    const object = await env.SPRITES.head(blobKey(id));
    return object ? new Response(null, { status: range ? 206 : 200, headers }) : unavailable();
  }
  const object = await env.SPRITES.get(blobKey(id), range ? { range } : undefined);
  return object ? new Response(object.body, { status: range ? 206 : 200, headers }) : unavailable();
}

export async function getAuraClipPoster(request: Request, env: Env, id: string): Promise<Response> {
  const record = await readReadyClip(env, id);
  if (!record?.has_poster) return unavailable();
  const object = request.method === 'HEAD'
    ? await env.SPRITES.head(posterKey(id))
    : await env.SPRITES.get(posterKey(id));
  if (!object) return unavailable();
  return new Response('body' in object ? (object as R2ObjectBody).body : null, { headers: {
    ...PRIVATE_HEADERS, 'Content-Type': 'image/jpeg', 'Content-Length': String(object.size),
  } });
}

export async function cleanupExpiredAuraClips(env: Env): Promise<void> {
  const now = new Date().toISOString();
  // The shared maintenance cron runs daily. Batch both stores so a busy launch
  // does not leave an ever-growing backlog, while bounding each scheduled run.
  for (let batch = 0; batch < 100; batch++) {
    const expired = await env.DB.prepare(`SELECT id FROM aura_clips
      WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT 50`).bind(now).all<{ id: string }>();
    const rows = expired.results ?? [];
    if (!rows.length) return;
    try {
      await env.SPRITES.delete(rows.flatMap(record => [blobKey(record.id), posterKey(record.id)]));
      await env.DB.prepare(`DELETE FROM aura_clips WHERE id IN (${rows.map(() => '?').join(',')}) AND expires_at <= ?`)
        .bind(...rows.map(record => record.id), now).run();
    } catch { return; /* Retain the cleanup rows and retry on the next run. */ }
  }
}
