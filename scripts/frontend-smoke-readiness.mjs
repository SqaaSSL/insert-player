export function parseContentSecurityPolicy(value) {
  const directives = new Map();
  for (const rawDirective of value.split(';')) {
    const parts = rawDirective.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 0) directives.set(parts[0], parts.slice(1));
  }
  return directives;
}

export function frontendAssetProbeUrl(frontendUrl, assetPath, nonce) {
  const target = new URL(assetPath, `${frontendUrl.replace(/\/+$/, '')}/`);
  if (nonce) target.searchParams.set('__insert_player_readiness', nonce);
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
}) {
  if (!html.includes('<div id="app"></div>')) {
    return 'the current response is not the app shell';
  }
  if (expectedAssetPath && !html.includes(`src="${expectedAssetPath}"`)) {
    return `the app shell does not reference deployed asset ${expectedAssetPath}`;
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
