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
  REVIEWED_CANONICAL_IMPORT_CONFIRMATION,
  REVIEWED_CANONICAL_IMPORT_SAFETY_CONFIRMATION,
  REVIEWED_CANONICAL_QA_DECISION,
  runReviewedCanonicalImport,
} from './import-reviewed-xai-canonical-bundle.mjs';
import {
  buildXaiCanonicalBundlePayload,
  buildXaiCanonicalBundlePrompt,
} from './arcade-xai-canonical-bundle.mjs';

const roster = JSON.parse(readFileSync(new URL('../arcade/roster-2026.json', import.meta.url), 'utf8'));
const directories = [];
const FIGHTER_ID = 'a'.repeat(32);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function png(label, width = 128, height = 192) {
  const bytes = Buffer.alloc(64, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  Buffer.from(label).copy(bytes, 24, 0, Math.min(40, Buffer.byteLength(label)));
  return bytes;
}

function bundleFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'insert-player-reviewed-import-'));
  directories.push(directory);
  const bundleDirectory = join(directory, 'bundle');
  const outputDirectory = join(directory, 'output');
  mkdirSync(join(bundleDirectory, 'sources'), { recursive: true });
  const fighter = roster.fighters.find((entry) => entry.slug === 'elon-musk');
  const artifact = (path, bytes, raw) => {
    writeFileSync(join(bundleDirectory, path), bytes);
    return {
      contentSha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      ...(raw ? {
        mimeType: 'image/png',
        pixcliAssetHash: sha256(bytes).slice(0, 32),
        providerRequestId: `provider-${path.replaceAll('/', '-')}`,
      } : {}),
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      path,
    };
  };
  const sources = {};
  const uploads = {};
  const upload = (reference) => {
    const key = `reference:${reference.contentSha256}`;
    uploads[key] ??= {
      status: 'uploaded',
      id: reference.id,
      contentSha256: reference.contentSha256,
      sourceSha256: reference.contentSha256,
      pixcliAssetHash: sha256(`pixcli:${reference.contentSha256}`).slice(0, 32),
    };
    return uploads[key];
  };
  const identityReference = {
    id: `identity-${fighter.slug}`,
    contentSha256: fighter.reference.sourceSha256,
  };
  for (const sourceName of ['side', 'upright', 'crouch']) {
    const raw = artifact(`sources/${sourceName}_raw.png`, png(`${sourceName}-raw`, 1024, 1536), true);
    const clean = artifact(`sources/${sourceName}.png`, png(`${sourceName}-clean`, 1024, 1536), false);
    const providerRequestId = raw.providerRequestId;
    const pose = { id: `${sourceName}-pose-v1`, contentSha256: sha256(`${sourceName}:pose`) };
    const rendering = { id: 'rendering-v1', contentSha256: sha256('rendering') };
    const payload = buildXaiCanonicalBundlePayload({
      fighter,
      sourceName,
      poseAssetHash: upload(pose).pixcliAssetHash,
      renderingAssetHash: upload(rendering).pixcliAssetHash,
      identityAssetHash: upload(identityReference).pixcliAssetHash,
    });
    sources[sourceName] = {
      references: {
        pose,
        rendering,
        identity: { contentSha256: fighter.reference.sourceSha256 },
      },
      promptSha256: sha256(buildXaiCanonicalBundlePrompt(fighter, sourceName)),
      requestSha256: sha256(canonicalJson(payload)),
      pixcliJobId: `job-${sourceName}`,
      providerRequestId,
      raw,
      clean,
    };
  }
  const contact = png('contact', 1152, 1024);
  writeFileSync(join(bundleDirectory, 'contact-sheet.png'), contact);
  const unsigned = {
    schemaVersion: 1,
    descriptorType: 'arcade_xai_canonical_bundle_review',
    bundleId: 'arcade-xai-canonical-bundle-elon-musk-v1',
    status: 'awaiting_human_review',
    baseCommit: 'fca24ac39763b879eb6072c0cfb39ea098e5705d',
    fighter: { slug: fighter.slug, name: fighter.name, originalSha256: fighter.reference.sourceSha256 },
    poseManifest: { id: 'arcade-xai-canonical-pose-bundle-test-v1', contentSha256: sha256('pose-manifest') },
    provider: {
      modelId: 'grok-imagine-image-2-edit',
      endpoint: 'xai/grok-imagine-image/v2.0/edit',
      provider: 'xai',
      backend: 'fal',
      auditedCostPerOutputUsd: 0.11,
      maximumCostPerOutputUsd: 0.12,
      maximumBundleCostUsd: 0.36,
      paidCalls: 3,
      actualCostUsd: 0.33,
    },
    cleanup: { ffmpegVersion: '5.1.9-0+deb12u1', filter: 'chromakey=0x00FF00:0.20:0.08,format=rgba' },
    policy: {
      expectedPaidCalls: 3,
      maximumPaidCalls: 3,
      automaticRetries: 0,
      fallback: 'none',
      promptEnrichment: false,
      catalogCostPerOutputUsd: 0.11,
      maximumCostPerOutputUsd: 0.12,
      maximumBundleCostUsd: 0.36,
      outputVisibility: 'private_local',
      import: false,
      activation: false,
      humanReviewRequired: true,
    },
    sources,
    contactSheet: {
      path: 'contact-sheet.png',
      contentSha256: sha256(contact),
      sizeBytes: contact.byteLength,
      width: 1152,
      height: 1024,
      layout: ['side_raw', 'upright_raw', 'crouch_raw', 'side_clean', 'upright_clean', 'crouch_clean'],
    },
  };
  const descriptor = { ...unsigned, descriptorSha256: sha256(canonicalJson(unsigned)) };
  writeFileSync(join(bundleDirectory, 'review-descriptor.json'), JSON.stringify(descriptor));
  const state = {
    schemaVersion: 1,
    bundleId: descriptor.bundleId,
    fighterSlug: fighter.slug,
    fighterName: fighter.name,
    originalSha256: fighter.reference.sourceSha256,
    poseManifestId: descriptor.poseManifest.id,
    poseManifestSha256: descriptor.poseManifest.contentSha256,
    matrixSha256: sha256('matrix'),
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:01:00.000Z',
    policy: descriptor.policy,
    uploads,
    lastCatalogPreflight: {
      modelId: 'grok-imagine-image-2-edit',
      catalogSha256: sha256('catalog'),
      checkedAt: '2026-08-27T00:00:30.000Z',
    },
    descriptorSha256: descriptor.descriptorSha256,
    contactSheetSha256: descriptor.contactSheet.contentSha256,
    status: 'awaiting_human_review',
    slots: Object.fromEntries(['side', 'upright', 'crouch'].map((sourceName) => [sourceName, {
      status: 'completed',
      sourceName,
      fighterSlug: fighter.slug,
      originalSha256: fighter.reference.sourceSha256,
      poseSha256: sources[sourceName].references.pose.contentSha256,
      renderingSha256: sources[sourceName].references.rendering.contentSha256,
      promptSha256: sources[sourceName].promptSha256,
      modelId: 'grok-imagine-image-2-edit',
      requestSha256: sources[sourceName].requestSha256,
      pixcliJobId: sources[sourceName].pixcliJobId,
      raw: sources[sourceName].raw,
      clean: sources[sourceName].clean,
      audit: {
        providerRun: { requestId: sources[sourceName].providerRequestId },
        inputSha256: sources[sourceName].requestSha256,
        costMicrocredits: 110000,
        costUsd: 0.11,
      },
      cleanupFfmpegVersion: '5.1.9-0+deb12u1',
    }])),
  };
  writeFileSync(join(bundleDirectory, 'generation-state.json'), JSON.stringify(state));
  return {
    directory,
    bundleDirectory,
    outputDirectory,
    descriptor,
    state,
    sources,
    fighter,
    statePath: join(outputDirectory, 'import-state.json'),
  };
}

