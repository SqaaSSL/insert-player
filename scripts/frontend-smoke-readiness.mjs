export function parseContentSecurityPolicy(value) {
  const directives = new Map();
  for (const rawDirective of value.split(';')) {
    const parts = rawDirective.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 0) directives.set(parts[0], parts.slice(1));
  }
  return directives;
}

export function frontendShellReadinessError({ html, cspHeader, expectedClerkOrigin }) {
  if (!html.includes('<div id="app"></div>')) {
    return 'the current response is not the app shell';
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
