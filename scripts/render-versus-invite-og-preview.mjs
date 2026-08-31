import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { render } from '../worker/node_modules/takumi-js/dist/index.mjs';
import {
  buildVersusInviteOgDocument,
  VERSUS_INVITE_FIGHTER_ASSET_URL,
  VERSUS_INVITE_OG_HEIGHT,
  VERSUS_INVITE_OG_WIDTH,
} from '../worker/src/versusInviteOgTemplate.ts';

function localPath(relative) {
  return fileURLToPath(new URL(relative, import.meta.url));
}

function exactArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

const fighterPath = process.argv[2] ?? localPath('../public/assets/landing-panel-fighter-c2d0a569.webp');
const outputPath = process.argv[3] ?? '/tmp/insert-player-versus-loading-challenge-v4.png';
const [fighter, pressStart, spaceRegular, spaceBold] = await Promise.all([
  readFile(fighterPath),
  readFile(localPath('../worker/node_modules/@fontsource/press-start-2p/files/press-start-2p-latin-400-normal.woff2')),
  readFile(localPath('../worker/node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff2')),
  readFile(localPath('../worker/node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2')),
]);
const document = buildVersusInviteOgDocument({
  inviterName: 'Francisco Novella Fletcher',
  fighterName: 'Rosalía',
  qualityTier: 'champion',
});
const bytes = await render(document.html.replace(/>\s+</g, '><').trim(), {
  width: VERSUS_INVITE_OG_WIDTH,
  height: VERSUS_INVITE_OG_HEIGHT,
  format: 'png',
  fonts: [
    { name: 'Press Start 2P', data: exactArrayBuffer(pressStart), weight: 400 },
    { name: 'Space Grotesk', data: exactArrayBuffer(spaceRegular), weight: 400 },
    { name: 'Space Grotesk', data: exactArrayBuffer(spaceBold), weight: 700 },
  ],
  images: {
    cache: 'auto',
    sources: [{ src: VERSUS_INVITE_FIGHTER_ASSET_URL, data: exactArrayBuffer(fighter) }],
  },
  stylesheets: [document.css],
  lang: 'en',
});
await writeFile(outputPath, bytes);
console.log(outputPath);