function hashKey(kind) {
  return ({
    side: 'side', side_raw: 'sideRaw', upright: 'upright', upright_raw: 'uprightRaw',
    crouch: 'crouch', crouch_raw: 'crouchRaw',
  })[kind];
}

function apiFixture(fixture, initial = {}) {
  const hashes = {
    original: fixture.fighter.reference.sourceSha256,
    side: sha256('old-side'), sideRaw: sha256('old-side-raw'),
    upright: sha256('old-upright'), uprightRaw: sha256('old-upright-raw'),
    crouch: sha256('old-crouch'), crouchRaw: sha256('old-crouch-raw'),
    ...initial,
  };
  const urls = Object.fromEntries(Object.keys(hashes).map((key) => [key, `https://api.example/${key}.png`]));
  const detail = () => ({
    fighter: {
      id: FIGHTER_ID,
      name: fixture.fighter.name,
      photoHash: fixture.fighter.reference.sourceSha256,
      qualityTier: 'champion',
      public: false,
      sources: { original: urls.original, ...urls },
      sourceHashes: { ...hashes },
    },
  });
  const requestApi = vi.fn(async (path, init = {}) => {
    if (path === '/api/admin/arcade') {
      return { fighters: [{ slug: fixture.fighter.slug, fighterId: FIGHTER_ID, status: 'draft' }] };
    }
    if (path === `/api/fighters/${FIGHTER_ID}` && !init.method) return detail();
    if (path === `/api/fighters/${FIGHTER_ID}/sources` && init.method === 'POST') {
      const kind = init.body.get('kind');
      const file = init.body.get('file');
      hashes[hashKey(kind)] = sha256(Buffer.from(await file.arrayBuffer()));
      urls[hashKey(kind)] = `https://api.example/${kind}-${hashes[hashKey(kind)]}.png`;
      return detail();
    }
    throw new Error(`Unexpected request ${init.method ?? 'GET'} ${path}`);
  });
  return { requestApi, hashes, detail };
}

