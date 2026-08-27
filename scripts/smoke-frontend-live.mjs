import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeClerkPublishableKey } from './clerk-publishable-key.mjs';
import {
  frontendAssetProbeUrl,
  frontendShellReadinessError,
  parseContentSecurityPolicy,
  parsePositiveTimeoutMs,
} from './frontend-smoke-readiness.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rawArgs = process.argv.slice(2);
const targetArg = rawArgs.find((arg) => arg.startsWith('--target='));
const smokeTarget = targetArg?.slice('--target='.length) || 'live';
const isSandbox = smokeTarget === 'sandbox';
const DEFAULT_FRONTEND_URL = isSandbox ? 'https://insert-player-sandbox.pages.dev' : '';

function parseEnvText(text, values) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && value && !values.has(key)) values.set(key, value);
  }
}

function readEnvValues() {
  const values = new Map();
  const files = isSandbox
    ? ['.env.sandbox.local', '.env.sandbox']
    : ['.env.production.local', '.env.production', '.env.local', '.env'];
  for (const file of files) {
    const path = join(root, file);
    if (existsSync(path)) parseEnvText(readFileSync(path, 'utf8'), values);
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value) values.set(key, value);
  }
  return values;
}

function envValue(values, key) {
  return values.get(key)?.trim() ?? '';
}

const env = readEnvValues();
const frontendUrl = (
  envValue(env, isSandbox ? 'ASF_SANDBOX_FRONTEND_URL' : 'ASF_FRONTEND_URL') ||
  envValue(env, isSandbox ? 'ASF_SANDBOX_FRONTEND_ORIGIN' : 'ASF_FRONTEND_ORIGIN') ||
  DEFAULT_FRONTEND_URL
).replace(/\/+$/, '');
const workerUrl = (
  envValue(env, isSandbox ? 'ASF_SANDBOX_WORKER_URL' : 'ASF_WORKER_URL') ||
  envValue(env, 'VITE_API_BASE_URL')
).replace(/\/+$/, '');
const clerkKey = envValue(env, 'VITE_CLERK_PUBLISHABLE_KEY') || envValue(env, 'ASF_CLERK_PUBLISHABLE_KEY');
const decodedClerkKey = decodeClerkPublishableKey(clerkKey);
const expectedClerkOrigin = decodedClerkKey?.frontendApiOrigin ?? '';
const expectedApiOrigin = isSandbox
  ? 'https://insert-player-api-sandbox.shellbot.workers.dev'
  : 'https://api.insertplayer.ai';
const expectedAppName = envValue(env, 'ASF_PUBLIC_APP_NAME') || envValue(env, 'VITE_PUBLIC_APP_NAME') || 'Insert Player';
const expectedSocialCardPath = envValue(env, 'ASF_SOCIAL_CARD_PATH') || '/assets/social-card-v2.png';
const expectedAssetPath = envValue(env, 'ASF_EXPECTED_FRONTEND_ASSET_PATH');
const assetProbeNonce = envValue(env, 'ASF_FRONTEND_ASSET_PROBE_NONCE');
const FETCH_TIMEOUT_MS = parsePositiveTimeoutMs(
  envValue(env, 'ASF_FRONTEND_SMOKE_TIMEOUT_MS'),
  30_000,
  'ASF_FRONTEND_SMOKE_TIMEOUT_MS',
);
const FRONTEND_READY_TIMEOUT_MS = parsePositiveTimeoutMs(
  envValue(env, 'ASF_FRONTEND_READY_TIMEOUT_MS'),
  240_000,
  'ASF_FRONTEND_READY_TIMEOUT_MS',
);
const FRONTEND_RETRY_DELAY_MS = parsePositiveTimeoutMs(
  envValue(env, 'ASF_FRONTEND_RETRY_DELAY_MS'),
  2_500,
  'ASF_FRONTEND_RETRY_DELAY_MS',
);

const failures = [];

