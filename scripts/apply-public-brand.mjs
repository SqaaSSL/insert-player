import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);

function argValue(name) {
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1).trim();
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1]?.trim() ?? '' : '';
}

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
  for (const file of ['.env.production.local', '.env.production', '.env.local', '.env']) {
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

function cleanBrandText(value, label, minLength) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (text.length < minLength) throw new Error(`${label} is required.`);
  if (/(^|[^a-z0-9])(?:ai[\s_-]*)?street[\s_-]*fighter([^a-z0-9]|$)/i.test(text) || /\bcapcom\b/i.test(text)) {
    throw new Error(`${label} must not use AI Street Fighter, Street Fighter, or Capcom-adjacent wording.`);
  }
  if (/\b(mortal\s+kombat|tekken|smash\s+bros|hadouken|ryu|ken\s+masters)\b/i.test(text)) {
    throw new Error(`${label} must not use existing fighting-game franchise wording.`);
  }
  return text;
}

function normalizeOrigin(value) {
  const origin = String(value ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(origin)) {
    throw new Error('Production origin must be an HTTPS URL.');
  }
  return origin;
}

function writeIfChanged(path, text, changed) {
  const abs = join(root, path);
  const before = readFileSync(abs, 'utf8');
  if (before === text) return changed;
  writeFileSync(abs, text);
  changed.push(path);
  return changed;
}

function replaceRequired(text, pattern, replacement, label) {
  if (!pattern.test(text)) throw new Error(`Could not update ${label}.`);
  return text.replace(pattern, replacement);
}

function updateHtml({ name, origin, socialCardPath, description }) {
  let text = readFileSync(join(root, 'index.html'), 'utf8');
  const imageUrl = `${origin}${socialCardPath.startsWith('/') ? socialCardPath : `/${socialCardPath}`}`;
  text = replaceRequired(text, /<title>[^<]+<\/title>/, `<title>${name}</title>`, 'HTML title');
  text = replaceRequired(text, /<meta\s+name="description"\s+content="[^"]*"\s*\/>/, `<meta name="description" content="${description}" />`, 'HTML description');
  for (const attr of ['application-name', 'apple-mobile-web-app-title']) {
    text = replaceRequired(text, new RegExp(`<meta\\s+name="${attr}"\\s+content="[^"]*"\\s*/>`), `<meta name="${attr}" content="${name}" />`, `HTML ${attr}`);
  }
  for (const prop of ['og:site_name', 'og:title']) {
    text = replaceRequired(text, new RegExp(`<meta\\s+property="${prop}"\\s+content="[^"]*"\\s*/>`), `<meta property="${prop}" content="${name}" />`, `HTML ${prop}`);
  }
  text = replaceRequired(text, /<meta\s+property="og:url"\s+content="[^"]*"\s*\/>/, `<meta property="og:url" content="${origin}/" />`, 'HTML og:url');
  text = replaceRequired(text, /<meta\s+property="og:image"\s+content="[^"]*"\s*\/>/, `<meta property="og:image" content="${imageUrl}" />`, 'HTML og:image');
  text = replaceRequired(text, /<meta\s+name="twitter:title"\s+content="[^"]*"\s*\/>/, `<meta name="twitter:title" content="${name}" />`, 'HTML twitter:title');
  text = replaceRequired(text, /<meta\s+name="twitter:image"\s+content="[^"]*"\s*\/>/, `<meta name="twitter:image" content="${imageUrl}" />`, 'HTML twitter:image');
  return text;
}

function updateManifest({ name, shortName, description }) {
  const path = join(root, 'public/site.webmanifest');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.name = name;
  manifest.short_name = shortName;
  manifest.description = description;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function updateSocialSvg({ name, description }) {
  let text = readFileSync(join(root, 'public/assets/social-card.svg'), 'utf8');
  text = replaceRequired(text, /<title id="title">[^<]+<\/title>/, `<title id="title">${name} social card</title>`, 'social SVG title');
  text = replaceRequired(text, /<desc id="desc">[^<]+<\/desc>/, `<desc id="desc">${description}</desc>`, 'social SVG desc');
  text = replaceRequired(
    text,
    /(<text id="social-card-brand"[^>]*>)[^<]*(<\/text>)/,
    `$1${name.toUpperCase()}$2`,
    'social SVG brand name',
  );
  return text;
}

function updateSocialCardTemplate({ name, description }) {
  let text = readFileSync(join(root, 'scripts/assets/social-card.html'), 'utf8');
  text = replaceRequired(text, /<title>[^<]+<\/title>/, `<title>${name} social card</title>`, 'social card title');
  text = replaceRequired(
    text,
    /<meta name="description" content="[^"]*" \/>/,
    `<meta name="description" content="${description}" />`,
    'social card description',
  );
  text = replaceRequired(
    text,
    /(<h1 id="social-card-brand"[^>]*>)[^<]*(<\/h1>)/,
    `$1${name.toUpperCase()}$2`,
    'social card brand name',
  );
  return text;
}

