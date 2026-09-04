import { publicAppName, publicFrontendOrigin } from './branding';
import { ROOM_IDLE_TTL_MS } from './matchRoomProtocol';
import type { Env, QualityTier } from './types';
import { renderVersusInviteOg } from './versusInviteOg';
import {
  VERSUS_INVITE_OG_HEIGHT,
  VERSUS_INVITE_OG_WIDTH,
  VERSUS_INVITE_TEMPLATE_VERSION,
} from './versusInviteOgTemplate';

const VERSUS_INVITE_TOKEN_BYTES = 24;
const VERSUS_INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const OG_CACHE_PREFIX = 'public/versus-invitations';
const OG_CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=300, s-maxage=1800, stale-while-revalidate=1800',
  'Content-Type': 'image/png',
  'X-Content-Type-Options': 'nosniff',
};
const SHARE_PAGE_CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=300',
};

export interface VersusInvitationRecord {
  token_hash: string;
  room_code: string;
  host_user_id: string;
  host_display_name: string;
  fighter_id: string;
  fighter_name: string;
  fighter_quality_tier: QualityTier;
  fighter_source_kind: 'side' | 'upright' | 'crouch' | 'idle';
  fighter_source_blob_key: string;
  template_version: string;
  created_at: string;
  expires_at: string;
}

export interface NewVersusInvitationSnapshot {
  roomCode: string;
  hostUserId: string;
  hostDisplayName: string;
  fighterId: string;
  fighterName: string;
  fighterQualityTier: QualityTier;
  fighterSourceKind: VersusInvitationRecord['fighter_source_kind'];
  fighterSourceBlobKey: string;
}

function randomToken(): string {
  const bytes = new Uint8Array(VERSUS_INVITE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(digest));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}

function html(markup: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(markup, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      ...headers,
    },
  });
}

export function normalizeVersusInviteToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return VERSUS_INVITE_TOKEN_PATTERN.test(token) ? token : null;
}

export function versusInvitationOgBlobKey(
  tokenHashValue: string,
  templateVersion = VERSUS_INVITE_TEMPLATE_VERSION,
): string {
  return `${OG_CACHE_PREFIX}/${tokenHashValue}/${templateVersion}.png`;
}

export function versusInviterSlug(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'player';
}

export function versusInvitationShareUrl(request: Request, token: string, inviterName: string): string {
  const url = new URL(request.url);
  url.pathname = `/v/${versusInviterSlug(inviterName)}/${encodeURIComponent(token)}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function createVersusInvitationRecord(
  env: Env,
  snapshot: NewVersusInvitationSnapshot,
  now = Date.now(),
): Promise<{ token: string; record: VersusInvitationRecord }> {
  const expiresAt = new Date(now + ROOM_IDLE_TTL_MS).toISOString();
  let lastCollision: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = randomToken();
    const hash = await tokenHash(token);
    try {
      const storedRecord = await env.DB.prepare(`
        INSERT INTO versus_invitations (
          token_hash, room_code, host_user_id, fighter_id, fighter_name,
          fighter_quality_tier, fighter_source_kind, fighter_source_blob_key,
          template_version, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
      `).bind(
        hash,
        snapshot.roomCode,
        snapshot.hostUserId,
        snapshot.fighterId,
        snapshot.fighterName,
        snapshot.fighterQualityTier,
        snapshot.fighterSourceKind,
        snapshot.fighterSourceBlobKey,
        VERSUS_INVITE_TEMPLATE_VERSION,
        expiresAt,
      ).first<Omit<VersusInvitationRecord, 'host_display_name'>>();
      if (!storedRecord) throw new Error('Invitation was not persisted');
      return {
        token,
        record: { ...storedRecord, host_display_name: snapshot.hostDisplayName },
      };
    } catch (error) {
      if (!String(error).toLowerCase().includes('unique')) throw error;
      lastCollision = error;
    }
  }
  throw lastCollision instanceof Error ? lastCollision : new Error('Could not allocate invitation token');
}

export async function readActiveVersusInvitation(
  env: Env,
  rawToken: unknown,
): Promise<{ token: string; record: VersusInvitationRecord } | null> {
  const token = normalizeVersusInviteToken(rawToken);
  if (!token) return null;
  const hash = await tokenHash(token);
  const record = await env.DB.prepare(`
    SELECT invitation.*,
      COALESCE(NULLIF(TRIM(host.display_name), ''), 'Player') AS host_display_name
    FROM versus_invitations invitation
    LEFT JOIN users host ON host.id = invitation.host_user_id
    WHERE invitation.token_hash = ? AND datetime(invitation.expires_at) > datetime('now')
    LIMIT 1
  `).bind(hash).first<VersusInvitationRecord>();
  return record ? { token, record } : null;
}

function missingInvitationPage(): Response {
  return html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width" />
<meta name="robots" content="noindex,nofollow,noarchive" /><title>Invitation unavailable</title></head>
<body><main><h1>Invitation unavailable</h1><p>This versus invitation is invalid or has expired.</p></main></body></html>`, 410, {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  });
}

