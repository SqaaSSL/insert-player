import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createGunzip, createGzip } from 'node:zlib';
import { CASUAL_ANIMATIONS, CASUAL_IDENTITY } from './import-casual-roster.mjs';
import { CASUAL_SELECTIVE_REPAIR_ID, collectCasualSelectiveRepairFiles } from './casual-selective-repair-provenance.mjs';
import { CASUAL_AURA_GRID_RESCUE_ID, collectCasualAuraGridRescueFiles } from './casual-aura-grid-rescue-provenance.mjs';
import { CASUAL_KO_COMPLETION_ID, collectCasualKoCompletionFiles } from './casual-ko-completion-provenance.mjs';
import { CASUAL_POSTPROCESS_REPAIR_ID, collectCasualPostprocessRepairFiles } from './casual-postprocess-repair-provenance.mjs';

export const CASUAL_BUNDLE_ROOT = 'casual-roster-v1';
export const CASUAL_RELEASE_TAG = 'casual-generation-v1';
const SOURCE_SHA = 'e29f551726c5e80941bcf63618401bbf00429d56df52f6cbb20d8da57435c210';
const COMPOSITE_SHA = 'dea77fefdd241df860e823caf8c2cfc0ac3f466f2d0d50a1b2cb23cfd475e7dd';
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
// Exact raw/native histories for the two repaired Aura grids exceed the prior 256-file bound.
const MAX_FILES = 384;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const digestPattern = /^[a-f0-9]{64}$/;
const assetPattern = /^[a-z0-9][a-z0-9._-]{0,110}\.tar\.gz$/;
const IDLE_DERIVATIVE = 'casual-idle-closed-loop-v1';
const spriteFields = ['animationName', 'qualityTier', 'frameWidth', 'frameHeight', 'frameCount', 'processingVersion', 'path', 'sha256', 'bytes', 'mime', 'rawPath', 'rawSha256', 'rawBytes', 'rawWidth', 'rawHeight', 'rawMime', 'animationFormat', 'gridCols', 'gridRows', 'derivativeId', 'uniqueFrameCount'];

function safePath(value) {
  assert.ok(typeof value === 'string' && value.length <= 220 && value.split('/').every(part =>
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part) && part !== '.' && part !== '..'), 'Unsafe bundle path');
  assert.ok(!/(^|\/)(?:provider[^/]*|credentials?[^/]*|secrets?[^/]*|requests?[^/]*|responses?[^/]*|[^/]*ledger[^/]*|[^/]*debug[^/]*)(\/|$)/i.test(value), 'Provider traces or credentials are never packaged');
  return value;
}

function readLocalFile(root, path) {
  safePath(path);
  assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'Bundle input must be a real directory');
  let target = root;
  for (const part of path.split('/')) {
    target = join(target, part);
    assert.ok(!lstatSync(target).isSymbolicLink(), 'Bundle paths cannot contain symlinks');
  }
  const stat = lstatSync(target);
  assert.ok(stat.isFile() && stat.size > 0 && stat.size <= MAX_FILE_BYTES, 'Invalid bundle file size/type');
  return readFileSync(target);
}

function noCredentials(value) {
  if (typeof value === 'string') {
    assert.ok(!/(?:Bearer\s+[a-z0-9._-]{8,}|sk_(?:live|test)_[a-z0-9]+|sk-[a-z0-9_-]{16,}|-----BEGIN[^\n]*PRIVATE KEY)/i.test(value), 'Credential-like content refused');
  } else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      assert.ok(!/^(?:authorization|cookie|apiKey|api_key|secret|token|password|credentials|requestBody|responseBody|providerLedger|providerRequests|providerResponses|requestTraces)$/i.test(key), 'Credential or provider trace field refused');
      noCredentials(nested);
    }
  }
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

