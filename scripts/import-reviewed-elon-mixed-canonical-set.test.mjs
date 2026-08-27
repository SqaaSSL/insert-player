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
  ELON_MIXED_IMPORT_CONFIRMATION,
  ELON_MIXED_IMPORT_SAFETY_CONFIRMATION,
  ELON_MIXED_QA_DECISION,
  ELON_UPRIGHT_ALIAS_DECISION,
  INSERT_PLAYER_PRODUCTION_WORKER_ORIGIN,
  normalizeProductionWorkerUrl,
  runReviewedElonMixedCanonicalImport,
} from './import-reviewed-elon-mixed-canonical-set.mjs';
import { authenticatedRequestClient } from './import-reviewed-xai-canonical-bundle.mjs';
import { assertReviewedCanonicalManifest } from './seed-arcade-roster.mjs';

const roster = JSON.parse(readFileSync(new URL('../arcade/roster-2026.json', import.meta.url), 'utf8'));
const directories = [];
const FIGHTER_ID = 'a'.repeat(32);
const OWNER_ID = 'user_elon_operator';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function png(label, width = 896, height = 1195) {
  const bytes = Buffer.alloc(96, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  Buffer.from(label).copy(bytes, 24, 0, Math.min(64, Buffer.byteLength(label)));
  return bytes;
}

function sourceIdentity(kind, versionId, bytes) {
  return {
    versionId,
    blobKey: `users/${OWNER_ID}/fighters/${FIGHTER_ID}/sources/${kind}_${versionId}.png`,
    contentSha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'insert-player-elon-mixed-import-'));
  directories.push(directory);
  const bundleDirectory = join(directory, 'bundle');
  const outputDirectory = join(directory, 'output');
  mkdirSync(join(bundleDirectory, 'sources'), { recursive: true });
  const fighter = roster.fighters.find((entry) => entry.slug === 'elon-musk');
  const sideProcessed = png('reviewed-side-processed');
  const sideRaw = png('reviewed-side-raw');
  const crouchProcessed = png('reviewed-crouch-processed');
  const crouchRaw = png('reviewed-crouch-raw');
  const crouchProcessedPath = join(bundleDirectory, 'sources/crouch.png');
  const crouchRawPath = join(bundleDirectory, 'sources/crouch_raw.png');
  writeFileSync(crouchProcessedPath, crouchProcessed);
  writeFileSync(crouchRawPath, crouchRaw);
  const side = {
    processed: sourceIdentity('side', '1'.repeat(32), sideProcessed),
    raw: sourceIdentity('side_raw', '2'.repeat(32), sideRaw),
  };
  const descriptorSha256 = sha256('reviewed-crouch-descriptor');
  const bundle = {
    sourceNames: ['crouch'],
    descriptor: {
      bundleId: 'arcade-xai-canonical-source-elon-musk-crouch-v1',
      fighter: { originalSha256: fighter.reference.sourceSha256 },
      sources: {
        crouch: {
          clean: { contentSha256: sha256(crouchProcessed) },
          raw: { contentSha256: sha256(crouchRaw) },
        },
      },
    },
    sources: {
      crouch: {
        processed: { contentSha256: sha256(crouchProcessed), absolutePath: crouchProcessedPath },
        raw: { contentSha256: sha256(crouchRaw), absolutePath: crouchRawPath },
      },
    },
  };
  const qaEvidence = {
    schemaVersion: 1,
    evidenceType: 'elon_mixed_canonical_human_review_v1',
    status: 'approved',
    decision: ELON_MIXED_QA_DECISION,
    reviewedBy: 'qa-reviewer',
    reviewedAt: '2026-08-27T04:00:00.000Z',
    fighter: {
      slug: 'elon-musk', fighterId: FIGHTER_ID, name: fighter.name, photoHash: fighter.reference.sourceSha256,
    },
    side: {
      processedVersionId: side.processed.versionId,
      processedSha256: side.processed.contentSha256,
      rawVersionId: side.raw.versionId,
      rawSha256: side.raw.contentSha256,
      approvalLineage: {
        status: 'approved',
        runId: '7'.repeat(32),
        jobId: '7'.repeat(32),
        completedByJobId: '7'.repeat(32),
        artifactKind: 'source',
        artifactName: 'side',
        stageIndex: 1,
        qualityTier: 'champion',
        createdAt: '2026-08-25 13:59:21',
        verifiedAt: null,
      },
    },
    uprightAlias: {
      decision: ELON_UPRIGHT_ALIAS_DECISION,
      processedSha256: side.processed.contentSha256,
      rawSha256: side.raw.contentSha256,
    },
    crouch: {
      bundleRunId: '33000000001',
      descriptorSha256,
      processedSha256: sha256(crouchProcessed),
      rawSha256: sha256(crouchRaw),
    },
    blockingFindings: [],
  };
  const qaPath = join(directory, 'qa-evidence.json');
  const qaBytes = Buffer.from(JSON.stringify(qaEvidence));
  writeFileSync(qaPath, qaBytes);
  const plan = {
    schemaVersion: 1,
    planType: 'elon_reviewed_mixed_canonical_set_v1',
    fighter: qaEvidence.fighter,
    side,
    sideApproval: qaEvidence.side.approvalLineage,
    uprightAlias: {
      decision: ELON_UPRIGHT_ALIAS_DECISION,
      fromProcessedVersionId: side.processed.versionId,
      fromRawVersionId: side.raw.versionId,
    },
    crouch: {
      bundleRunId: '33000000001',
      bundleId: bundle.descriptor.bundleId,
      reviewedDescriptorSha256: descriptorSha256,
      processedSha256: sha256(crouchProcessed),
      rawSha256: sha256(crouchRaw),
    },
    qaEvidence: { path: 'qa-evidence.json', contentSha256: sha256(qaBytes) },
    safety: {
      providerCalls: 0,
      generationStarted: false,
      activated: false,
      sideMutation: false,
      allowedSourcePosts: ['upright', 'upright_raw', 'crouch', 'crouch_raw'],
    },
  };
  const planPath = join(directory, 'assembly-plan.json');
  const planBytes = Buffer.from(JSON.stringify(plan));
  writeFileSync(planPath, planBytes);
  return {
    directory,
    outputDirectory,
    bundleDirectory,
    bundle,
    fighter,
    plan,
    planPath,
    planSha256: sha256(planBytes),
    qaPath,
    sideProcessed,
    sideRaw,
    crouchProcessed,
    crouchRaw,
  };
}

