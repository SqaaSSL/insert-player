const ARCHIVE_PREFIX = 'arcade-experiments/v1/';
const ARCHIVE_PATH = '/archive-object';
const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  'application/json',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function authorized(request, env) {
  const provided = request.headers.get('Authorization') ?? '';
  const expected = `Bearer ${env.ARCHIVE_UPLOAD_TOKEN ?? ''}`;
  if (!env.ARCHIVE_UPLOAD_TOKEN || provided.length !== expected.length) return false;
  const [providedDigest, expectedDigest] = await Promise.all([digest(provided), digest(expected)]);
  let difference = 0;
  for (let index = 0; index < providedDigest.length; index += 1) {
    difference |= providedDigest[index] ^ expectedDigest[index];
  }
  return difference === 0;
}

function archiveKey(request) {
  const key = request.headers.get('X-Archive-Object-Key') ?? '';
  if (
    !key.startsWith(ARCHIVE_PREFIX)
    || key.length > 512
    || key.includes('..')
    || !/^[A-Za-z0-9/_.:-]+$/.test(key)
  ) return null;
  return key;
}

function expectedContentHash(request) {
  const contentHash = request.headers.get('X-Archive-Content-Sha256') ?? '';
  return /^[a-f0-9]{64}$/i.test(contentHash) ? contentHash.toLowerCase() : null;
}

async function sha256(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function verifiedExistingObject(bucket, key, expectedHash, expectedSize) {
  const existing = await bucket.get(key);
  if (!existing || existing.size !== expectedSize) return null;
  const bytes = await existing.arrayBuffer();
  return await sha256(bytes) === expectedHash ? bytes : null;
}

async function putArchiveObject(request, env, key, expectedHash) {
  const expectedSize = Number(request.headers.get('X-Archive-Size') ?? '');
  const contentLength = Number(request.headers.get('Content-Length') ?? '');
  const contentType = (request.headers.get('Content-Type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (
    !Number.isSafeInteger(expectedSize)
    || expectedSize <= 0
    || expectedSize > MAX_OBJECT_BYTES
    || contentLength !== expectedSize
    || !ALLOWED_CONTENT_TYPES.has(contentType)
  ) return jsonResponse({ error: 'invalid_archive_object' }, 400);

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength !== expectedSize || await sha256(bytes) !== expectedHash) {
    return jsonResponse({ error: 'archive_object_hash_mismatch' }, 422);
  }

  const existing = await env.ARCHIVE_BUCKET.head(key);
  if (existing) {
    const verified = await verifiedExistingObject(env.ARCHIVE_BUCKET, key, expectedHash, expectedSize);
    return verified
      ? jsonResponse({ action: 'reused', key, sha256: expectedHash, sizeBytes: expectedSize }, 200)
      : jsonResponse({ error: 'immutable_archive_conflict' }, 409);
  }

  const stored = await env.ARCHIVE_BUCKET.put(key, bytes, {
    customMetadata: { archiveSha256: expectedHash },
    httpMetadata: { contentType },
    onlyIf: { etagDoesNotMatch: '*' },
  });
  if (!stored) {
    const verified = await verifiedExistingObject(env.ARCHIVE_BUCKET, key, expectedHash, expectedSize);
    return verified
      ? jsonResponse({ action: 'reused', key, sha256: expectedHash, sizeBytes: expectedSize }, 200)
      : jsonResponse({ error: 'immutable_archive_conflict' }, 409);
  }
  const persisted = await env.ARCHIVE_BUCKET.head(key);
  if (
    !persisted
    || persisted.size !== expectedSize
    || persisted.customMetadata?.archiveSha256 !== expectedHash
  ) return jsonResponse({ error: 'archive_write_verification_failed' }, 500);
  return jsonResponse({ action: 'stored', key, sha256: expectedHash, sizeBytes: expectedSize }, 201);
}

async function getArchiveObject(env, key, expectedHash) {
  const object = await env.ARCHIVE_BUCKET.get(key);
  if (!object) return jsonResponse({ error: 'archive_object_not_found' }, 404);
  const bytes = await object.arrayBuffer();
  if (await sha256(bytes) !== expectedHash) {
    return jsonResponse({ error: 'archive_read_verification_failed' }, 409);
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Length', String(bytes.byteLength));
  headers.set('X-Archive-Content-Sha256', expectedHash);
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(bytes, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonResponse({ status: 'ok', scope: ARCHIVE_PREFIX }, 200);
    }
    if (url.pathname !== ARCHIVE_PATH) return jsonResponse({ error: 'not_found' }, 404);
    if (!await authorized(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);
    const key = archiveKey(request);
    const expectedHash = expectedContentHash(request);
    if (!key || !expectedHash) return jsonResponse({ error: 'invalid_archive_headers' }, 400);
    if (request.method === 'PUT') return putArchiveObject(request, env, key, expectedHash);
    if (request.method === 'GET') return getArchiveObject(env, key, expectedHash);
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  },
};
