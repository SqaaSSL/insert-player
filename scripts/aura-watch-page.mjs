import { decodeAuraChallengePreview, escapeAuraPreviewHtml as escapeHtml } from '../worker/src/auraChallengePreview.ts';
import { AURA_CHALLENGE_OG_VERSION } from '../worker/src/auraChallengeOgTemplate.ts';

const PRODUCTION_API = 'https://api.insertplayer.ai';
const SANDBOX_API = 'https://insert-player-api-sandbox.shellbot.workers.dev';
const ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export function auraWatchApiOrigin(hostname) {
  return /^(?:[a-z0-9-]+\.)?insert-player-sandbox\.pages\.dev$/.test(hostname)
    ? SANDBOX_API : PRODUCTION_API;
}

function watchMetadata({ challenge, token, apiOrigin, pageUrl }) {
  const title = challenge
    ? `${challenge.name} · ${challenge.score.toLocaleString('en-US')} AURA · Insert Player`
    : 'Aura battle unavailable · Insert Player';
  const description = challenge
    ? 'Watch my Aura battle. Think you can beat it? Play the same challenge free on Insert Player.'
    : 'This battle link has expired or been removed. Play Aura free on Insert Player.';
  const imageUrl = challenge
    ? `${apiOrigin}/challenges/aura/${token}/og.png?v=${AURA_CHALLENGE_OG_VERSION}` : null;
  const meta = (key, value, kind = 'property') => `<meta ${kind}="${key}" content="${escapeHtml(value)}">`;
  return [
    `<title>${escapeHtml(title)}</title>`,
    meta('description', description, 'name'),
    meta('robots', 'noindex,nofollow,noarchive', 'name'),
    meta('og:type', 'website'), meta('og:site_name', 'Insert Player'),
    meta('og:title', title), meta('og:description', description), meta('og:url', pageUrl),
    meta('twitter:card', imageUrl ? 'summary_large_image' : 'summary', 'name'),
    meta('twitter:title', title, 'name'), meta('twitter:description', description, 'name'),
    ...(imageUrl ? [
      meta('og:image', imageUrl), meta('og:image:secure_url', imageUrl),
      meta('og:image:type', 'image/png'), meta('og:image:width', '1200'), meta('og:image:height', '630'),
      meta('og:image:alt', `${title}. Watch the battle and beat my score.`),
      meta('twitter:image', imageUrl, 'name'), meta('twitter:image:alt', title, 'name'),
    ] : []),
    `<link rel="canonical" href="${escapeHtml(pageUrl)}">`,
  ].join('\n');
}

export function injectAuraWatchMetadata(html, metadata) {
  // Replace the homepage preview instead of leaving duplicate tags for crawlers
  // to choose between. No public text is inserted into scripts or raw HTML.
  return html
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
    .replace(/<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:[^"']*|twitter:[^"']*|description|robots)["'][^>]*>/gi, '')
    .replace(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/gi, '')
    .replace(/<\/head>/i, `${metadata}\n</head>`);
}

/** Only /watch/:id uses a Function. Both people and crawlers receive the same
 * current React shell with battle metadata; there is no bot-only redirect. */
export async function auraWatchPageResponse(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.pathname.match(/^\/watch\/([A-Za-z0-9_-]{32})\/?$/)?.[1];
  const baseHeaders = {
    'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
  if (!id || !ID_PATTERN.test(id)) return new Response('Battle not found.', { status: 404, headers: baseHeaders });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { ...baseHeaders, Allow: 'GET, HEAD' } });
  const apiOrigin = auraWatchApiOrigin(url.hostname);
  let challenge = null;
  let token = '';
  let status = 503;
  try {
    // Never forward browser credentials, IP headers or user-controlled origins.
    const response = await fetch(`${apiOrigin}/api/aura/clips/${id}`, {
      headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404 || response.status === 410) status = 404;
    if (response.ok) {
      const data = await response.json();
      const decoded = typeof data.challengeToken === 'string' && decodeAuraChallengePreview(data.challengeToken);
      if (data.id === id && decoded && Date.parse(data.expiresAt) > Date.now()) {
        challenge = decoded;
        token = data.challengeToken;
        status = 200;
      }
    }
  } catch { /* The shell still offers a retry when metadata is unavailable. */ }
  // Fetch the pretty homepage path so the Pages asset service applies _headers.
  const assetResponse = await env.ASSETS.fetch(new Request(new URL('/', url.origin), { headers: { Accept: 'text/html' } }));
  if (!assetResponse.ok || !(assetResponse.headers.get('Content-Type') ?? '').includes('text/html')) {
    return new Response('Battle temporarily unavailable. Please retry.', { status: 503, headers: baseHeaders });
  }
  const headers = new Headers(assetResponse.headers);
  for (const [key, value] of Object.entries(baseHeaders)) headers.set(key, value);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.delete('Content-Length');
  headers.delete('Content-Encoding');
  headers.delete('ETag');
  headers.delete('Last-Modified');
  if (status === 503) headers.set('Retry-After', '10');
  const metadata = watchMetadata({ challenge, token, apiOrigin, pageUrl: `${url.origin}/watch/${id}` });
  const html = injectAuraWatchMetadata(await assetResponse.text(), metadata);
  return new Response(request.method === 'HEAD' ? null : html, { status, headers });
}
