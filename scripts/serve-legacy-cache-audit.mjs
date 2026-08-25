import { createServer } from 'node:http';
import {
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const DB_NAME = 'ai-street-fighter';
const DEFAULT_PORT = 5173;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_OUTPUT_DIR = join(root, '.local', 'legacy-cache-rescue');
const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Insert Player local cache audit</title>
  </head>
  <body>
    <main>
      <h1>Insert Player local cache audit</h1>
      <p id="status">Reading this origin without changing the database...</p>
      <p id="database"></p>
      <p id="export-status"></p>
      <section id="candidates" aria-label="Cached fighter candidates"></section>
      <details>
        <summary>Machine-readable inventory</summary>
        <pre id="inventory"></pre>
      </details>
    </main>
    <script src="/audit.js"></script>
  </body>
</html>`;

const auditScript = String.raw`
const DATABASE_NAME = ${JSON.stringify(DB_NAME)};
const ANIMATIONS = [
  'idle', 'walk', 'high_punch', 'low_punch', 'high_kick', 'low_kick',
  'jump', 'crouch', 'hit', 'ko', 'victory',
];
const TIER_SCORE = { rookie: 1, contender: 2, champion: 3 };

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function openExistingDatabase() {
  if (typeof indexedDB.databases !== 'function') {
    throw new Error('This browser cannot list IndexedDB databases without risking a write.');
  }
  const databases = await indexedDB.databases();
  const existing = databases.find((database) => database.name === DATABASE_NAME);
  if (!existing) return null;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME);
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      reject(new Error('The database changed during the read-only audit.'));
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Another tab is blocking the read-only audit.'));
  });
}

async function readStore(database, storeName) {
  if (!database.objectStoreNames.contains(storeName)) return [];
  const transaction = database.transaction(storeName, 'readonly');
  const records = await requestResult(transaction.objectStore(storeName).getAll());
  await transactionDone(transaction);
  return records;
}

function tierFor(meta, sprites) {
  const tiers = [meta?.qualityTier, ...sprites.map((sprite) => sprite?.qualityTier)]
    .filter((tier) => Object.hasOwn(TIER_SCORE, tier));
  return tiers.sort((left, right) => TIER_SCORE[right] - TIER_SCORE[left])[0] ?? 'champion';
}

function blobSummary(value) {
  return value instanceof Blob ? { type: value.type || null, size: value.size } : null;
}

function safePathPart(value) {
  return String(value || 'item').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function extensionForBlob(blob) {
  if (blob.type === 'image/png') return 'png';
  if (blob.type === 'image/jpeg') return 'jpg';
  if (blob.type === 'image/webp') return 'webp';
  if (blob.type === 'video/mp4') return 'mp4';
  if (blob.type === 'application/json') return 'json';
  return 'bin';
}

function splitBlobs(value, basePath, files) {
  if (value instanceof Blob) {
    const path = basePath + '.' + extensionForBlob(value);
    files.push({ path, blob: value });
    return { $blob: path, type: value.type || null, size: value.size };
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => splitBlobs(item, basePath + '/' + String(index).padStart(3, '0'), files));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      splitBlobs(item, basePath + '/' + safePathPart(key), files),
    ]));
  }
  return value;
}

function writeTarString(buffer, offset, length, value) {
  const bytes = new TextEncoder().encode(String(value));
  buffer.set(bytes.subarray(0, length), offset);
}

function writeTarOctal(buffer, offset, length, value) {
  const encoded = Math.max(0, Number(value)).toString(8).padStart(length - 1, '0') + '\0';
  writeTarString(buffer, offset, length, encoded);
}

function tarHeader(path, size, modifiedAt = Date.now()) {
  if (new TextEncoder().encode(path).byteLength > 100) throw new Error('TAR path is too long: ' + path);
  const header = new Uint8Array(512);
  writeTarString(header, 0, 100, path);
  writeTarOctal(header, 100, 8, 0o600);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, Math.floor(modifiedAt / 1000));
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeTarString(header, 257, 6, 'ustar\0');
  writeTarString(header, 263, 2, '00');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, '0') + '\0 ';
  writeTarString(header, 148, 8, checksumText);
  return header;
}