function fail(message) {
  failures.push(message);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function log(message) {
  console.log(`✓ ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function url(path) {
  return `${frontendUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

function absoluteFrontendUrl(pathOrUrl) {
  return /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : url(pathOrUrl);
}

async function fetchWithTimeout(label, target) {
  try {
    return await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} failed for ${target}: ${detail}`);
  }
}

async function fetchText(label, pathOrUrl) {
  const target = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : url(pathOrUrl);
  const res = await fetchWithTimeout(label, target);
  if (!res.ok) {
    throw new Error(`${label} expected 2xx, got ${res.status} at ${target}`);
  }
  return {
    res,
    text: await res.text(),
    url: target,
  };
}

function isTransientFrontendStatus(status) {
  return [404, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524].includes(status);
}

async function waitForFrontendText(label, pathOrUrl, { readinessError } = {}) {
  const target = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : url(pathOrUrl);
  const started = Date.now();
  let lastError = null;

  while (Date.now() - started <= FRONTEND_READY_TIMEOUT_MS) {
    try {
      const res = await fetchWithTimeout(label, target);
      if (res.ok) {
        const candidate = {
          res,
          text: await res.text(),
          url: target,
        };
        const reason = readinessError?.(candidate) ?? '';
        if (!reason) return candidate;
        lastError = new Error(`${label} still serves a previous deployment: ${reason}`);
      } else {
        lastError = new Error(`${label} expected 2xx, got ${res.status} at ${target}`);
        if (!isTransientFrontendStatus(res.status)) break;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    const elapsed = Date.now() - started;
    const remaining = FRONTEND_READY_TIMEOUT_MS - elapsed;
    if (remaining <= 0) break;
    await sleep(Math.min(FRONTEND_RETRY_DELAY_MS, remaining));
  }

  const waitedSeconds = Math.round((Date.now() - started) / 1000);
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label} did not become ready after ${waitedSeconds}s at ${target}: ${detail}`);
}

function extractAssetPaths(html) {
  const paths = new Set();
  for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    const value = match[1];
    if (value.startsWith('/assets/')) paths.add(value);
  }
  return [...paths];
}

async function assertSpaRoute(path) {
  const { res, text } = await fetchText(`frontend route ${path}`, path);
  const contentType = res.headers.get('Content-Type') ?? '';
  assert(contentType.includes('text/html'), `${path} did not return HTML`);
  assert(text.includes('<div id="app"></div>'), `${path} did not return the app shell`);
}

function assertCspSource(directives, directive, source) {
  assert(
    directives.get(directive)?.includes(source),
    `Frontend CSP ${directive} is missing ${source}`,
  );
}

async function main() {
  if (!['live', 'sandbox'].includes(smokeTarget)) {
    throw new Error('Frontend smoke target must be --target=live or --target=sandbox.');
  }
  if (!frontendUrl || !/^https:\/\//i.test(frontendUrl)) {
    throw new Error('Set ASF_FRONTEND_URL or ASF_FRONTEND_ORIGIN to the deployed HTTPS Pages URL.');
  }
  if (expectedAssetPath && !/^\/assets\/[A-Za-z0-9._-]+\.js$/.test(expectedAssetPath)) {
    throw new Error('ASF_EXPECTED_FRONTEND_ASSET_PATH must be a root-relative JavaScript asset path.');
  }

  assert(expectedClerkOrigin, 'Frontend smoke requires a valid Clerk publishable key');
  const home = await waitForFrontendText('frontend home', '/', {
    readinessError: ({ res, text }) => frontendShellReadinessError({
      html: text,
      cspHeader: res.headers.get('Content-Security-Policy') ?? '',
      expectedClerkOrigin,
      expectedAssetPath,
    }),
  });
  assert(home.res.headers.get('X-Content-Type-Options') === 'nosniff', 'Frontend shell missing nosniff header');
  assert(home.res.headers.get('Referrer-Policy') === 'strict-origin-when-cross-origin', 'Frontend shell missing referrer policy');
  assert(home.res.headers.get('X-Frame-Options') === 'DENY', 'Frontend shell missing frame protection');
  const cspHeader = home.res.headers.get('Content-Security-Policy') ?? '';
  assert(cspHeader, 'Frontend shell missing Content Security Policy');
  const csp = parseContentSecurityPolicy(cspHeader);
  for (const [directive, source] of [
    ['default-src', "'self'"],
    ['base-uri', "'self'"],
    ['object-src', "'none'"],
    ['frame-ancestors', "'none'"],
    ['form-action', "'self'"],
    ['script-src', "'self'"],
    ['script-src', 'https://challenges.cloudflare.com'],
    ['script-src', expectedClerkOrigin],
    ['script-src', 'https://*.protect.clerk.com'],
    ['style-src', "'unsafe-inline'"],
    ['img-src', 'blob:'],
    ['img-src', 'https://img.clerk.com'],
    ['img-src', expectedApiOrigin],
    ['media-src', expectedApiOrigin],
    ['connect-src', expectedApiOrigin],
    ['connect-src', expectedClerkOrigin],
    ['connect-src', 'https://*.protect.clerk.com'],
    ['frame-src', 'https://challenges.cloudflare.com'],
    ['frame-src', 'https://*.protect.clerk.com'],
    ['worker-src', 'blob:'],
    ['manifest-src', "'self'"],
  ]) assertCspSource(csp, directive, source);
  const forbiddenCspSources = isSandbox
    ? ['https://api.insertplayer.ai', 'https://clerk.insertplayer.ai', 'https://*.clerk.accounts.dev']
    : [
        'https://insert-player-api-sandbox.shellbot.workers.dev',
        'https://ai-street-fighter-api.shellbot.workers.dev',
        'https://*.clerk.accounts.dev',
      ];
  for (const [directive, sources] of csp) {
    for (const source of forbiddenCspSources) {
      assert(!sources.includes(source), `Frontend CSP ${directive} must not trust ${source}`);
    }
  }
  assert(csp.has('upgrade-insecure-requests'), 'Frontend CSP must upgrade insecure requests');
  assert(!csp.get('script-src')?.includes("'unsafe-eval'"), 'Frontend CSP must not allow unsafe eval');
  assert(!csp.get('script-src')?.includes("'unsafe-inline'"), 'Frontend CSP must not allow inline scripts');
  assert(home.res.headers.get('Permissions-Policy') === 'camera=(), microphone=(), geolocation=()', 'Frontend shell missing permissions policy');
  assert(
    home.res.headers.get('Strict-Transport-Security') === 'max-age=31536000; includeSubDomains',
    'Frontend shell missing HSTS header',
  );
  assert(
    home.res.headers.get('Cache-Control') === 'public, max-age=0, must-revalidate',
    'Frontend shell should revalidate the app shell',
  );
  assert(home.text.includes(expectedAppName), `Home HTML missing app title ${expectedAppName}`);
  assert(!home.text.includes('test-gemini'), 'Production frontend exposes the old Gemini test page');
  assert(home.text.includes('rel="canonical" href="https://insertplayer.ai/"'), 'Home HTML missing canonical production origin');
  assert(home.text.includes('rel="manifest" href="/site.webmanifest"'), 'Home HTML missing web app manifest link');
  if (isSandbox) {
    assert(home.text.includes('property="og:image"'), 'Home HTML missing social preview image metadata');
  } else {
    assert(
      home.text.includes(`property="og:image" content="${absoluteFrontendUrl(expectedSocialCardPath)}"`),
      'Home HTML missing social preview image',
    );
  }
  assert(home.text.includes('name="twitter:card" content="summary_large_image"'), 'Home HTML missing large Twitter/X card metadata');
  log('frontend root serves the app shell');

  const manifest = await fetchText('web app manifest', '/site.webmanifest');
  const manifestJson = JSON.parse(manifest.text);
  assert(manifestJson.name === expectedAppName, 'Manifest has the wrong app name');
  assert(manifestJson.id === '/', 'Manifest must keep a stable root application id');
  assert(manifestJson.start_url === '/menu', 'Manifest should launch into /menu');
  assert(manifestJson.orientation === 'any', 'Manifest must not force the creation flow into landscape');
  assert((manifestJson.icons ?? []).some((icon) => icon.src === '/assets/app-icon-512.png'), 'Manifest missing 512px app icon');
  const socialCard = await fetchWithTimeout('social card image', url(expectedSocialCardPath));
  assert(socialCard.ok, 'Social card image is not reachable');
  assert((socialCard.headers.get('Content-Type') ?? '').includes('image/'), 'Social card is not served as an image');
  log('frontend exposes launch metadata, manifest, and social card assets');

  const robots = await fetchText('robots policy', '/robots.txt');
  assert(robots.text.includes('Sitemap: https://insertplayer.ai/sitemap.xml'), 'robots.txt missing canonical sitemap');
  assert(robots.text.includes('Disallow: /gallery'), 'robots.txt must exclude private roster routes');
  const sitemap = await fetchText('public sitemap', '/sitemap.xml');
  assert(sitemap.text.includes('<loc>https://insertplayer.ai/community</loc>'), 'Sitemap missing Community');
  assert(sitemap.text.includes('<loc>https://insertplayer.ai/privacy</loc>'), 'Sitemap missing Privacy');
  assert(!sitemap.text.includes('/gallery'), 'Sitemap must not publish private roster routes');
  log('frontend publishes canonical crawl metadata without private routes');

  for (const route of [
    '/menu',
    '/menu?checkout=success&session_id=smoke-checkout',
    '/menu?checkout=cancelled',
    '/gallery',
    '/community',
    '/community?fighter=smoke-link',
    '/roster/cpu',
    '/legal',
    '/privacy',
    '/terms',
    '/refunds',
  ]) {
    await assertSpaRoute(route);
  }
  log('Cloudflare Pages SPA fallback serves direct app and checkout-return routes');

  const assetPaths = extractAssetPaths(home.text);
  assert(assetPaths.some((path) => path.endsWith('.js')), 'Frontend HTML did not reference a JS asset');
  if (expectedAssetPath) {
    assert(assetPaths.includes(expectedAssetPath), `Frontend HTML did not reference deployed asset ${expectedAssetPath}`);
  }
  const jsTexts = [];
  for (const assetPath of assetPaths.filter((path) => path.endsWith('.js'))) {
    const assetProbeUrl = frontendAssetProbeUrl(frontendUrl, assetPath, assetProbeNonce);
    const asset = await waitForFrontendText(`frontend asset ${assetPath}`, assetProbeUrl, {
      readinessError: ({ res }) => {
        const contentType = res.headers.get('Content-Type') ?? '';
        if (!/javascript/i.test(contentType)) return `expected JavaScript, got ${contentType || 'no content type'}`;
        const cacheControl = res.headers.get('Cache-Control') ?? '';
        if (!cacheControl.includes('immutable')) return `expected immutable cache headers, got ${cacheControl || 'none'}`;
        return '';
      },
    });
    jsTexts.push(asset.text);
  }
  const jsBundle = jsTexts.join('\n');
  assert(!/VITE_(GEMINI|FAL|RUNWAY|FREEPIK|LUDO)_API_KEY/.test(jsBundle), 'Frontend bundle contains client-exposed provider secret env names');
  assert(!/VITE_STRIPE_(SECRET|WEBHOOK)_/.test(jsBundle), 'Frontend bundle contains client-exposed Stripe secret env names');
  if (workerUrl) {
    assert(jsBundle.includes(workerUrl), `Frontend bundle does not include expected Worker URL ${workerUrl}`);
  }
  if (clerkKey) {
    assert(jsBundle.includes(clerkKey), 'Frontend bundle does not include the expected Clerk publishable key');
  } else {
    const expectedClerkPrefix = isSandbox ? /pk_test_/ : /pk_live_/;
    assert(expectedClerkPrefix.test(jsBundle), `Frontend bundle does not appear to include a ${smokeTarget} Clerk publishable key`);
  }
  log(`frontend bundle is wired to ${smokeTarget} Worker and Clerk without secret env names`);

  const testPage = await fetchWithTimeout('removed Gemini test page', url('/test-gemini.html'));
  assert(testPage.status === 404 || testPage.url.endsWith('/test-gemini.html'), 'Unexpected redirect while checking removed test page');
  if (testPage.ok) {
    const body = await testPage.text();
    assert(!body.includes('Nano Banana 2'), 'Removed Gemini test page is still publicly served');
  }
  log('old Gemini test page is not publicly exposed');
}

try {
  await main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

if (failures.length > 0) {
  throw new Error(`Frontend live smoke failed:\n- ${failures.join('\n- ')}`);
}

console.log(`Frontend ${smokeTarget} smoke checks passed.`);
