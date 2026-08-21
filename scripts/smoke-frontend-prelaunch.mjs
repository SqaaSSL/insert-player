const frontendUrl = (process.env.ASF_FRONTEND_URL || 'https://insertplayer.ai').replace(/\/+$/, '');
const timeoutMs = Number(process.env.ASF_FRONTEND_SMOKE_TIMEOUT_MS || 30_000);
const readyTimeoutMs = Number(process.env.ASF_FRONTEND_READY_TIMEOUT_MS || 90_000);
const retryDelayMs = Number(process.env.ASF_FRONTEND_RETRY_DELAY_MS || 2_500);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTarget(target, label = target) {
  const res = await fetch(target, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`${label} expected 2xx, got ${res.status}`);
  return { res, text: await res.text() };
}

async function waitForTarget(target, label = target) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started <= readyTimeoutMs) {
    try {
      return await fetchTarget(target, label);
    } catch (err) {
      lastError = err;
    }
    await sleep(Math.min(retryDelayMs, Math.max(0, readyTimeoutMs - (Date.now() - started))));
  }
  throw lastError instanceof Error ? lastError : new Error(`Prelaunch ${label} did not become ready.`);
}

async function waitForPath(path) {
  return waitForTarget(`${frontendUrl}${path}`, path);
}

function parseCsp(value) {
  const directives = new Map();
  for (const raw of value.split(';')) {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 0) directives.set(parts[0], parts.slice(1));
  }
  return directives;
}

try {
  const home = await waitForPath('/');
  assert(home.text.includes('<div id="app"></div>'), 'Prelaunch root is missing the app shell');
  assert(home.text.includes('Insert Player'), 'Prelaunch root is missing public brand metadata');
  assert(home.res.headers.get('X-Content-Type-Options') === 'nosniff', 'Prelaunch root is missing nosniff');
  const cspHeader = home.res.headers.get('Content-Security-Policy') || '';
  const csp = parseCsp(cspHeader);
  assert(csp.get('script-src')?.join(' ') === "'self'", 'Prelaunch script CSP must be self-only');
  assert(csp.get('connect-src')?.join(' ') === "'self'", 'Prelaunch connect CSP must be self-only');
  assert(csp.get('frame-src')?.join(' ') === "'none'", 'Prelaunch frame CSP must be none');
  assert(!cspHeader.includes('https://'), 'Prelaunch CSP must not trust external origins');
  if (frontendUrl === 'https://insertplayer.ai') {
    const www = await waitForTarget('https://www.insertplayer.ai/', 'www root');
    assert(www.text.includes('<div id="app"></div>'), 'www prelaunch root is missing the app shell');
    assert(www.text.includes('rel="canonical" href="https://insertplayer.ai/"'), 'www must keep the apex canonical URL');
  }

  for (const route of ['/legal', '/privacy', '/terms', '/refunds']) {
    const page = await waitForPath(route);
    assert(page.text.includes('<div id="app"></div>'), `${route} is missing the app shell`);
  }

  const scriptPaths = [...home.text.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  assert(scriptPaths.length > 0, 'Prelaunch root has no application bundle');
  const scripts = await Promise.all(scriptPaths.map((path) => waitForPath(path)));
  const js = scripts.map((entry) => entry.text).join('\n');
  assert(js.includes('Production access is opening shortly.'), 'Prelaunch bundle is missing status copy');
  for (const forbidden of ['pk_test_', 'pk_live_', 'api.insertplayer.ai', 'clerk.insertplayer.ai', 'clerk.accounts.dev', 'insert-player-api-sandbox']) {
    assert(!js.includes(forbidden), `Prelaunch bundle exposes ${forbidden}`);
  }

  const [robots, sitemap, manifest] = await Promise.all([
    waitForPath('/robots.txt'),
    waitForPath('/sitemap.xml'),
    waitForPath('/site.webmanifest'),
  ]);
  assert(robots.text.includes('Disallow: /community'), 'Prelaunch robots must block unavailable app routes');
  assert(!sitemap.text.includes('/community'), 'Prelaunch sitemap must not publish unavailable app routes');
  assert(JSON.parse(manifest.text).start_url === '/', 'Prelaunch manifest must start at root');
  console.log('Prelaunch frontend smoke checks passed.');
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
