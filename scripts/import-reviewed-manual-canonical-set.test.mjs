import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REVIEWED_MANUAL_CANONICAL_IMPORT_CONFIRMATION,
  REVIEWED_MANUAL_CANONICAL_QA_DECISION,
  REVIEWED_MANUAL_CANONICAL_SAFETY_CONFIRMATION,
  REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS,
  runReviewedManualCanonicalImport,
  validateReviewedManualCanonicalDescriptor,
} from './import-reviewed-manual-canonical-set.mjs';

const roster = JSON.parse(readFileSync(new URL('../arcade/roster-2026.json', import.meta.url), 'utf8'));
const rosterFighter = roster.fighters.find((fighter) => fighter.slug === 'rosalia-v2');
const directories = [];
const FIGHTER_ID = 'a'.repeat(32);
const OWNER_ID = 'user_manual_test';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function png(label, width = 1086, height = 1448) {
  const bytes = Buffer.alloc(64, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  Buffer.from(label).copy(bytes, 24, 0, Math.min(40, Buffer.byteLength(label)));
  return bytes;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'insert-player-manual-canonical-'));
  directories.push(directory);
  const outputDirectory = join(directory, 'output');
  const descriptorPath = join(directory, 'descriptor.json');
  const assets = Object.fromEntries(REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS.map((kind) => [
    kind,
    png(`reviewed-${kind}`),
  ]));
  const sources = Object.fromEntries(REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS.map((kind) => {
    const contentSha256 = sha256(assets[kind]);
    return [kind, {
      kind,
      r2ObjectKey: `official-roster-canonical-inputs/rosalia-v2/${kind}_${contentSha256}.png`,
      contentSha256,
      sizeBytes: assets[kind].byteLength,
      width: 1086,
      height: 1448,
      mimeType: 'image/png',
    }];
  }));
  const descriptor = {
    schemaVersion: 1,
    descriptorType: 'reviewed_manual_canonical_set_v1',
    status: 'approved',
    fighter: {
      slug: rosterFighter.slug,
      name: rosterFighter.name,
      photoHash: rosterFighter.reference.sourceSha256,
    },
    r2: {
      bucket: 'insert-player-assets',
      jurisdiction: 'eu',
      prefix: 'official-roster-canonical-inputs/rosalia-v2',
    },
    review: {
      decision: REVIEWED_MANUAL_CANONICAL_QA_DECISION,
      blockingFindings: [],
    },
    sources,
    safety: {
      providerCalls: 0,
      generationStarted: false,
      activated: false,
      allowedSourcePosts: [...REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS],
    },
  };
  const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`);
  writeFileSync(descriptorPath, descriptorBytes);
  return {
    directory,
    outputDirectory,
    descriptorPath,
    descriptorSha256: sha256(descriptorBytes),
    descriptor,
    assets,
  };
}

function apiFixture(testFixture, initial = {}) {
  const hashes = {
    original: rosterFighter.reference.sourceSha256,
    ...Object.fromEntries(REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS.map((kind) => [kind, null])),
    ...(initial.hashes ?? {}),
  };
  const pointers = {
    original: `https://api.insertplayer.ai/assets/users/${OWNER_ID}/fighters/${FIGHTER_ID}/sources/original_${'b'.repeat(32)}.png`,
    side: null,
    sideRaw: null,
    upright: null,
    uprightRaw: null,
    crouch: null,
    crouchRaw: null,
    ...(initial.pointers ?? {}),
  };
  const bytesByPath = new Map(initial.bytesByPath ?? []);
  const adminEntry = {
    fighterId: FIGHTER_ID,
    slug: rosterFighter.slug,
    rank: rosterFighter.rank,
    fighterName: rosterFighter.name,
    qualityTier: 'champion',
    public: false,
    status: 'draft',
    challengerLine: rosterFighter.challengerLine,
    defaultPersonality: rosterFighter.defaultPersonality,
    reference: {
      kind: rosterFighter.reference.kind,
      sourceUrl: rosterFighter.reference.sourceUrl,
      license: rosterFighter.reference.license,
      credit: rosterFighter.reference.credit,
    },
    generationPrompt: rosterFighter.referencePrompt,
  };
  const detail = () => ({
    fighter: {
      id: FIGHTER_ID,
      name: rosterFighter.name,
      photoHash: rosterFighter.reference.sourceSha256,
      qualityTier: 'champion',
      public: false,
      sources: { ...pointers },
      sourceHashes: { ...hashes },
      sprites: [],
    },
  });
  let version = 0;
  const requestApi = vi.fn(async (path, init = {}) => {
    if (path === '/api/admin/arcade' && !init.method) return { fighters: [adminEntry] };
    if (path === `/api/fighters/${FIGHTER_ID}` && !init.method) return detail();
    if (path === `/api/generation-jobs?fighterId=${FIGHTER_ID}` && !init.method) return { jobs: [] };
    if (path === `/api/fighters/${FIGHTER_ID}/sources` && init.method === 'POST') {
      const kind = init.body.get('kind');
      const file = init.body.get('file');
      const bytes = Buffer.from(await file.arrayBuffer());
      version += 1;
      const versionId = sha256(`${kind}:${version}`).slice(0, 32);
      const pathKey = `/assets/users/${OWNER_ID}/fighters/${FIGHTER_ID}/sources/${kind}_${versionId}.png`;
      hashes[kind] = sha256(bytes);
      pointers[({
        side: 'side', side_raw: 'sideRaw', upright: 'upright', upright_raw: 'uprightRaw',
        crouch: 'crouch', crouch_raw: 'crouchRaw',
      })[kind]] = `https://api.insertplayer.ai${pathKey}`;
      bytesByPath.set(pathKey, bytes);
      return detail();
    }
    throw new Error(`Unexpected API request: ${init.method ?? 'GET'} ${path}`);
  });
  const requestAsset = vi.fn(async (path) => {
    const bytes = bytesByPath.get(path);
    if (!bytes) return new Response('missing', { status: 404 });
    return new Response(bytes, {
      headers: {
        'content-type': 'image/png',
        'content-length': String(bytes.byteLength),
      },
    });
  });
  return { requestApi, requestAsset, hashes, pointers, bytesByPath };
}