function apiFixture(testFixture, options = {}) {
  const current = {
    side: { ...testFixture.plan.side.processed, bytes: testFixture.sideProcessed },
    side_raw: { ...testFixture.plan.side.raw, bytes: testFixture.sideRaw },
    upright: { ...sourceIdentity('upright', '3'.repeat(32), png('old-upright')), bytes: png('old-upright') },
    upright_raw: { ...sourceIdentity('upright_raw', '4'.repeat(32), png('old-upright-raw')), bytes: png('old-upright-raw') },
    crouch: { ...sourceIdentity('crouch', '5'.repeat(32), png('old-crouch')), bytes: png('old-crouch') },
    crouch_raw: { ...sourceIdentity('crouch_raw', '6'.repeat(32), png('old-crouch-raw')), bytes: png('old-crouch-raw') },
  };
  const finalVersionIds = {
    upright: 'b'.repeat(32), upright_raw: 'c'.repeat(32), crouch: 'd'.repeat(32), crouch_raw: 'e'.repeat(32),
  };
  if (options.tamperSideBytes) current.side.bytes = png('tampered-side-r2-bytes');
  const key = (kind) => ({
    side: 'side', side_raw: 'sideRaw', upright: 'upright', upright_raw: 'uprightRaw',
    crouch: 'crouch', crouch_raw: 'crouchRaw',
  })[kind];
  const assetPath = (record) => `/assets/${record.blobKey}`;
  const detail = () => ({
    fighter: {
      id: FIGHTER_ID,
      name: testFixture.fighter.name,
      photoHash: testFixture.fighter.reference.sourceSha256,
      qualityTier: 'champion',
      public: false,
      sources: {
        original: 'https://api.example/assets/original.png',
        ...Object.fromEntries(Object.entries(current).map(([kind, record]) => [
          key(kind), `https://api.example${assetPath(record)}`,
        ])),
      },
      sourceHashes: {
        original: testFixture.fighter.reference.sourceSha256,
        ...Object.fromEntries(Object.entries(current).map(([kind, record]) => [kind, record.contentSha256])),
      },
    },
  });
  let posts = 0;
  const requestApi = vi.fn(async (path, init = {}) => {
    if (path === '/api/admin/arcade') {
      return { fighters: [{ slug: 'elon-musk', fighterId: FIGHTER_ID, status: 'draft' }] };
    }
    if (path === `/api/fighters/${FIGHTER_ID}` && !init.method) return detail();
    if (path === `/api/fighters/${FIGHTER_ID}/sources` && init.method === 'POST') {
      posts += 1;
      if (options.throwOnFirstPost && posts === 1) throw new Error('simulated network ambiguity');
      const kind = init.body.get('kind');
      const bytes = Buffer.from(await init.body.get('file').arrayBuffer());
      current[kind] = { ...sourceIdentity(kind, finalVersionIds[kind], bytes), bytes };
      return detail();
    }
    throw new Error(`Unexpected API request ${init.method ?? 'GET'} ${path}`);
  });
  const requestAsset = vi.fn(async (path) => {
    if (options.assetRedirect) {
      return new Response(null, { status: 302, headers: { Location: 'https://evil.example/source.png' } });
    }
    const record = Object.values(current).find((entry) => assetPath(entry) === path);
    if (!record) return new Response('missing', { status: 404 });
    return new Response(record.bytes, {
      status: 200,
      headers: {
        'Content-Type': options.assetMime ?? 'image/png',
        'Content-Length': String(record.bytes.byteLength),
      },
    });
  });
  return { requestApi, requestAsset, current, get posts() { return posts; } };
}

