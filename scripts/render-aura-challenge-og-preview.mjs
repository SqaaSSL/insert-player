// Local visual fixture using the exact deployed template, game artwork and fonts.
// Usage: node --experimental-strip-types scripts/render-aura-challenge-og-preview.mjs [output.png] [name] [score]
import { readFile, writeFile } from 'node:fs/promises';
import { render } from '../worker/node_modules/takumi-js/dist/index.mjs';
import { buildAuraChallengeOgDocument, AURA_CHALLENGE_OG_ART_URL, AURA_CHALLENGE_OG_WIDTH, AURA_CHALLENGE_OG_HEIGHT } from '../worker/src/auraChallengeOgTemplate.ts';

const output = process.argv[2] ?? '/tmp/insert-player-aura-challenge-og.png';
const name = process.argv[3] ?? 'Alex';
const score = Number(process.argv[4] ?? 12500);
if (!Number.isSafeInteger(score) || score < 0 || !name || Array.from(name).length > 32) throw new Error('Provide a name up to 32 characters and a nonnegative integer score.');
const fonts = await Promise.all([
  ['press-start-2p', 400, 'Press Start 2P'], ['space-grotesk', 400, 'Space Grotesk'], ['space-grotesk', 700, 'Space Grotesk'],
].map(async ([file, weight, family]) => {
  const bytes = await readFile(new URL(`../worker/node_modules/@fontsource/${file}/files/${file}-latin-${weight}-normal.woff2`, import.meta.url));
  return { name: family, weight, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}));
const document = buildAuraChallengeOgDocument({ name, score, difficulty: 'viral' });
const artwork = await readFile(new URL('../worker/src/assets/aura-six-seven-og-v2.png', import.meta.url));
const bytes = await render(document.node, { width: AURA_CHALLENGE_OG_WIDTH, height: AURA_CHALLENGE_OG_HEIGHT,
  format: 'png', fonts, stylesheets: [document.css], lang: 'en', emoji: 'from-font',
  images: { cache: 'auto', allowUrl: () => false, sources: [{ src: AURA_CHALLENGE_OG_ART_URL, data: artwork }] } });
await writeFile(output, bytes);
console.log(`${output} (${AURA_CHALLENGE_OG_WIDTH}×${AURA_CHALLENGE_OG_HEIGHT}, ${bytes.byteLength} bytes)`);