function updateIconSvg({ name, shortName }) {
  let text = readFileSync(join(root, 'public/assets/app-icon.svg'), 'utf8');
  text = replaceRequired(text, /<title id="title">[^<]+<\/title>/, `<title id="title">${name} app icon</title>`, 'icon SVG title');
  text = replaceRequired(text, /<desc id="desc">[^<]+<\/desc>/, `<desc id="desc">Arcade badge with the letters ${shortName}.</desc>`, 'icon SVG desc');
  text = replaceRequired(
    text,
    /(<text x="256" y="286"[^>]*>)[^<]*(<\/text>)/,
    `$1${shortName}$2`,
    'icon SVG initials',
  );
  return text;
}

function updateEnvExample(path, pairs) {
  let text = readFileSync(join(root, path), 'utf8');
  for (const [key, value] of Object.entries(pairs)) {
    const replacement = `${key}=${value}`;
    const commented = new RegExp(`^#\\s*${key}=.*$`, 'm');
    const active = new RegExp(`^${key}=.*$`, 'm');
    if (active.test(text)) text = text.replace(active, replacement);
    else if (commented.test(text)) text = text.replace(commented, replacement);
    else text = `${text.replace(/\s*$/, '')}\n${replacement}\n`;
  }
  return text;
}

function main() {
  const env = readEnvValues();
  const dryRun = args.includes('--dry-run');
  const name = cleanBrandText(
    argValue('--name') || envValue(env, 'ASF_PUBLIC_APP_NAME') || envValue(env, 'VITE_PUBLIC_APP_NAME'),
    'Public brand name',
    3,
  );
  const shortName = cleanBrandText(
    argValue('--short') || envValue(env, 'ASF_PUBLIC_APP_SHORT_NAME') || envValue(env, 'VITE_PUBLIC_APP_SHORT_NAME') || name.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase(),
    'Public short name',
    2,
  );
  const origin = normalizeOrigin(argValue('--origin') || envValue(env, 'ASF_FRONTEND_URL') || envValue(env, 'ASF_FRONTEND_ORIGIN'));
  const socialCardPath = argValue('--social-card') || envValue(env, 'ASF_SOCIAL_CARD_PATH') || '/assets/social-card-v6.png';
  const description = argValue('--description') || envValue(env, 'ASF_PUBLIC_APP_DESCRIPTION') || `Turn a photo into a playable arcade character in ${name}.`;

  const updates = {
    'index.html': updateHtml({ name, origin, socialCardPath, description }),
    'public/site.webmanifest': updateManifest({ name, shortName, description }),
    'scripts/assets/social-card.html': updateSocialCardTemplate({ name, description }),
    'public/assets/social-card.svg': updateSocialSvg({ name, description }),
    'public/assets/app-icon.svg': updateIconSvg({ name, shortName }),
    '.env.production.example': updateEnvExample('.env.production.example', {
      VITE_PUBLIC_APP_NAME: name,
      VITE_PUBLIC_APP_SHORT_NAME: shortName,
      ASF_PUBLIC_APP_NAME: name,
      ASF_PUBLIC_APP_SHORT_NAME: shortName,
      ASF_SOCIAL_CARD_PATH: socialCardPath,
    }),
  };

  if (dryRun) {
    console.log(`Public brand dry run: ${name} (${shortName}) at ${origin}`);
    console.log(`Would update: ${Object.keys(updates).join(', ')}`);
    console.log('PNG assets are not regenerated by this script; run npm run brand:rasterize before launch.');
    return;
  }

  const changed = [];
  for (const [path, text] of Object.entries(updates)) {
    writeIfChanged(path, text, changed);
  }
  console.log(`Applied public brand: ${name} (${shortName})`);
  console.log(changed.length > 0 ? `Updated: ${changed.join(', ')}` : 'No files changed.');
  console.log('Run npm run brand:rasterize to regenerate the PNG social card and app icons from their sources before launch.');
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
