const SHARED_CACHE_RULES = `
/assets/*
  Cache-Control: public, max-age=31536000, immutable

/site.webmanifest
  Cache-Control: public, max-age=3600

/robots.txt
  Cache-Control: public, max-age=3600

/sitemap.xml
  Cache-Control: public, max-age=3600
`;

function cleanHttpsOrigin(value, label) {
  const trimmed = String(value ?? '').trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be an HTTPS origin.`);
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== trimmed) {
    throw new Error(`${label} must be an HTTPS origin.`);
  }
  return parsed.origin;
}

function headerFile(csp) {
  return `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Content-Security-Policy: ${csp}
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Cache-Control: public, max-age=0, must-revalidate
${SHARED_CACHE_RULES}`;
}

export function frontendHeadersForTarget({
  target,
  apiOrigin = '',
  clerkFrontendApiOrigin = '',
}) {
  if (target === 'prelaunch') {
    return headerFile([
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "media-src 'self'",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-src 'none'",
      "worker-src 'self'",
      "manifest-src 'self'",
      'upgrade-insecure-requests',
    ].join('; '));
  }

  if (target !== 'live' && target !== 'sandbox') {
    throw new Error('Frontend header target must be live, sandbox, or prelaunch.');
  }

  const api = cleanHttpsOrigin(apiOrigin, 'apiOrigin');
  const clerk = cleanHttpsOrigin(clerkFrontendApiOrigin, 'clerkFrontendApiOrigin');
  return headerFile([
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' https://challenges.cloudflare.com ${clerk} https://*.protect.clerk.com`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https://img.clerk.com ${api}`,
    `media-src 'self' data: blob: ${api}`,
    "font-src 'self' data:",
    `connect-src 'self' ${api} ${clerk} https://clerk-telemetry.com https://*.clerk-telemetry.com https://img.clerk.com https://*.protect.clerk.com https://challenges.cloudflare.com`,
    "frame-src 'self' https://challenges.cloudflare.com https://*.protect.clerk.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    'upgrade-insecure-requests',
  ].join('; '));
}