function buildTarBlob(files) {
  const parts = [];
  for (const file of files) {
    parts.push(tarHeader(file.path, file.blob.size, file.modifiedAt));
    parts.push(file.blob);
    const padding = (512 - (file.blob.size % 512)) % 512;
    if (padding) parts.push(new Uint8Array(padding));
  }
  parts.push(new Uint8Array(1024));
  return new Blob(parts, { type: 'application/x-tar' });
}

function buildFighterArchive(origin, databaseVersion, meta, sprites, intro) {
  const files = [];
  const serializedMeta = splitBlobs(meta, 'blobs/meta', files);
  const serializedSprites = sprites.map((sprite, index) => splitBlobs(
    sprite,
    'blobs/sprites/' + String(index).padStart(3, '0'),
    files,
  ));
  const serializedIntro = intro ? splitBlobs(intro, 'blobs/intro', files) : null;
  const manifest = {
    schemaVersion: 1,
    exportKind: 'insert-player-indexeddb-fighter',
    origin,
    databaseName: DATABASE_NAME,
    databaseVersion,
    exportedAt: new Date().toISOString(),
    photoHash: meta.photoHash,
    characterName: meta.characterName || 'Unnamed fighter',
    meta: serializedMeta,
    sprites: serializedSprites,
    intro: serializedIntro,
  };
  files.unshift({
    path: 'manifest.json',
    blob: new Blob([JSON.stringify(manifest, null, 2) + '\n'], { type: 'application/json' }),
  });
  return buildTarBlob(files);
}

function sourceSummary(meta) {
  const fields = [
    'originalPhotoBlob', 'sideViewBlob', 'sideViewRawBlob', 'sideViewCleanBlob',
    'uprightViewBlob', 'uprightViewRawBlob', 'crouchViewBlob', 'crouchViewRawBlob',
    'crouchViewCleanBlob', 'noBgBlob',
  ];
  return Object.fromEntries(fields.map((field) => [field, blobSummary(meta?.[field])]));
}

function bestPreview(meta) {
  return meta?.sideViewCleanBlob
    ?? meta?.sideViewBlob
    ?? meta?.uprightViewBlob
    ?? meta?.crouchViewCleanBlob
    ?? meta?.crouchViewBlob
    ?? meta?.noBgBlob
    ?? meta?.originalPhotoBlob
    ?? null;
}

function buildInventory(metas, sprites) {
  const metasByHash = new Map(metas.map((meta) => [meta.photoHash, meta]));
  const hashes = new Set([
    ...metas.map((meta) => meta.photoHash),
    ...sprites.map((sprite) => sprite.photoHash),
  ].filter(Boolean));
  return [...hashes].map((photoHash) => {
    const meta = metasByHash.get(photoHash) ?? {};
    const fighterSprites = sprites.filter((sprite) => sprite.photoHash === photoHash);
    const animationNames = [...new Set(fighterSprites.map((sprite) => sprite.animationName).filter(Boolean))];
    const tier = tierFor(meta, fighterSprites);
    const sources = sourceSummary(meta);
    const sourceCount = Object.values(sources).filter(Boolean).length;
    const score = (TIER_SCORE[tier] * 1000)
      + (ANIMATIONS.filter((animation) => animationNames.includes(animation)).length * 50)
      + (sourceCount * 5)
      + (meta.status === 'ready' ? 25 : 0);
    return {
      photoHash,
      characterName: meta.characterName || 'Unnamed fighter',
      ownerScope: meta.ownerScope || 'legacy-unscoped',
      qualityTier: tier,
      status: meta.status || 'unknown',
      cloudFighterId: meta.cloudFighterId || null,
      animations: animationNames.sort(),
      playableAnimationCount: ANIMATIONS.filter((animation) => animationNames.includes(animation)).length,
      spriteVersionCount: fighterSprites.length,
      spriteTiers: [...new Set(fighterSprites.map((sprite) => sprite.qualityTier).filter(Boolean))].sort(),
      sources,
      sourceCount,
      failedAnimations: Object.keys(meta.failedAnimationArtifacts || {}).sort(),
      createdAt: Number.isFinite(meta.createdAt) ? new Date(meta.createdAt).toISOString() : null,
      updatedAt: Number.isFinite(meta.updatedAt) ? new Date(meta.updatedAt).toISOString() : null,
      score,
      preview: bestPreview(meta),
    };
  }).sort((left, right) => right.score - left.score || right.spriteVersionCount - left.spriteVersionCount);
}

