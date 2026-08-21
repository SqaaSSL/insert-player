import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeClerkPublishableKey } from './clerk-publishable-key.mjs';
import { frontendHeadersForTarget } from './frontend-security-headers.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const targetArg = process.argv.slice(2).find((arg) => arg.startsWith('--target='));
const target = targetArg?.slice('--target='.length) || '';

function parseEnvText(text, values) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && value) values.set(key, value);
  }
}

function readEnvValues(files) {
  const values = new Map();
  for (const file of files) {
    const path = join(root, file);
    if (existsSync(path)) parseEnvText(readFileSync(path, 'utf8'), values);
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value) values.set(key, value);
  }
  return values;
}

function configure() {
  if (!['live', 'sandbox', 'prelaunch'].includes(target)) {
    throw new Error('Use --target=live, --target=sandbox, or --target=prelaunch.');
  }

  let headers;
  if (target === 'prelaunch') {
    headers = frontendHeadersForTarget({ target });
  } else {
    const files = target === 'sandbox'
      ? ['.env.sandbox', '.env.sandbox.local']
      : ['.env', '.env.local', '.env.production', '.env.production.local'];
    const values = readEnvValues(files);
    const apiOrigin = target === 'sandbox'
      ? 'https://insert-player-api-sandbox.shellbot.workers.dev'
      : 'https://api.insertplayer.ai';
    const clerkKey = values.get('VITE_CLERK_PUBLISHABLE_KEY')?.trim() ?? '';
    const decodedClerkKey = decodeClerkPublishableKey(clerkKey);
    if (!decodedClerkKey) {
      throw new Error(`Cannot generate ${target} CSP without a valid Clerk publishable key.`);
    }
    if (target === 'live' && decodedClerkKey.frontendApiOrigin !== 'https://clerk.insertplayer.ai') {
      throw new Error('Live CSP requires the Clerk Frontend API at https://clerk.insertplayer.ai.');
    }
    if (target === 'sandbox' && decodedClerkKey.environment !== 'test') {
      throw new Error('Sandbox CSP requires a Clerk development publishable key.');
    }
    headers = frontendHeadersForTarget({
      target,
      apiOrigin,
      clerkFrontendApiOrigin: decodedClerkKey.frontendApiOrigin,
    });
  }

  const headersPath = join(root, 'dist', '_headers');
  if (!existsSync(join(root, 'dist', 'index.html'))) {
    throw new Error('Build dist before configuring frontend headers.');
  }
  writeFileSync(headersPath, headers, 'utf8');
  if (target === 'prelaunch') {
    writeFileSync(join(root, 'dist', 'robots.txt'), `User-agent: *
Allow: /
Disallow: /menu
Disallow: /gallery
Disallow: /fighters
Disallow: /roster
Disallow: /fight
Disallow: /community
Disallow: /moderation

Sitemap: https://insertplayer.ai/sitemap.xml
`, 'utf8');
    writeFileSync(join(root, 'dist', 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://insertplayer.ai/</loc></url>
  <url><loc>https://insertplayer.ai/legal</loc></url>
  <url><loc>https://insertplayer.ai/privacy</loc></url>
  <url><loc>https://insertplayer.ai/terms</loc></url>
  <url><loc>https://insertplayer.ai/refunds</loc></url>
</urlset>
`, 'utf8');
    const manifestPath = join(root, 'dist', 'site.webmanifest');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.start_url = '/';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  console.log(`Frontend ${target} CSP written to dist/_headers.`);
}

try {
  configure();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
