import { auraWatchApiOrigin, injectAuraWatchMetadata } from './aura-watch-page.mjs';
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const meta = (key, value, kind = 'property') => `<meta ${kind}="${key}" content="${escape(value)}">`;

/** Serve the same app to people and crawlers. Public metadata is fetched without
 * cookies or authorization, so private final frames never leak into an OG card. */
export async function battleWatchPageResponse({ request, env }) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/battles\/([A-Za-z0-9_-]{20,64})(\/finisher)?\/?$/);
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  if (!match) return new Response('Battle not found.', { status: 404, headers });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { ...Object.fromEntries(headers), Allow: 'GET, HEAD' } });
  const [, id, finisher] = match;
  const api = auraWatchApiOrigin(url.hostname);
  let battle = null;
  let status = 200;
  try {
    const response = await fetch(`${api}/api/battles/${id}`, { headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    if (response.ok) {
      const body = await response.json();
      if (body.battle?.id === id && body.battle.published === true && ['aura', 'fight', 'rush'].includes(body.battle.summary?.game)) battle = body.battle;
    } else if (response.status >= 500) status = 503;
  } catch { status = 503; }
  // Private owner pages still need a working app shell in order to sign in.
  const shell = await env.ASSETS.fetch(new Request(new URL('/', url.origin), { headers: { Accept: 'text/html' } }));
  if (!shell.ok || !(shell.headers.get('Content-Type') ?? '').includes('text/html')) return new Response('Battle temporarily unavailable.', { status: 503, headers });
  const summary = battle?.summary;
  const winner = summary?.winner === 'p1' ? summary.p1Name : summary?.winner === 'p2' ? summary.p2Name : null;
  const title = summary ? `${winner ? `${winner} wins` : `${summary.p1Name} vs ${summary.p2Name}`} · ${summary.game.toUpperCase()}${finisher ? ' finisher' : ''} · Insert Player` : 'Your battle · Insert Player';
  const description = summary ? `Watch ${finisher ? 'the AI finisher' : 'the battle and its finale'} on Insert Player. Then make the next one yours.` : 'Sign in to see your saved battle, or play Aura, Fight and Rush free on Insert Player.';
  const canonical = `${url.origin}/battles/${id}${finisher ? '/finisher' : ''}`;
  const image = summary ? `${api}/share/battles/${id}/og.png` : `${url.origin}/assets/social-card-v8.jpg`;
  const metadata = [`<title>${escape(title)}</title>`, meta('description', description, 'name'), meta('robots', 'noindex,nofollow,noarchive', 'name'),
    meta('og:type', 'website'), meta('og:site_name', 'Insert Player'), meta('og:title', title), meta('og:description', description), meta('og:url', canonical),
    meta('og:image', image), meta('og:image:secure_url', image), meta('og:image:width', '1200'), meta('og:image:height', '630'), meta('og:image:alt', title),
    meta('twitter:card', 'summary_large_image', 'name'), meta('twitter:title', title, 'name'), meta('twitter:description', description, 'name'), meta('twitter:image', image, 'name'),
    `<link rel="canonical" href="${escape(canonical)}">`].join('\n');
  const finalHeaders = new Headers(shell.headers);
  for (const [key, value] of headers) finalHeaders.set(key, value);
  for (const key of ['Content-Length', 'Content-Encoding', 'ETag', 'Last-Modified']) finalHeaders.delete(key);
  finalHeaders.set('Content-Type', 'text/html; charset=utf-8');
  if (status === 503) finalHeaders.set('Retry-After', '10');
  return new Response(request.method === 'HEAD' ? null : injectAuraWatchMetadata(await shell.text(), metadata), { status, headers: finalHeaders });
}