function renderCandidate(candidate, rank, databaseVersion, meta, sprites, intro) {
  const article = document.createElement('article');
  article.dataset.photoHash = candidate.photoHash;
  article.dataset.qualityTier = candidate.qualityTier;
  article.dataset.rank = String(rank);
  const heading = document.createElement('h2');
  heading.textContent = String(rank) + '. ' + candidate.characterName;
  article.append(heading);
  const summary = document.createElement('p');
  summary.textContent = candidate.qualityTier.toUpperCase()
    + ' | ' + candidate.playableAnimationCount + '/11 playable animations'
    + ' | ' + candidate.spriteVersionCount + ' preserved sprite versions'
    + ' | ' + candidate.sourceCount + ' source blobs'
    + ' | ' + candidate.status;
  article.append(summary);
  const identity = document.createElement('p');
  identity.textContent = 'Scope: ' + candidate.ownerScope + ' | Hash: ' + candidate.photoHash;
  article.append(identity);
  if (candidate.preview instanceof Blob) {
    const image = document.createElement('img');
    image.alt = candidate.characterName + ' cached preview';
    image.src = URL.createObjectURL(candidate.preview);
    image.width = 280;
    article.append(image);
  }
  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.textContent = 'Export every preserved version';
  exportButton.addEventListener('click', async () => {
    exportButton.disabled = true;
    const exportStatus = document.querySelector('#export-status');
    exportStatus.textContent = 'Building lossless local archive for ' + candidate.characterName + '...';
    try {
      const archive = buildFighterArchive(location.origin, databaseVersion, meta, sprites, intro);
      const exportedAt = new Date().toISOString().replace(/[-:.TZ]/g, '');
      const filename = safePathPart(location.hostname) + '--'
        + safePathPart(candidate.characterName) + '--' + candidate.photoHash.slice(0, 16)
        + '--' + exportedAt + '.tar';
      const response = await fetch('/export?filename=' + encodeURIComponent(filename), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-tar' },
        body: archive,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || ('HTTP ' + response.status));
      exportStatus.textContent = 'Exported ' + candidate.characterName + ' to ' + result.path
        + ' (' + result.sizeBytes + ' bytes).';
      article.dataset.exportPath = result.path;
      article.dataset.exportStatus = 'complete';
    } catch (error) {
      exportStatus.textContent = 'Export failed for ' + candidate.characterName + ': '
        + (error?.message || String(error));
      article.dataset.exportStatus = 'failed';
      exportButton.disabled = false;
    }
  });
  article.append(exportButton);
  document.querySelector('#candidates').append(article);
}