export function sealedCasualManifest(value) {
  assert.equal(value.schemaVersion, 1);
  assert.deepEqual(value.identity, CASUAL_IDENTITY);
  assert.ok(value.phaseStatus?.full === 'awaiting_visual_review' || value.phaseStatus?.full === 'approved', 'Full generation must be complete before packaging');
  assert.ok(Array.isArray(value.sources) && value.sources.length === 7, 'All seven shared source assets are required');
  assert.ok(Array.isArray(value.sprites) && value.sprites.length === 34, 'Both complete quality versions are required');
  assert.deepEqual(value.sources.map(source => source.kind).sort(), ['original', 'side', 'side_raw', 'upright', 'upright_raw', 'crouch', 'crouch_raw'].sort(), 'Missing or duplicate canonical sources');
  assert.deepEqual(value.sprites.map(sprite => `${sprite.qualityTier}:${sprite.animationName}`).sort(),
    ['rookie', 'contender'].flatMap(tier => CASUAL_ANIMATIONS.map(animation => `${tier}:${animation}`)).sort(), 'Missing or duplicate quality/animation pairs');
  const manifest = pick(value, ['schemaVersion', 'identity', 'fingerprint', 'productRevision', 'productFiles', 'phaseStatus', 'sourcePrompt', 'createdAt', 'updatedAt']);
  manifest.sources = value.sources.map(source => pick(source, ['kind', 'path', 'sha256', 'bytes', 'mime']));
  manifest.sprites = value.sprites.map(sprite => pick(sprite, spriteFields));
  if (value.derivatives !== undefined) {
    assert.ok(Array.isArray(value.derivatives) && value.derivatives.length >= 1 && value.derivatives.length <= 5, 'Only the five reviewed Casual derivative kinds are supported');
    assert.equal(new Set(value.derivatives.map(item => item.id)).size, value.derivatives.length, 'Duplicate derivative proof');
    assert.ok(value.derivatives.every(item => [IDLE_DERIVATIVE, CASUAL_SELECTIVE_REPAIR_ID, CASUAL_POSTPROCESS_REPAIR_ID, CASUAL_KO_COMPLETION_ID, CASUAL_AURA_GRID_RESCUE_ID].includes(item.id)), 'Unknown derivative proof');
    manifest.derivatives = value.derivatives.map(item => pick(item, ['id', 'path', 'sha256', 'bytes', 'mime']));
  }
  noCredentials(manifest);
  return manifest;
}

export function validateCasualDescriptor(value, { assetName, archiveSha256 } = {}) {
  assert.equal(value.schemaVersion, 1, 'Unsupported reviewed descriptor');
  assert.deepEqual(value.identity, CASUAL_IDENTITY);
  assert.equal(value.bundle?.releaseTag, CASUAL_RELEASE_TAG, 'Unexpected draft release tag');
  assert.ok(assetPattern.test(value.bundle.assetName), 'A simple tar.gz asset name is required');
  assert.ok(digestPattern.test(value.bundle.archiveSha256), 'An exact archive SHA-256 is required');
  assert.ok(digestPattern.test(value.bundle.manifestSha256), 'An exact reviewed manifest SHA-256 is required');
  if (assetName !== undefined) assert.equal(assetName, value.bundle.assetName, 'Dispatch asset differs from committed review');
  if (archiveSha256 !== undefined) assert.equal(archiveSha256, value.bundle.archiveSha256, 'Dispatch archive SHA differs from committed review');
  return value;
}

export async function fileSha256(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_TOTAL_BYTES, 'Archive must be a bounded regular file');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

function mediaFile(root, path, sha256, bytes) {
  assert.ok(digestPattern.test(sha256), 'Missing asset SHA-256');
  assert.ok(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= MAX_FILE_BYTES, 'Missing asset byte count');
  const data = readLocalFile(root, path);
  assert.equal(data.length, bytes, `Asset size mismatch: ${path}`);
  assert.equal(hash(data), sha256, `Asset SHA mismatch: ${path}`);
  const png = path.endsWith('.png') && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const webp = path.endsWith('.webp') && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  assert.ok(png || webp, 'Only referenced PNG/WebP media may enter the bundle');
  return data;
}