function runOptions(testFixture, api) {
  return {
    confirmation: ELON_MIXED_IMPORT_CONFIRMATION,
    safetyConfirmation: ELON_MIXED_IMPORT_SAFETY_CONFIRMATION,
    reviewedBy: 'qa-reviewer',
    assemblyPlanPath: testFixture.planPath,
    assemblyPlanSha256: testFixture.planSha256,
    bundleDirectory: testFixture.bundleDirectory,
    outputDirectory: testFixture.outputDirectory,
    workerUrl: 'https://api.example',
    requestApi: api.requestApi,
    requestAsset: api.requestAsset,
    loadReviewedBundle: () => testFixture.bundle,
    validateReviewedBundle: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('reviewed Elon mixed canonical importer', () => {
  it('keeps the production workflow source-only and seals the exact approved SIDE lineage', () => {
    const workflow = readFileSync(new URL(
      '../.github/workflows/import-reviewed-elon-mixed-canonical-production.yml',
      import.meta.url,
    ), 'utf8');
    expect(workflow).toContain('APPROVE_ELON_SIDE_ALIAS_AND_CROUCH_V1');
    expect(workflow).toContain('a8064b8a7118283bd4a53f92d09b8dc6');
    expect(workflow).toContain('dc745247e2bac87911721c71fc468cbb');
    expect(workflow).toContain('7ffc7bc23f8d74438f4e85cf722400979111f757b4fdd1cb751b225c06045cf4');
    expect(workflow).toContain('38354aafc02505c69de9163a4dfaeeab15a2d084c1e5f5d981f9b6cde9cdb5d2');
    expect(workflow).toContain('ALIAS_EXACT_REVIEWED_SIDE_BYTES_AS_UPRIGHT_V1');
    expect(workflow).toContain('arcade:import:reviewed-elon-mixed-canonical');
    expect(workflow).toContain('resume_import_run_id');
    expect(workflow).toContain('arcade-reviewed-elon-mixed-import-checkpoint-$RESUME_IMPORT_RUN_ID');
    expect(workflow).toContain(".crouch.bundleRunId");
    expect(workflow).toContain(".crouch.reviewedDescriptorSha256");
    expect(workflow).toContain("url.origin !== workerUrl.origin");
    expect(workflow).toContain("workerUrl.origin !== 'https://api.insertplayer.ai'");
    expect(workflow).not.toMatch(/PIXCLI_API_KEY|FAL_API_KEY|GEMINI_API_KEY|\/generate|\/activate|\/approve/);
  });

  it('seals authenticated requests to the exact production Worker origin', () => {
    expect(normalizeProductionWorkerUrl(INSERT_PLAYER_PRODUCTION_WORKER_ORIGIN))
      .toBe(INSERT_PLAYER_PRODUCTION_WORKER_ORIGIN);
    for (const value of [
      'https://evil.example',
      'https://api.insertplayer.ai.evil.example',
      'https://user:password@api.insertplayer.ai',
      'https://api.insertplayer.ai:444',
      'https://api.insertplayer.ai/health',
      'https://api.insertplayer.ai?redirect=evil',
    ]) expect(() => normalizeProductionWorkerUrl(value)).toThrow(/exactly|invalid/i);
  });

  it('forbids redirects for authenticated source API mutations', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: 'https://redirect.example/mutation' },
    }));
    const request = authenticatedRequestClient(
      'https://api.example',
      async () => 'test-jwt',
      'b'.repeat(32),
    );
    await expect(request(`/api/fighters/${FIGHTER_ID}/sources`, {
      method: 'POST',
      body: new FormData(),
    })).rejects.toThrow(/redirected.*forbidden/i);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.example/api/fighters/${FIGHTER_ID}/sources`,
      expect.objectContaining({ method: 'POST', redirect: 'manual' }),
    );
  });

  it('keeps SIDE, aliases its exact bytes as UPRIGHT, imports one reviewed CROUCH pair, and emits both manifests', async () => {
    const testFixture = fixture();
    const api = apiFixture(testFixture);
    const result = await runReviewedElonMixedCanonicalImport(runOptions(testFixture, api));
    const posts = api.requestApi.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.map(([, init]) => init.body.get('kind'))).toEqual([
      'upright', 'upright_raw', 'crouch', 'crouch_raw',
    ]);
    expect(posts.some(([, init]) => init.body.get('kind').startsWith('side'))).toBe(false);
    expect(result.reviewedManifest).toEqual({
      schemaVersion: 1,
      canonicalSourceMode: 'reviewed-current-v1',
      slug: 'elon-musk',
      fighterId: FIGHTER_ID,
      photoHash: testFixture.fighter.reference.sourceSha256,
      canonicalSourceHashes: {
        side: {
          processedSha256: sha256(testFixture.sideProcessed), rawSha256: sha256(testFixture.sideRaw),
        },
        upright: {
          processedSha256: sha256(testFixture.sideProcessed), rawSha256: sha256(testFixture.sideRaw),
        },
        crouch: {
          processedSha256: sha256(testFixture.crouchProcessed), rawSha256: sha256(testFixture.crouchRaw),
        },
      },
    });
    expect(assertReviewedCanonicalManifest(result.reviewedManifest, {
      slug: 'elon-musk',
      fighterId: FIGHTER_ID,
      photoHash: testFixture.fighter.reference.sourceSha256,
    })).toBe(result.reviewedManifest);
    expect(result.operatorManifest).toMatchObject({
      status: 'completed_sources_only',
      aliasDecision: {
        decision: ELON_UPRIGHT_ALIAS_DECISION,
        processedByteSha256: sha256(testFixture.sideProcessed),
        rawByteSha256: sha256(testFixture.sideRaw),
      },
      safety: {
        providerCalls: 0,
        generationStarted: false,
        activated: false,
        sideMutated: false,
      },
    });
    expect(result.operatorManifest.sources.side.processed).toMatchObject(testFixture.plan.side.processed);
    expect(result.operatorManifest.sources.upright.processed.versionId).toBe('b'.repeat(32));
    expect(readFileSync(join(testFixture.outputDirectory, 'reviewed-canonical-manifest.json'))).toBeTruthy();
    expect(readFileSync(join(testFixture.outputDirectory, 'reviewed-canonical-operator-manifest.json'))).toBeTruthy();
    expect(api.requestApi.mock.calls.flatMap(([path]) => [path]).join('\n')).not.toMatch(/generate|provider|activate|approve/i);
  });

  it('fails before API access when the hash-bound plan or QA evidence changes', async () => {
    const testFixture = fixture();
    const api = apiFixture(testFixture);
    writeFileSync(testFixture.qaPath, JSON.stringify({ status: 'approved', tampered: true }));
    await expect(runReviewedElonMixedCanonicalImport(runOptions(testFixture, api)))
      .rejects.toThrow(/QA evidence SHA-256 mismatch/i);
    expect(api.requestApi).not.toHaveBeenCalled();
    expect(api.requestAsset).not.toHaveBeenCalled();
  });

  it('rehashes current SIDE R2 bytes and rejects MIME drift before any source POST', async () => {
    const testFixture = fixture();
    const api = apiFixture(testFixture, { assetMime: 'application/octet-stream' });
    await expect(runReviewedElonMixedCanonicalImport(runOptions(testFixture, api)))
      .rejects.toThrow(/MIME type is not image\/png/i);
    expect(api.posts).toBe(0);
  });

  it('rejects changed SIDE R2 bytes or redirects before any source POST', async () => {
    for (const overrides of [{ tamperSideBytes: true }, { assetRedirect: true }]) {
      const testFixture = fixture();
      const api = apiFixture(testFixture, overrides);
      await expect(runReviewedElonMixedCanonicalImport(runOptions(testFixture, api)))
        .rejects.toThrow(/hash pointer does not match|redirect is forbidden/i);
      expect(api.posts).toBe(0);
    }
  });

  it('preflights the complete local CROUCH pair before the first source POST', async () => {
    const testFixture = fixture();
    const api = apiFixture(testFixture);
    writeFileSync(testFixture.bundle.sources.crouch.raw.absolutePath, png('tampered-crouch-raw'));
    await expect(runReviewedElonMixedCanonicalImport(runOptions(testFixture, api)))
      .rejects.toThrow(/crouch_raw local reviewed bytes changed/i);
    expect(api.posts).toBe(0);
  });

  it('never re-POSTs an ambiguous source mutation', async () => {
    const testFixture = fixture();
    const api = apiFixture(testFixture, { throwOnFirstPost: true });
    const options = runOptions(testFixture, api);
    await expect(runReviewedElonMixedCanonicalImport(options)).rejects.toThrow(/outcome is unknown/i);
    expect(api.posts).toBe(1);
    await expect(runReviewedElonMixedCanonicalImport(options)).rejects.toThrow(/ambiguous prior POST/i);
    expect(api.posts).toBe(1);
  });
});