function options(testFixture, api, overrides = {}) {
  return {
    confirmation: REVIEWED_MANUAL_CANONICAL_IMPORT_CONFIRMATION,
    qaDecision: REVIEWED_MANUAL_CANONICAL_QA_DECISION,
    safetyConfirmation: REVIEWED_MANUAL_CANONICAL_SAFETY_CONFIRMATION,
    slug: 'rosalia-v2',
    reviewedBy: 'qa-reviewer',
    descriptorPath: testFixture.descriptorPath,
    descriptorSha256: testFixture.descriptorSha256,
    rosterPath: new URL('../arcade/roster-2026.json', import.meta.url),
    outputDirectory: testFixture.outputDirectory,
    statePath: join(testFixture.outputDirectory, 'import-state.json'),
    loadR2Object: vi.fn(async (source) => testFixture.assets[source.kind]),
    requestApi: api.requestApi,
    requestAsset: api.requestAsset,
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('reviewed manual canonical importer', () => {
  it('seals the committed Rosalia V2 descriptor to six content-addressed reviewed PNGs', () => {
    const descriptor = JSON.parse(readFileSync(new URL(
      '../arcade/reviewed-manual-canonical/rosalia-v2.json',
      import.meta.url,
    ), 'utf8'));
    expect(validateReviewedManualCanonicalDescriptor(descriptor)).toBe(descriptor);
    expect(Object.keys(descriptor.sources)).toEqual([...REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS]);
    expect(new Set(Object.values(descriptor.sources).map((source) => source.contentSha256))).toHaveLength(6);
    expect(Object.values(descriptor.sources).every((source) => (
      source.width === 1086 && source.height === 1448 && source.mimeType === 'image/png'
    ))).toBe(true);
  });

  it('uploads exactly six kinds and emits a Video-step-compatible reviewed-current manifest', async () => {
    const testFixture = fixture();
    const api = apiFixture(testFixture);
    const result = await runReviewedManualCanonicalImport(options(testFixture, api));
    const posts = api.requestApi.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.map(([, init]) => init.body.get('kind'))).toEqual([
      ...REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS,
    ]);
    expect(result.reviewedManifest).toEqual({
      schemaVersion: 1,
      canonicalSourceMode: 'reviewed-current-v1',
      slug: 'rosalia-v2',
      fighterId: FIGHTER_ID,
      photoHash: rosterFighter.reference.sourceSha256,
      canonicalSourceHashes: {
        side: {
          processedSha256: testFixture.descriptor.sources.side.contentSha256,
          rawSha256: testFixture.descriptor.sources.side_raw.contentSha256,
        },
        upright: {
          processedSha256: testFixture.descriptor.sources.upright.contentSha256,
          rawSha256: testFixture.descriptor.sources.upright_raw.contentSha256,
        },
        crouch: {
          processedSha256: testFixture.descriptor.sources.crouch.contentSha256,
          rawSha256: testFixture.descriptor.sources.crouch_raw.contentSha256,
        },
      },
    });
    expect(result.receipt).toMatchObject({
      providerCalls: 0,
      generationStarted: false,
      approvedAutomatically: false,
      activated: false,
    });
  });

  it('is idempotent when all six exact current R2 sources already exist', async () => {
    const testFixture = fixture();
    const api = apiFixture(testFixture);
    const run = options(testFixture, api);
    await runReviewedManualCanonicalImport(run);
    await runReviewedManualCanonicalImport(run);
    expect(api.requestApi.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(6);
  });

  it('fails before authentication on descriptor/R2 tamper and never overwrites another current source', async () => {
    const descriptorTamper = fixture();
    const descriptorApi = apiFixture(descriptorTamper);
    writeFileSync(descriptorTamper.descriptorPath, '{}\n');
    await expect(runReviewedManualCanonicalImport(options(descriptorTamper, descriptorApi)))
      .rejects.toThrow(/descriptor SHA-256 mismatch/i);
    expect(descriptorApi.requestApi).not.toHaveBeenCalled();

    const r2Tamper = fixture();
    const r2Api = apiFixture(r2Tamper);
    await expect(runReviewedManualCanonicalImport(options(r2Tamper, r2Api, {
      loadR2Object: vi.fn(async (source) => (
        source.kind === 'side' ? png('tampered-side') : r2Tamper.assets[source.kind]
      )),
    }))).rejects.toThrow(/do not match the reviewed descriptor/i);
    expect(r2Api.requestApi).not.toHaveBeenCalled();

    const overwrite = fixture();
    const oldBytes = png('unreviewed-side');
    const oldPath = `/assets/users/${OWNER_ID}/fighters/${FIGHTER_ID}/sources/side_${'c'.repeat(32)}.png`;
    const overwriteApi = apiFixture(overwrite, {
      hashes: { side: sha256(oldBytes) },
      pointers: { side: `https://api.insertplayer.ai${oldPath}` },
      bytesByPath: [[oldPath, oldBytes]],
    });
    await expect(runReviewedManualCanonicalImport(options(overwrite, overwriteApi)))
      .rejects.toThrow(/will not overwrite/i);
    expect(overwriteApi.requestApi.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('keeps the production workflow source-only, commit-pinned, and explicitly confirmed', () => {
    const workflow = readFileSync(new URL(
      '../.github/workflows/import-reviewed-manual-canonical-production.yml',
      import.meta.url,
    ), 'utf8');
    expect(workflow).toContain(REVIEWED_MANUAL_CANONICAL_IMPORT_CONFIRMATION);
    expect(workflow).toContain(REVIEWED_MANUAL_CANONICAL_QA_DECISION);
    expect(workflow).toContain(REVIEWED_MANUAL_CANONICAL_SAFETY_CONFIRMATION);
    expect(workflow).toContain('group: production-worker-mutations');
    expect(workflow).toContain('reviewed-canonical-manifest.json');
    expect(workflow).toContain('expectedTag.test(health.workerVersion.tag)');
    expect(workflow).toContain("workerBase !== 'https://api.insertplayer.ai'");
    expect(workflow).toContain("redirect: 'error'");
    expect(workflow).not.toMatch(/\/generate(?:\/|\s|$)|\/approve(?:\/|\s|$)|--activate|PIXCLI_API_KEY|FAL_API_KEY/);
  });
});