/** Preserve exact curator evidence; never follow debug/provider pointers in original metadata. */
export function casualDerivativeFiles(root, manifest) {
  const files = new Map();
  const derivedSprites = manifest.sprites.filter(sprite => sprite.derivativeId !== undefined);
  if (!manifest.derivatives?.length) {
    assert.equal(derivedSprites.length, 0, 'A derived sprite is missing its provenance');
    return files;
  }
  assert.ok(derivedSprites.every(sprite => manifest.derivatives.some(item => item.id === sprite.derivativeId)), 'Derived sprite has no known provenance');
  const checkedJson = entry => {
    assert.equal(entry.mime ?? 'application/json', 'application/json');
    assert.ok(digestPattern.test(entry.sha256) && Number.isSafeInteger(entry.bytes), 'Invalid derivative JSON descriptor');
    const bytes = readLocalFile(root, entry.path);
    assert.equal(bytes.length, entry.bytes, 'Derivative evidence size mismatch');
    assert.equal(hash(bytes), entry.sha256, 'Derivative evidence SHA mismatch');
    const value = JSON.parse(bytes); noCredentials(value); files.set(entry.path, bytes); return value;
  };
  const includeMedia = entry => { const bytes = mediaFile(root, entry.path, entry.sha256, entry.bytes); files.set(entry.path, bytes); return bytes; };
  const grid = manifest.derivatives.find(item => item.id === CASUAL_AURA_GRID_RESCUE_ID);
  const rescued = grid ? collectCasualAuraGridRescueFiles({ manifest, derivative: grid, checkedJson, spriteFields, pick, includeMedia }) : undefined;
  // The other independently reviewed derivatives compare against the original Aura entries.
  const beforeGrid = rescued ? { ...manifest, sprites: manifest.sprites.flatMap(sprite => {
    if (sprite.derivativeId !== CASUAL_AURA_GRID_RESCUE_ID) return [sprite];
    const group = rescued.groups.find(item => item.animationName === sprite.animationName);
    const original = sprite.qualityTier === 'rookie' ? group.originalRookie : group.originalChampion;
    return original ? [pick(original, spriteFields)] : [];
  }) } : manifest;
  const ko = manifest.derivatives.find(item => item.id === CASUAL_KO_COMPLETION_ID);
  if (ko) collectCasualKoCompletionFiles({ manifest, derivative: ko, checkedJson, spriteFields, pick, includeMedia });
  const postprocess = manifest.derivatives.find(item => item.id === CASUAL_POSTPROCESS_REPAIR_ID);
  const corrected = postprocess ? collectCasualPostprocessRepairFiles({ manifest, derivative: postprocess, checkedJson, spriteFields, pick, includeMedia }) : undefined;
  // Validate the independent raw-preserving Rookie correction first, then compare the selective repair against that exact prior Rookie.
  const selectiveView = corrected ? { ...beforeGrid, sprites: beforeGrid.sprites.map(sprite => sprite.derivativeId === CASUAL_POSTPROCESS_REPAIR_ID ? pick(corrected.originalEntry, spriteFields) : sprite) } : beforeGrid;
  const selective = manifest.derivatives.find(item => item.id === CASUAL_SELECTIVE_REPAIR_ID);
  if (selective) collectCasualSelectiveRepairFiles({ manifest: selectiveView, derivative: selective, checkedJson, spriteFields, pick, includeMedia });
  const derivative = manifest.derivatives.find(item => item.id === IDLE_DERIVATIVE);
  if (!derivative) return files;
  const base = `derivatives/${IDLE_DERIVATIVE}`;
  assert.equal(derivative.path, `${base}/provenance.json`);
  const proof = checkedJson(derivative);
  assert.equal(proof.schemaVersion, 1); assert.equal(proof.id, IDLE_DERIVATIVE);
  assert.deepEqual(proof.identity, manifest.identity);
  assert.ok(digestPattern.test(proof.productFingerprint), 'Invalid derivative product fingerprint');
  assert.deepEqual(proof.frameOrderOneBased, [2, 3, 4, 5, 6, 7, 8, 2], 'Unexpected authored idle frame order');
  assert.equal(proof.uniqueFrameCount, 7); assert.equal(proof.playbackFrameCount, 8);
  assert.deepEqual(proof.closingHold, { playbackFrame: 8, repeatsSourceFrame: 2, matchesPlaybackFrame: 1 });
  assert.equal(proof.noImageGeneration, true); assert.equal(proof.noRetouchingOrEnhancement, true); assert.equal(proof.paidCalls, 0);
  assert.equal(proof.originalManifest.path, `${base}/original-manifest.json`);
  const original = checkedJson(proof.originalManifest);
  assert.equal(original.schemaVersion, 1); assert.deepEqual(original.identity, manifest.identity);
  assert.equal(original.fingerprint, proof.productFingerprint, 'Derivative fingerprint differs from preserved original manifest');
  assert.deepEqual(proof.pairs.map(pair => pair.qualityTier).sort(), ['contender', 'rookie']);
  assert.equal(derivedSprites.filter(sprite => sprite.derivativeId === IDLE_DERIVATIVE).length, 2, 'Idle curation must preserve the paired quality comparison');
  for (const pair of proof.pairs) {
    const current = derivedSprites.find(sprite => sprite.qualityTier === pair.qualityTier && sprite.derivativeId === IDLE_DERIVATIVE);
    assert.ok(current); assert.equal(current.animationName, 'idle');
    assert.equal(current.derivativeId, IDLE_DERIVATIVE); assert.equal(current.uniqueFrameCount, 7);
    assert.equal(current.frameCount, 8); assert.equal(current.gridCols, 4); assert.equal(current.gridRows, 2);
    assert.deepEqual(pick(pair.outputEntry, spriteFields), current, 'Derivative output differs from current manifest');
    const originals = original.sprites.filter(sprite => sprite.animationName === 'idle' && sprite.qualityTier === pair.qualityTier);
    assert.equal(originals.length, 1); assert.deepEqual(pick(pair.originalEntry, spriteFields), pick(originals[0], spriteFields), 'Derivative original differs from preserved manifest');
    assert.equal(pair.originalEntry.derivativeId, undefined);
    assert.equal(pair.originalEntry.frameCount, 8); assert.equal(pair.originalEntry.gridCols, 4); assert.equal(pair.originalEntry.gridRows, 2);
    for (const entry of [pair.originalEntry, current]) {
      files.set(entry.path, mediaFile(root, entry.path, entry.sha256, entry.bytes));
      files.set(entry.rawPath, mediaFile(root, entry.rawPath, entry.rawSha256, entry.rawBytes));
    }
    for (const [kind, sourceWidth, sourceHeight, width, height] of [
      ['processedGeometry', pair.originalEntry.frameWidth * 4, pair.originalEntry.frameHeight * 2, current.frameWidth * 4, current.frameHeight * 2],
      ['rawGeometry', pair.originalEntry.rawWidth, pair.originalEntry.rawHeight, current.rawWidth, current.rawHeight],
    ]) {
      const geometry = pair[kind];
      assert.ok(geometry, 'Missing derivative native geometry');
      assert.equal(geometry.sourceWidth, sourceWidth); assert.equal(geometry.sourceHeight, sourceHeight);
      assert.equal(geometry.width, width); assert.equal(geometry.height, height);
      assert.equal(geometry.columns, 4); assert.equal(geometry.rows, 2);
      assert.equal(geometry.cellWidth * 4, width); assert.equal(geometry.cellHeight * 2, height);
    }
  }
  return files;
}