async function audit() {
  const status = document.querySelector('#status');
  const databaseInfo = document.querySelector('#database');
  const database = await openExistingDatabase();
  if (!database) {
    status.textContent = 'No ai-street-fighter IndexedDB database exists for ' + location.origin + '.';
    databaseInfo.textContent = 'Nothing was created or changed.';
    document.documentElement.dataset.auditStatus = 'empty';
    return;
  }
  try {
    const stores = [...database.objectStoreNames];
    const [metas, sprites, intros] = await Promise.all([
      readStore(database, 'meta'),
      readStore(database, 'sprites'),
      readStore(database, 'intros'),
    ]);
    const candidates = buildInventory(metas, sprites);
    databaseInfo.textContent = 'Origin: ' + location.origin
      + ' | Database version: ' + database.version
      + ' | Stores: ' + stores.join(', ')
      + ' | Meta records: ' + metas.length
      + ' | Sprite records: ' + sprites.length;
    for (const [index, candidate] of candidates.entries()) {
      const meta = metas.find((record) => record.photoHash === candidate.photoHash) ?? { photoHash: candidate.photoHash };
      const fighterSprites = sprites.filter((record) => record.photoHash === candidate.photoHash);
      const intro = intros.find((record) => record.photoHash === candidate.photoHash) ?? null;
      renderCandidate(candidate, index + 1, database.version, meta, fighterSprites, intro);
    }
    const serializable = candidates.map(({ preview, ...candidate }) => candidate);
    document.querySelector('#inventory').textContent = JSON.stringify({
      schemaVersion: 1,
      origin: location.origin,
      databaseVersion: database.version,
      stores,
      candidateCount: candidates.length,
      candidates: serializable,
    }, null, 2);
    status.textContent = candidates.length
      ? 'Read-only audit complete. No IndexedDB records were changed.'
      : 'The database exists but contains no fighter candidates.';
    document.documentElement.dataset.auditStatus = 'complete';
    document.documentElement.dataset.candidateCount = String(candidates.length);
  } finally {
    database.close();
  }
}

audit().catch((error) => {
  document.querySelector('#status').textContent = 'Audit failed: ' + (error?.message || String(error));
  document.documentElement.dataset.auditStatus = 'failed';
});
`;

function portFromArgs() {
  const raw = process.argv.find((argument) => argument.startsWith('--port='))?.slice('--port='.length);
  const port = raw ? Number(raw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid --port value.');
  return port;
}

function outputDirectoryFromArgs() {
  const raw = process.argv.find((argument) => argument.startsWith('--output-dir='))
    ?.slice('--output-dir='.length);
  return resolve(raw || DEFAULT_OUTPUT_DIR);
}

const port = portFromArgs();
const outputDirectory = outputDirectoryFromArgs();
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; img-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method === 'POST' && request.url?.startsWith('/export?')) {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const requestedName = url.searchParams.get('filename') || '';
    const filename = basename(requestedName);
    if (filename !== requestedName || !/^[a-z0-9._-]+\.tar$/.test(filename)) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Invalid export filename.' }));
      return;
    }
    const contentLength = Number(request.headers['content-length'] || 0);
    if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > MAX_EXPORT_BYTES) {
      response.writeHead(413, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Export size is missing or outside the 1 GiB safety bound.' }));
      return;
    }
    const finalPath = join(outputDirectory, filename);
    if (existsSync(finalPath)) {
      request.resume();
      response.writeHead(409, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'An export with this filename already exists.' }));
      return;
    }
    const temporaryPath = `${finalPath}.partial-${process.pid}-${Date.now()}`;
    let receivedBytes = 0;
    request.on('data', (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_EXPORT_BYTES) request.destroy(new Error('Export exceeded the 1 GiB safety bound.'));
    });
    try {
      await pipeline(request, createWriteStream(temporaryPath, { mode: 0o600 }));
      if (receivedBytes !== contentLength) throw new Error('Export ended before every byte arrived.');
      linkSync(temporaryPath, finalPath);
      rmSync(temporaryPath, { force: true });
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ path: finalPath, sizeBytes: receivedBytes }));
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      response.writeHead(error?.code === 'EEXIST' ? 409 : 500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (request.url === '/audit.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    response.end(auditScript);
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Read-only legacy cache audit listening on http://localhost:${port}/ and http://127.0.0.1:${port}/`);
  console.log(`Lossless exports will be written to ${outputDirectory}`);
});