export async function versusInvitationSharePage(
  request: Request,
  env: Env,
  rawToken: string,
): Promise<Response> {
  const invite = await readActiveVersusInvitation(env, rawToken);
  if (!invite) return missingInvitationPage();

  const { token, record } = invite;
  const shareUrl = versusInvitationShareUrl(request, token, record.host_display_name);
  const ogUrl = new URL(`${shareUrl}/og.png`);
  ogUrl.searchParams.set('v', VERSUS_INVITE_TEMPLATE_VERSION);
  const versionedOgUrl = ogUrl.toString();
  const redirect = new URL('/versus/online', publicFrontendOrigin(env));
  redirect.searchParams.set('invite', token);
  redirect.searchParams.set('from', record.host_display_name);
  redirect.searchParams.set('fighter', record.fighter_name);
  const redirectUrl = redirect.toString();
  const appName = publicAppName(env);
  const title = `${record.host_display_name} challenges you · ${appName}`;
  const description = `${record.host_display_name} is bringing ${record.fighter_name}. Accept the private Online Versus challenge and choose your fighter.`;
  const imageAlt = `${record.host_display_name} invites you to fight ${record.fighter_name} in an Online Versus match`;

  return html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow,noarchive" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${escapeHtml(shareUrl)}" />
    <meta property="og:site_name" content="${escapeHtml(appName)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${escapeHtml(shareUrl)}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:image" content="${escapeHtml(versionedOgUrl)}" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="${VERSUS_INVITE_OG_WIDTH}" />
    <meta property="og:image:height" content="${VERSUS_INVITE_OG_HEIGHT}" />
    <meta property="og:image:alt" content="${escapeHtml(imageAlt)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(versionedOgUrl)}" />
    <meta name="twitter:image:alt" content="${escapeHtml(imageAlt)}" />
    <meta http-equiv="refresh" content="0; url=${escapeHtml(redirectUrl)}" />
    <style>
      :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #05040d; color: #fff5d9; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: radial-gradient(circle at 25% 50%, #34101c, #05040d 58%); }
      main { width: min(760px, calc(100% - 32px)); text-align: center; }
      img { display: block; width: 100%; border: 2px solid #b87a00; box-shadow: 0 24px 80px rgba(0,0,0,.55); }
      a { display: inline-block; margin-top: 22px; padding: 14px 18px; border: 2px solid #ffc42e; color: #05040d; background: #ffc42e; font-weight: 800; text-decoration: none; text-transform: uppercase; letter-spacing: .08em; }
    </style>
  </head>
  <body><main><p><strong>${escapeHtml(record.host_display_name)}</strong> challenges you with ${escapeHtml(record.fighter_name)}.</p><img src="${escapeHtml(versionedOgUrl)}" alt="${escapeHtml(imageAlt)}" /><a href="${escapeHtml(redirectUrl)}">Accept challenge</a></main></body>
</html>`, 200, {
    ...SHARE_PAGE_CACHE_HEADERS,
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  });
}

function ogResponse(body: BodyInit | null, etag?: string): Response {
  const headers = new Headers(OG_CACHE_HEADERS);
  if (etag) headers.set('ETag', etag);
  return new Response(body, { headers });
}

export async function versusInvitationOgImage(
  env: Env,
  rawToken: string,
  context: ExecutionContext,
): Promise<Response> {
  const invite = await readActiveVersusInvitation(env, rawToken);
  if (!invite) return new Response('Invitation unavailable', { status: 410, headers: { 'Cache-Control': 'no-store' } });
  const { record } = invite;
  if (record.template_version !== VERSUS_INVITE_TEMPLATE_VERSION) {
    const previousCacheKey = versusInvitationOgBlobKey(record.token_hash, record.template_version);
    await env.DB.prepare(`
      UPDATE versus_invitations
      SET template_version = ?
      WHERE token_hash = ? AND datetime(expires_at) > datetime('now')
    `).bind(VERSUS_INVITE_TEMPLATE_VERSION, record.token_hash).run();
    context.waitUntil(env.SPRITES.delete(previousCacheKey).catch((error: unknown) => {
      console.warn('Could not remove superseded versus invitation OG:', error instanceof Error ? error.message : error);
    }));
  }
  const cacheKey = versusInvitationOgBlobKey(record.token_hash, VERSUS_INVITE_TEMPLATE_VERSION);
  const cached = await env.SPRITES.get(cacheKey);
  if (cached) return ogResponse(cached.body, cached.httpEtag);

  const fighterImage = await env.SPRITES.get(record.fighter_source_blob_key);
  if (!fighterImage) return new Response('Invitation image unavailable', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const rendered = await renderVersusInviteOg({
    inviterName: record.host_display_name,
    fighterName: record.fighter_name,
    qualityTier: record.fighter_quality_tier,
    fighterImage: await fighterImage.arrayBuffer(),
  });
  const cachedBytes = rendered.slice(0);
  context.waitUntil(env.SPRITES.put(cacheKey, cachedBytes, {
    httpMetadata: { contentType: 'image/png', cacheControl: OG_CACHE_HEADERS['Cache-Control'] },
    customMetadata: { templateVersion: VERSUS_INVITE_TEMPLATE_VERSION },
  }).catch((error: unknown) => {
    console.warn('Could not cache versus invitation OG:', error instanceof Error ? error.message : error);
  }));
  return ogResponse(rendered);
}

export async function cleanupExpiredVersusInvitations(env: Env): Promise<void> {
  for (let batch = 0; batch < 5; batch++) {
    const { results } = await env.DB.prepare(`
      SELECT token_hash, template_version
      FROM versus_invitations
      WHERE datetime(expires_at) <= datetime('now')
      ORDER BY expires_at ASC
      LIMIT 200
    `).all<Pick<VersusInvitationRecord, 'token_hash' | 'template_version'>>();
    const expired = results ?? [];
    if (expired.length === 0) return;
    await env.SPRITES.delete(expired.map((record) => (
      versusInvitationOgBlobKey(record.token_hash, record.template_version)
    )));
    await env.DB.batch(expired.map((record) => env.DB.prepare(`
      DELETE FROM versus_invitations
      WHERE token_hash = ? AND datetime(expires_at) <= datetime('now')
    `).bind(record.token_hash)));
    if (expired.length < 200) return;
  }
}