export async function packageCasualRoster({ manifestPath, outputDirectory, assetName = 'casual-roster-v1.tar.gz' }) {
  assert.ok(assetPattern.test(assetName), 'A simple tar.gz asset name is required');
  const inputRoot = dirname(resolve(manifestPath));
  const originalManifest = readLocalFile(inputRoot, 'manifest.json');
  assert.equal(resolve(manifestPath), join(inputRoot, 'manifest.json'), 'Input must be named manifest.json');
  const manifest = sealedCasualManifest(JSON.parse(originalManifest));
  const files = new Map();
  const include = (path, data) => {
    safePath(path);
    if (files.has(path)) assert.ok(files.get(path).equals(data), 'Conflicting asset references');
    files.set(path, data);
  };
  for (const source of manifest.sources) include(source.path, mediaFile(inputRoot, source.path, source.sha256, source.bytes));
  for (const sprite of manifest.sprites) {
    include(sprite.path, mediaFile(inputRoot, sprite.path, sprite.sha256, sprite.bytes));
    include(sprite.rawPath, mediaFile(inputRoot, sprite.rawPath, sprite.rawSha256, sprite.rawBytes));
  }
  for (const [path, bytes] of casualDerivativeFiles(inputRoot, manifest)) include(path, bytes);
  const compositePath = 'inputs/casual-approved-marketing-composite.webp';
  const composite = readLocalFile(inputRoot, compositePath);
  assert.equal(hash(composite), COMPOSITE_SHA, 'Approved marketing reference changed');
  include(compositePath, composite);
  // Retain the exact photo referenced by the provenance beside the import original.
  const publishedPhotoPath = 'inputs/casual-published-source-photo.webp';
  const publishedPhoto = readLocalFile(inputRoot, publishedPhotoPath);
  assert.equal(hash(publishedPhoto), SOURCE_SHA, 'Published source reference changed');
  include(publishedPhotoPath, publishedPhoto);
  const provenancePath = 'inputs/source-provenance.json';
  const provenance = readLocalFile(inputRoot, provenancePath);
  noCredentials(JSON.parse(provenance));
  include(provenancePath, provenance);
  include('manifest.json', jsonBytes(manifest));
  const manifestSha256 = hash(files.get('manifest.json'));
  const seal = { schemaVersion: 1, root: CASUAL_BUNDLE_ROOT, identity: manifest.identity, manifestSha256,
    generatorManifestSha256: hash(originalManifest),
    preservation: 'Both quality versions and all listed originals are retained; provider traces and credentials are excluded.',
    files: [...files.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([path, data]) => ({ path, sha256: hash(data), bytes: data.length })) };
  include('bundle-seal.json', jsonBytes(seal));
  assert.ok(files.size <= MAX_FILES && [...files.values()].reduce((sum, data) => sum + data.length, 0) <= MAX_TOTAL_BYTES, 'Bundle exceeds size limits');
  const output = resolve(outputDirectory);
  assert.ok(!existsSync(output), 'Output directory must not exist; preserve previous packages');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const bundleRoot = join(output, CASUAL_BUNDLE_ROOT);
  for (const [path, data] of files) {
    const target = join(bundleRoot, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, data, { flag: 'wx', mode: 0o600 });
    utimesSync(target, 0, 0);
  }
  // Explicit files only. USTAR excludes PAX metadata and filesystem discovery.
  const tarPath = join(output, 'casual-roster-v1.tar');
  const tarVersion = execFileSync('tar', ['--version'], { encoding: 'utf8' });
  const ownerArgs = tarVersion.includes('bsdtar')
    ? ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root']
    : ['--owner=root:0', '--group=root:0', '--mtime=@0'];
  const names = [...files.keys()].sort().map(path => `${CASUAL_BUNDLE_ROOT}/${path}`);
  execFileSync('tar', ['--format=ustar', ...ownerArgs, '-cf', tarPath, '-C', output, ...names], {
    env: { ...process.env, COPYFILE_DISABLE: '1', TZ: 'UTC', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const archivePath = join(output, assetName);
  await pipeline(createReadStream(tarPath), createGzip({ level: 9 }), createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }));
  await inspectCasualArchive(archivePath);
  const descriptor = { schemaVersion: 1, identity: manifest.identity,
    bundle: { releaseTag: CASUAL_RELEASE_TAG, assetName, archiveSha256: await fileSha256(archivePath), manifestSha256 } };
  writeFileSync(join(output, 'casual-generated-v1.json'), jsonBytes(descriptor), { flag: 'wx', mode: 0o600 });
  return { archivePath, descriptorPath: join(output, 'casual-generated-v1.json'), ...descriptor };
}

function octal(bytes) {
  const text = bytes.toString('ascii').replace(/\0.*$/, '').trim();
  assert.ok(/^[0-7]+$/.test(text), 'Non-octal tar size/checksum refused');
  const result = Number.parseInt(text, 8);
  assert.ok(Number.isSafeInteger(result), 'Unsafe tar integer');
  return result;
}

export async function inspectCasualArchive(archivePath) {
  assert.ok(lstatSync(archivePath).isFile() && !lstatSync(archivePath).isSymbolicLink(), 'Archive must be a regular file');
  assert.ok(lstatSync(archivePath).size <= MAX_TOTAL_BYTES, 'Compressed archive is too large');
  let pending = Buffer.alloc(0); let skip = 0; let zeros = 0; let total = 0; let unpacked = 0;
  const entries = new Map();
  const input = createReadStream(archivePath); const unzip = createGunzip();
  input.on('error', error => unzip.destroy(error)); input.pipe(unzip);
  try {
    for await (const chunk of unzip) {
      unpacked += chunk.length;
      assert.ok(unpacked <= MAX_TOTAL_BYTES + MAX_FILES * 2048, 'Expanded archive exceeds size limit');
      pending = Buffer.concat([pending, chunk]);
      while (pending.length) {
        if (skip) { const amount = Math.min(skip, pending.length); skip -= amount; pending = pending.subarray(amount); continue; }
        if (pending.length < 512) break;
        const header = pending.subarray(0, 512); pending = pending.subarray(512);
        if (header.every(byte => byte === 0)) { zeros += 1; continue; }
        assert.equal(zeros, 0, 'Nonzero content after tar end marker');
        const expected = octal(header.subarray(148, 156));
        const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
        assert.equal(expected, actual, 'Invalid tar header checksum');
        assert.equal(header.toString('ascii', 257, 263), 'ustar\0', 'Only sealed USTAR archives are accepted');
        const name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
        const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/s, '');
        const path = (prefix ? `${prefix}/${name}` : name).replace(/\/$/, '');
        safePath(path);
        assert.ok(path.startsWith(`${CASUAL_BUNDLE_ROOT}/`), 'Archive entry is outside the fixed root');
        assert.ok(!entries.has(path), 'Duplicate archive entry refused');
        assert.ok(header[156] === 48 || header[156] === 0, 'Links, directories, metadata and special tar entries are refused');
        assert.ok(header.subarray(157, 257).every(byte => byte === 0), 'Tar link targets are refused');
        const size = octal(header.subarray(124, 136)); total += size;
        assert.ok(size > 0 && size <= MAX_FILE_BYTES && total <= MAX_TOTAL_BYTES && entries.size < MAX_FILES, 'Archive file count or size limit exceeded');
        entries.set(path, size); skip = Math.ceil(size / 512) * 512;
      }
    }
    assert.ok(skip === 0 && pending.length === 0 && zeros >= 2, 'Truncated archive or missing tar end marker');
    assert.ok(entries.has(`${CASUAL_BUNDLE_ROOT}/manifest.json`) && entries.has(`${CASUAL_BUNDLE_ROOT}/bundle-seal.json`), 'Bundle manifest/seal are missing');
    return entries;
  } finally { input.destroy(); unzip.destroy(); }
}

