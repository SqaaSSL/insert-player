import type { Env, PublicAuthContext, User } from './types';

const TOKEN_VERSION = 1;
const TOKEN_TTL_SECONDS = 2 * 60 * 60;

interface GenerationTokenPayload {
  v: number;
  jobId: string;
  userId: string;
  providerSessionId: string;
  exp: number;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function signingSecret(env: Env): string {
  const secret = env.GENERATION_JOB_SIGNING_SECRET?.trim();
  if (secret) return secret;
  if (env.ENVIRONMENT === 'development') return 'insert-player-local-generation-jobs-only';
  throw new Error('GENERATION_JOB_SIGNING_SECRET is required');
}

async function hmacKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function mintGenerationJobToken(
  env: Env,
  params: Pick<GenerationTokenPayload, 'jobId' | 'userId' | 'providerSessionId'>,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<string> {
  const payload: GenerationTokenPayload = {
    v: TOKEN_VERSION,
    ...params,
    exp: nowSeconds + TOKEN_TTL_SECONDS,
  };
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(encoded)));
  return `${encoded}.${base64UrlEncode(signature)}`;
}

async function verifyTokenSignature(env: Env, encoded: string, signature: string): Promise<boolean> {
  const signatureBytes = base64UrlDecode(signature);
  if (!signatureBytes) return false;
  return crypto.subtle.verify(
    'HMAC',
    await hmacKey(env),
    signatureBytes,
    new TextEncoder().encode(encoded),
  );
}

function parsePayload(encoded: string): GenerationTokenPayload | null {
  const bytes = base64UrlDecode(encoded);
  if (!bytes) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as Partial<GenerationTokenPayload>;
    if (
      payload.v !== TOKEN_VERSION ||
      typeof payload.jobId !== 'string' || !/^[a-f0-9]{32}$/.test(payload.jobId) ||
      typeof payload.userId !== 'string' || !payload.userId ||
      typeof payload.providerSessionId !== 'string' || !/^[a-f0-9]{32}$/.test(payload.providerSessionId) ||
      typeof payload.exp !== 'number' || !Number.isInteger(payload.exp)
    ) {
      return null;
    }
    return payload as GenerationTokenPayload;
  } catch {
    return null;
  }
}

function generationToken(request: Request): string | null {
  const match = request.headers.get('Authorization')?.match(/^Generation\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

export function generationJobIdFromAuth(auth: PublicAuthContext): string | null {
  const value = auth.claims?.generation_job_id;
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : null;
}

export async function optionalGenerationJobAuth(
  request: Request,
  env: Env,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<PublicAuthContext | Response | null> {
  const token = generationToken(request);
  if (!token) return null;
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra || !await verifyTokenSignature(env, encoded, signature)) {
    return Response.json({ error: 'Invalid generation job authorization' }, { status: 401 });
  }
  const payload = parsePayload(encoded);
  if (!payload || payload.exp <= nowSeconds) {
    return Response.json({ error: 'Generation job authorization expired' }, { status: 401 });
  }

  const job = await env.DB.prepare(`
    SELECT id, user_id, provider_session_id, status
    FROM generation_jobs
    WHERE id = ? AND user_id = ? AND provider_session_id = ?
  `).bind(payload.jobId, payload.userId, payload.providerSessionId).first<{
    id: string;
    user_id: string;
    provider_session_id: string;
    status: string;
  }>();
  if (!job || !['queued', 'running'].includes(job.status)) {
    return Response.json({ error: 'Generation job is not active' }, { status: 401 });
  }
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(payload.userId)
    .first<User>();
  if (!user) return Response.json({ error: 'Generation job user not found' }, { status: 401 });

  return {
    userId: user.id,
    rateLimitKey: `user:${user.id}`,
    user,
    claims: {
      generation_job_id: job.id,
      generation_provider_session_id: job.provider_session_id,
    },
  };
}