function options(fixture, api) {
  return {
    confirmation: REVIEWED_CANONICAL_IMPORT_CONFIRMATION,
    qaDecision: REVIEWED_CANONICAL_QA_DECISION,
    safetyConfirmation: REVIEWED_CANONICAL_IMPORT_SAFETY_CONFIRMATION,
    bundleRunId: '33000000001',
    reviewedDescriptorSha256: fixture.descriptor.descriptorSha256,
    slug: fixture.fighter.slug,
    reviewedBy: 'qa-reviewer',
    bundleDirectory: fixture.bundleDirectory,
    outputDirectory: fixture.outputDirectory,
    statePath: fixture.statePath,
    requestApi: api.requestApi,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('reviewed canonical bundle importer', () => {
  it('uploads exactly three reviewed pairs and emits the phase-A reviewed-current-v1 manifest', async () => {
    const fixture = bundleFixture();
    const api = apiFixture(fixture);
    const result = await runReviewedCanonicalImport(options(fixture, api));
    const posts = api.requestApi.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.map(([, init]) => init.body.get('kind'))).toEqual([
      'side', 'side_raw', 'upright', 'upright_raw', 'crouch', 'crouch_raw',
    ]);
    expect(result.reviewedManifest).toEqual({
      schemaVersion: 1,
      canonicalSourceMode: 'reviewed-current-v1',
      slug: fixture.fighter.slug,
      fighterId: FIGHTER_ID,
      photoHash: fixture.fighter.reference.sourceSha256,
      canonicalSourceHashes: {
        side: {
          processedSha256: fixture.sources.side.clean.contentSha256,
          rawSha256: fixture.sources.side.raw.contentSha256,
        },
        upright: {
          processedSha256: fixture.sources.upright.clean.contentSha256,
          rawSha256: fixture.sources.upright.raw.contentSha256,
        },
        crouch: {
          processedSha256: fixture.sources.crouch.clean.contentSha256,
          rawSha256: fixture.sources.crouch.raw.contentSha256,
        },
      },
    });
    expect(result.receipt).toMatchObject({
      generationStarted: false,
      approvedAutomatically: false,
      activated: false,
      qaDecision: REVIEWED_CANONICAL_QA_DECISION,
    });
  });

  it('fails before authentication or mutation on tamper, cross-fighter data, or missing QA', async () => {
    const fixture = bundleFixture();
    const api = apiFixture(fixture);
    writeFileSync(join(fixture.bundleDirectory, 'sources', 'side.png'), png('tampered'));
    await expect(runReviewedCanonicalImport(options(fixture, api))).rejects.toThrow(/tampered/i);
    expect(api.requestApi).not.toHaveBeenCalled();

    const cross = bundleFixture();
    const crossApi = apiFixture(cross);
    await expect(runReviewedCanonicalImport({ ...options(cross, crossApi), slug: 'rosalia' }))
      .rejects.toThrow(/different fighter slug/i);
    expect(crossApi.requestApi).not.toHaveBeenCalled();

    const missingQa = bundleFixture();
    const missingQaApi = apiFixture(missingQa);
    await expect(runReviewedCanonicalImport({ ...options(missingQa, missingQaApi), qaDecision: 'approved' }))
      .rejects.toThrow(/explicit QA decision/i);
    expect(missingQaApi.requestApi).not.toHaveBeenCalled();

    const missingReviewer = bundleFixture();
    const missingReviewerApi = apiFixture(missingReviewer);
    await expect(runReviewedCanonicalImport({
      ...options(missingReviewer, missingReviewerApi),
      reviewedBy: '',
    })).rejects.toThrow(/review actor/i);
    expect(missingReviewerApi.requestApi).not.toHaveBeenCalled();

    const wrongCostUnits = bundleFixture();
    const wrongCostUnitsApi = apiFixture(wrongCostUnits);
    wrongCostUnits.state.slots.side.audit.costMicrocredits = 0.11;
    writeFileSync(
      join(wrongCostUnits.bundleDirectory, 'generation-state.json'),
      JSON.stringify(wrongCostUnits.state),
    );
    await expect(runReviewedCanonicalImport(options(wrongCostUnits, wrongCostUnitsApi)))
      .rejects.toThrow(/exact completed reviewed source/i);
    expect(wrongCostUnitsApi.requestApi).not.toHaveBeenCalled();
  });

  it('is idempotent after all six exact current hashes are present', async () => {
    const fixture = bundleFixture();
    const api = apiFixture(fixture);
    const run = options(fixture, api);
    await runReviewedCanonicalImport(run);
    const postsAfterFirst = api.requestApi.mock.calls.filter(([, init]) => init?.method === 'POST').length;
    await runReviewedCanonicalImport(run);
    expect(api.requestApi.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(postsAfterFirst);
  });

  it('resumes a clean partial checkpoint without replacing already-current assets', async () => {
    const fixture = bundleFixture();
    const api = apiFixture(fixture, {
      side: fixture.sources.side.clean.contentSha256,
      sideRaw: fixture.sources.side.raw.contentSha256,
    });
    mkdirSync(fixture.outputDirectory, { recursive: true });
    writeFileSync(fixture.statePath, JSON.stringify({
      schemaVersion: 1,
      status: 'importing',
      bundleRunId: '33000000001',
      bundleId: fixture.descriptor.bundleId,
      descriptorSha256: fixture.descriptor.descriptorSha256,
      slug: fixture.fighter.slug,
      fighterId: FIGHTER_ID,
      photoHash: fixture.fighter.reference.sourceSha256,
      qaDecision: REVIEWED_CANONICAL_QA_DECISION,
      safetyConfirmation: REVIEWED_CANONICAL_IMPORT_SAFETY_CONFIRMATION,
      uploads: {
        side: { status: 'verified', expectedSha256: fixture.sources.side.clean.contentSha256 },
        side_raw: { status: 'verified', expectedSha256: fixture.sources.side.raw.contentSha256 },
      },
    }));
    await runReviewedCanonicalImport(options(fixture, api));
    expect(api.requestApi.mock.calls.filter(([, init]) => init?.method === 'POST')
      .map(([, init]) => init.body.get('kind'))).toEqual([
      'upright', 'upright_raw', 'crouch', 'crouch_raw',
    ]);
  });

  it('never re-POSTs an ambiguous partial upload whose current hash cannot prove success', async () => {
    const fixture = bundleFixture();
    const api = apiFixture(fixture);
    mkdirSync(fixture.outputDirectory, { recursive: true });
    writeFileSync(fixture.statePath, JSON.stringify({
      schemaVersion: 1,
      status: 'importing',
      bundleRunId: '33000000001',
      bundleId: fixture.descriptor.bundleId,
      descriptorSha256: fixture.descriptor.descriptorSha256,
      slug: fixture.fighter.slug,
      fighterId: FIGHTER_ID,
      photoHash: fixture.fighter.reference.sourceSha256,
      qaDecision: REVIEWED_CANONICAL_QA_DECISION,
      safetyConfirmation: REVIEWED_CANONICAL_IMPORT_SAFETY_CONFIRMATION,
      uploads: {
        side: { status: 'outcome_unknown', expectedSha256: fixture.sources.side.clean.contentSha256 },
      },
    }));
    await expect(runReviewedCanonicalImport(options(fixture, api))).rejects.toThrow(/ambiguous prior upload/i);
    expect(api.requestApi.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('fails if a reviewed current pointer changes after a completed checkpoint', async () => {
    const fixture = bundleFixture();
    const api = apiFixture(fixture);
    const run = options(fixture, api);
    await runReviewedCanonicalImport(run);
    api.hashes.side = sha256('tampered-current-side');
    await expect(runReviewedCanonicalImport(run)).rejects.toThrow(/changed after reviewed import/i);
    expect(api.requestApi.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(6);
  });

  it('keeps the post-review workflow separate from generation, approval, and activation', () => {
    const workflow = readFileSync(new URL(
      '../.github/workflows/import-reviewed-xai-canonical-production.yml',
      import.meta.url,
    ), 'utf8');
    expect(workflow).toContain('bundle_run_id:');
    expect(workflow).toContain('reviewed_descriptor_sha256:');
    expect(workflow).toContain('APPROVE_XAI_CANONICAL_BUNDLE_FOR_SOURCE_IMPORT_V1');
    expect(workflow).toContain('IMPORT_REVIEWED_XAI_CANONICAL_BUNDLE_PRODUCTION_V1');
    expect(workflow).toContain('SOURCES_ONLY_NO_GENERATION_NO_ACTIVATION');
    expect(workflow).toContain('gh run download "$BUNDLE_RUN_ID"');
    expect(workflow).toContain('arcade-xai-canonical-bundle-$REQUESTED_SLUG');
    expect(workflow).toContain('arcade-reviewed-canonical-manifest-${{ inputs.slug }}');
    expect(workflow).toContain('group: production-worker-mutations');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).not.toMatch(/\/generate(?:\/|\s|$)|\/approve(?:\/|\s|$)|--activate|PIXCLI_API_KEY/);
  });
});