export async function extractCasualRoster({ archivePath, descriptorPath, outputDirectory, assetName, archiveSha256 }) {
  const descriptor = validateCasualDescriptor(JSON.parse(readFileSync(descriptorPath, 'utf8')), { assetName, archiveSha256 });
  assert.equal(await fileSha256(archivePath), descriptor.bundle.archiveSha256, 'Downloaded archive SHA mismatch');
  const entries = await inspectCasualArchive(archivePath);
  const output = resolve(outputDirectory);
  assert.ok(!existsSync(output), 'Extraction destination must be new');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  execFileSync('tar', ['-xzf', resolve(archivePath), '-C', output, '--no-same-owner', '--no-same-permissions'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const root = join(output, CASUAL_BUNDLE_ROOT);
  const manifest = readLocalFile(root, 'manifest.json');
  assert.equal(hash(manifest), descriptor.bundle.manifestSha256, 'Contained manifest differs from committed review');
  const seal = JSON.parse(readLocalFile(root, 'bundle-seal.json'));
  assert.equal(seal.schemaVersion, 1); assert.equal(seal.root, CASUAL_BUNDLE_ROOT);
  assert.equal(seal.manifestSha256, descriptor.bundle.manifestSha256);
  assert.deepEqual(seal.identity, descriptor.identity);
  assert.ok(Array.isArray(seal.files) && seal.files.length === entries.size - 1, 'Archive has unsealed extra/missing files');
  const seen = new Set();
  for (const file of seal.files) {
    safePath(file.path); assert.ok(!seen.has(file.path), 'Duplicate seal path'); seen.add(file.path);
    assert.ok(entries.has(`${CASUAL_BUNDLE_ROOT}/${file.path}`), 'Seal references missing file');
    const bytes = readLocalFile(root, file.path);
    assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256, 'Sealed asset mismatch');
  }
  assert.ok(seen.has('manifest.json') && !seen.has('bundle-seal.json'), 'Invalid seal membership');
  const allowed = sealedCasualManifest(JSON.parse(manifest));
  assert.deepEqual(JSON.parse(manifest), allowed, 'Unexpected manifest fields in sealed bundle');
  const expected = new Set(['manifest.json', 'inputs/casual-approved-marketing-composite.webp', 'inputs/casual-published-source-photo.webp', 'inputs/source-provenance.json']);
  for (const source of allowed.sources) expected.add(source.path);
  for (const sprite of allowed.sprites) { expected.add(sprite.path); expected.add(sprite.rawPath); }
  for (const path of casualDerivativeFiles(root, allowed).keys()) expected.add(path);
  assert.deepEqual([...seen].sort(), [...expected].sort(), 'Bundle contains unrelated files');
  assert.equal(hash(readLocalFile(root, 'inputs/casual-approved-marketing-composite.webp')), COMPOSITE_SHA);
  assert.equal(hash(readLocalFile(root, 'inputs/casual-published-source-photo.webp')), SOURCE_SHA);
  noCredentials(JSON.parse(readLocalFile(root, 'inputs/source-provenance.json')));
  return { manifestPath: join(root, 'manifest.json'), manifestSha256: descriptor.bundle.manifestSha256, files: seen.size };
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) {
  const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  try {
    let result;
    if (arg('verify-descriptor')) result = validateCasualDescriptor(JSON.parse(readFileSync(arg('verify-descriptor'), 'utf8')), { assetName: arg('asset'), archiveSha256: arg('archive-sha256') });
    else if (arg('extract')) result = await extractCasualRoster({ archivePath: arg('extract'), descriptorPath: arg('descriptor'), outputDirectory: arg('out'), assetName: arg('asset'), archiveSha256: arg('archive-sha256') });
    else result = await packageCasualRoster({ manifestPath: arg('manifest'), outputDirectory: arg('out'), assetName: arg('asset') });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
