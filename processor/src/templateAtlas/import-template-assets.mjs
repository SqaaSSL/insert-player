// One-time offline vendor operation. Copies only generic Template Zero pixels;
// identity references, generated players, API receipts and local paths are excluded.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceManifestSha256 = '25ca63a37e9af0dc09bd9ad097a42369894ebf3eb29be26aabd526eaebdf838d';
const templateSourceSha256 = '36614af09625e1b0f3911e1e4fce73eedf8d8109b0db9abd7fd1d218b04528a4';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(process.argv.length, 3, 'Usage: node import-template-assets.mjs /absolute/path/to/frozen/inputs/manifest.json');
const sourceBytes = readFileSync(resolve(process.argv[2]));
assert.equal(sha(sourceBytes), sourceManifestSha256);
const source = JSON.parse(sourceBytes);
assert.equal(source.sources.templateManifest.sha256, templateSourceSha256);
assert.equal(source.masters.length, 131);
assert.equal(source.animations.length, 20);
const assets = join(dirname(fileURLToPath(import.meta.url)), 'assets');
function copy(ref, relative) {
  const bytes = readFileSync(ref.path);
  assert.equal(sha(bytes), ref.sha256);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(16), ref.width); assert.equal(bytes.readUInt32BE(20), ref.height);
  const target = join(assets, relative);
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) assert.equal(sha(readFileSync(target)), ref.sha256);
  else copyFileSync(ref.path, target);
  return { file: relative, sha256: ref.sha256, width: ref.width, height: ref.height };
}
const masters = source.masters.map(master => ({ id: master.id, order: master.order, ...copy(master.sourceRGBA, `masters/${master.id}.png`) }));
const animations = source.animations.map(animation => ({
  name: animation.name, family: animation.family, fps: animation.fps, loop: animation.loop,
  sequence: animation.sequence, authoredSequence: animation.authoredSequence,
  sourceReviewStatus: animation.sourceReviewStatus,
}));
const rookiePacks = source.packs.filter(pack => pack.variant === 'two').map(pack => ({
  id: pack.id, grid: pack.grid, cells: pack.cells, blankCells: pack.blankCells,
  image: copy(pack.image, `rookie/${pack.id}.png`),
}));
const manifest = { schemaVersion: 1, version: 'template-zero-v3', sourceManifestSha256, templateSourceSha256,
  canonical: { width: 1536, height: 2048, groundY: 1884 },
  counts: { masters: 131, animations: 20, playbackFrames: 184 },
  identityAssetsIncluded: false, masters, animations, rookiePacks };
const serialized = JSON.stringify(manifest, null, 2) + '\n';
assert.ok(!serialized.includes('/Users/') && !serialized.includes('upright-white') && !serialized.includes('francisco'), 'Private identity/path leaked into template manifest');
const output = join(assets, 'manifest.json');
if (existsSync(output)) assert.equal(readFileSync(output, 'utf8'), serialized);
else writeFileSync(output, serialized, { flag: 'wx' });
console.log(JSON.stringify({ manifestSha256: sha(serialized), masters: masters.length, rookiePacks: rookiePacks.length, identityAssetsIncluded: false }));
