import { build } from 'esbuild';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
await build({ entryPoints: [join(root, 'src/server.ts')], bundle: true,
  platform: 'node', format: 'esm', target: 'node22', outfile: join(root, 'dist/server.mjs'),
  external: ['@napi-rs/canvas'], banner: { js: "import { createRequire as __templateCreateRequire } from 'node:module'; const require = __templateCreateRequire(import.meta.url);" } });
const source = join(root, 'src/templateAtlas/assets');
const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
for (const asset of [...manifest.masters, ...manifest.rookiePacks.map(pack => pack.image)]) {
  const bytes = await readFile(join(source, asset.file));
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`Template asset hash mismatch: ${asset.file}`);
}
await mkdir(join(root, 'dist'), { recursive: true });
await cp(source, join(root, 'dist/templateAtlas-assets'), { recursive: true, force: true });
console.log(`Processor bundle includes ${manifest.masters.length} private generic pose masters and two Rookie atlases.`);
