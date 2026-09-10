export function parseContentSecurityPolicy(value) {
  const directives = new Map();
  for (const rawDirective of value.split(';')) {
    const parts = rawDirective.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 0) directives.set(parts[0], parts.slice(1));
  }
  return directives;
}

export function frontendAssetProbeUrl(frontendUrl, assetPath, nonce, attempt) {
  const target = new URL(assetPath, `${frontendUrl.replace(/\/+$/, '')}/`);
  if (nonce) {
    target.searchParams.set('__insert_player_readiness', nonce);
    if (attempt !== undefined) {
      if (!Number.isSafeInteger(attempt) || attempt < 0) {
        throw new Error('frontend asset probe attempt must be a non-negative integer');
      }
      target.searchParams.set('__insert_player_readiness_attempt', String(attempt));
    }
  }
  return target.toString();
}

export function parsePositiveTimeoutMs(value, fallback, label) {
  const raw = value?.trim() || String(fallback);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number of milliseconds`);
  }
  return parsed;
}

export function frontendShellReadinessError({
  html,
  cspHeader,
  expectedClerkOrigin,
  expectedAssetPath = '',
  expectedHtmlFragments = [],
}) {
  if (!html.includes('<div id="app"></div>')) {
    return 'the current response is not the app shell';
  }
  if (expectedAssetPath && !html.includes(`src="${expectedAssetPath}"`)) {
    return `the app shell does not reference deployed asset ${expectedAssetPath}`;
  }
  for (const fragment of expectedHtmlFragments) {
    if (fragment && !html.includes(fragment)) {
      return `the app shell is missing release marker ${fragment}`;
    }
  }
  if (!cspHeader) {
    return 'the current response has no Content Security Policy';
  }

  const csp = parseContentSecurityPolicy(cspHeader);
  for (const source of ['https://challenges.cloudflare.com', expectedClerkOrigin]) {
    if (!source || !csp.get('script-src')?.includes(source)) {
      return `script-src is missing ${source || 'the Clerk Frontend API origin'}`;
    }
  }
  return '';
}

/** A deliberately missing, well-formed clip ID still traverses Pages → API.
 * A static SPA 200 or a swallowed subrequest failure must fail deployment. */
export function missingAuraWatchReadinessError({ status, html, contentType, cacheControl, expectedAssetPath = '' }) {
  if (status !== 404) return `missing Aura watch route expected HTTP 404, got ${status}`;
  if (!contentType.includes('text/html') || !html.includes('<div id="app"></div>')) {
    return 'missing Aura watch route did not preserve the app shell';
  }
  if (!cacheControl.split(',').some(value => value.trim() === 'no-store')) {
    return 'missing Aura watch route must not be cached';
  }
  if (expectedAssetPath && !html.includes(`src="${expectedAssetPath}"`)) {
    return 'missing Aura watch route references a different app release';
  }
  if (/<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:image(?::[^"']*)?|twitter:image(?::[^"']*)?)["']/i.test(html)) {
    return 'missing Aura watch route retained a battle or homepage image preview';
  }
  return '';
}
