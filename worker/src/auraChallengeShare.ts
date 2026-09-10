import { publicFrontendOrigin } from './branding';
import type { Env } from './types';
import { decodeAuraChallengePreview, escapeAuraPreviewHtml as escapeHtml } from './auraChallengePreview';
import { AURA_CHALLENGE_OG_VERSION } from './auraChallengeOgTemplate';
import { renderAuraChallengeOg } from './auraChallengeOg';

const COMMON_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Referrer-Policy': 'no-referrer' };
// A fixed script keeps crawlers on this metadata page. Browser navigation reads
// only the trusted server-built link; user text never enters JavaScript.
const REDIRECT_SCRIPT = "location.replace(document.getElementById('play-challenge').href);";
const REDIRECT_SCRIPT_HASH = 'sha256-DP9QMK10krGhOvqhGxooOy6ItaeXYi3dZY7G9fl57NU=';

function frontendOrigin(env: Env): string {
  try {
    const url = new URL(publicFrontendOrigin(env));
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.origin;
  } catch { /* Invalid deployment configuration never becomes a redirect. */ }
  return 'https://insertplayer.ai';
}

/** Public, stateless social preview: never reads auth, D1, R2 or player media. */
export async function auraChallengeShareResponse(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/challenges\/aura\/([A-Za-z0-9_-]{1,2048})(\/og\.png)?$/);
  const challenge = match && decodeAuraChallengePreview(match[1]);
  if (!match || !challenge) return new Response('Invalid Aura challenge.', { status: 404, headers: { ...COMMON_HEADERS, 'Cache-Control': 'no-store' } });
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { ...COMMON_HEADERS, Allow: 'GET, HEAD' } });
  const shareUrl = new URL(`/challenges/aura/${match[1]}`, url.origin).toString();
  const imageUrl = `${shareUrl}/og.png?v=${AURA_CHALLENGE_OG_VERSION}`;
  if (match[2]) {
    const headers = { ...COMMON_HEADERS, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' };
    if (request.method === 'HEAD') return new Response(null, { headers });
    // Derived public pixels may use the edge cache; there is no durable upload.
    const cache = typeof caches !== 'undefined' ? caches.default : undefined;
    const cacheKey = new Request(imageUrl);
    try { const cached = await cache?.match(cacheKey); if (cached) return cached; } catch { /* Cache availability is not required. */ }
    try {
      const response = new Response(await renderAuraChallengeOg(challenge), { headers });
      if (cache && context) context.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
      return response;
    } catch {
      return new Response('Preview temporarily unavailable.', { status: 503, headers: { ...COMMON_HEADERS, 'Cache-Control': 'no-store', 'Retry-After': '60' } });
    }
  }
  const playUrl = new URL('/challenge', frontendOrigin(env));
  playUrl.searchParams.set('challenge', match[1]);
  const title = `${challenge.name} set ${challenge.score.toLocaleString('en-US')} AURA · Insert Player`;
  const description = 'Can you beat me? Play the same song and routine free on Insert Player. Friendly challenge, not a ranked score.';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}"><meta name="robots" content="noindex,nofollow,noarchive">
    <meta property="og:type" content="website"><meta property="og:site_name" content="Insert Player"><meta property="og:url" content="${escapeHtml(shareUrl)}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:image" content="${escapeHtml(imageUrl)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:type" content="image/png"><meta property="og:image:alt" content="${escapeHtml(title)}. Can you beat me?">
    <meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${escapeHtml(imageUrl)}">
    <style>body{margin:0;background:#090b18;color:#fff4d6;font:18px system-ui;text-align:center;padding:32px}main{max-width:800px;margin:auto}img{width:100%;height:auto}a{display:inline-block;background:#ffce3a;color:#090b18;padding:16px 24px;font-weight:700}p{line-height:1.5}</style></head>
    <body><main><p>INSERT PLAYER · AURA CHALLENGE</p><img src="${escapeHtml(imageUrl)}" width="1200" height="630" alt="${escapeHtml(title)}"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p><a id="play-challenge" href="${escapeHtml(playUrl.toString())}">Play this challenge free</a></main><script>${REDIRECT_SCRIPT}</script></body></html>`;
  return new Response(request.method === 'HEAD' ? null : html, { headers: { ...COMMON_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Content-Security-Policy': `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src '${REDIRECT_SCRIPT_HASH}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` } });
}
