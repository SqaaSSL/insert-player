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
  GLOBAL_MIXED_IMPORT_CONFIRMATION,
  GLOBAL_MIXED_IMPORT_SAFETY_CONFIRMATION,
  GLOBAL_MIXED_QA_DECISION,
  GLOBAL_MIXED_TARGETS,
  GLOBAL_UPRIGHT_ALIAS_DECISION,
  runReviewedGlobalMixedCanonicalImport,
} from './import-reviewed-elon-mixed-canonical-set.mjs';
import { XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE } from './arcade-xai-canonical-bundle.mjs';
import {
  assembleReviewedGlobalMixedCanonicalSet,
  ASSEMBLE_REVIEWED_GLOBAL_MIXED_CONFIRMATION,
} from './assemble-reviewed-global-mixed-canonical-set.mjs';
import { assertReviewedCanonicalManifest } from './seed-arcade-roster.mjs';

const rosterPath = new URL('../arcade/roster-2026.json', import.meta.url);
const roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
const directories = [];
const OWNER_ID = 'user_global_operator';
const SOURCE_KINDS = ['side', 'side_raw', 'upright', 'upright_raw', 'crouch', 'crouch_raw'];
const RESPONSE_KEYS = {
  side: 'side', side_raw: 'sideRaw', upright: 'upright', upright_raw: 'uprightRaw',
  crouch: 'crouch', crouch_raw: 'crouchRaw',
};

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

function fixture(slug = 'rosalia') {
  const directory = mkdtempSync(join(tmpdir(), 'insert-player-global-mixed-import-'));
  directories.push(directory);
  const sideBundleDirectory = join(directory, 'side-bundle');
  const crouchBundleDirectory = join(directory, 'crouch-bundle');
  const outputDirectory = join(directory, 'output');
  mkdirSync(join(sideBundleDirectory, 'sources'), { recursive: true });
  mkdirSync(join(crouchBundleDirectory, 'sources'), { recursive: true });
  const fighter = roster.fighters.find((entry) => entry.slug === slug);
  const target = GLOBAL_MIXED_TARGETS[slug];
  const sideProcessed = png(`${slug}-side-clean`);
  const sideRaw = png(`${slug}-side-raw`);
  const crouchProcessed = png(`${slug}-crouch-clean`);
  const crouchRaw = png(`${slug}-crouch-raw`);
  const paths = {
    sideProcessed: join(sideBundleDirectory, 'sources/side.png'),
    sideRaw: join(sideBundleDirectory, 'sources/side_raw.png'),
    crouchProcessed: join(crouchBundleDirectory, 'sources/crouch.png'),
    crouchRaw: join(crouchBundleDirectory, 'sources/crouch_raw.png'),
  };
  for (const [key, path] of Object.entries(paths)) writeFileSync(path, {
    sideProcessed, sideRaw, crouchProcessed, crouchRaw,
  }[key]);
  const sideDescriptorSha256 = '1'.repeat(64);
  const crouchDescriptorSha256 = '2'.repeat(64);
  const sideBundle = {
    sourceNames: ['side'],
    descriptor: {
      bundleId: `arcade-xai-canonical-source-${slug}-side-v1`,
      fighter: { slug, name: target.name, originalSha256: target.photoHash },
      sources: {
        side: {
          clean: { contentSha256: sha256(sideProcessed) },
          raw: { contentSha256: sha256(sideRaw) },
        },
      },
    },
    sources: {
      side: {
        processed: { absolutePath: paths.sideProcessed, contentSha256: sha256(sideProcessed) },
        raw: { absolutePath: paths.sideRaw, contentSha256: sha256(sideRaw) },
      },
    },
  };
  const crouchBundle = {
    sourceNames: ['crouch'],
    descriptor: {
      bundleId: `arcade-xai-canonical-source-${slug}-crouch-v1`,
      fighter: { slug, name: target.name, originalSha256: target.photoHash },
      sources: {
        crouch: {
          references: {
            pose: { ...XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE },
            rendering: { id: `reviewed-${slug}-side-raw-v1`, contentSha256: sha256(sideRaw) },
            identity: { contentSha256: target.photoHash },
          },
          clean: { contentSha256: sha256(crouchProcessed) },
          raw: { contentSha256: sha256(crouchRaw) },
        },
      },
    },
    sources: {
      crouch: {
        processed: { absolutePath: paths.crouchProcessed, contentSha256: sha256(crouchProcessed) },
        raw: { absolutePath: paths.crouchRaw, contentSha256: sha256(crouchRaw) },
      },
    },
  };
  const fighterBinding = { slug, ...target };
  const sideLineage = {
    bundleRunId: '33050000001',
    bundleId: sideBundle.descriptor.bundleId,
    reviewedDescriptorSha256: sideDescriptorSha256,
    processedSha256: sha256(sideProcessed),
    rawSha256: sha256(sideRaw),
  };
  const crouchLineage = {
    bundleRunId: '33050000002',
    bundleId: crouchBundle.descriptor.bundleId,
    reviewedDescriptorSha256: crouchDescriptorSha256,
    processedSha256: sha256(crouchProcessed),
    rawSha256: sha256(crouchRaw),
  };
  const qaEvidence = {
    schemaVersion: 1,
    evidenceType: 'global_mixed_canonical_human_review_v1',
    status: 'approved',
    decision: GLOBAL_MIXED_QA_DECISION,
    reviewedBy: 'qa-reviewer',
    reviewedAt: '2026-08-27T05:30:00.000Z',
    fighter: fighterBinding,
    side: {
      bundleRunId: sideLineage.bundleRunId,
      bundleId: sideLineage.bundleId,
      descriptorSha256: sideLineage.reviewedDescriptorSha256,
      processedSha256: sideLineage.processedSha256,
      rawSha256: sideLineage.rawSha256,
    },
    uprightAlias: {
      decision: GLOBAL_UPRIGHT_ALIAS_DECISION,
      processedSha256: sideLineage.processedSha256,
      rawSha256: sideLineage.rawSha256,
    },
    crouch: {
      bundleRunId: crouchLineage.bundleRunId,
      bundleId: crouchLineage.bundleId,
      descriptorSha256: crouchLineage.reviewedDescriptorSha256,
      processedSha256: crouchLineage.processedSha256,
      rawSha256: crouchLineage.rawSha256,
    },
    blockingFindings: [],
  };
  const qaPath = join(directory, 'qa-evidence.json');
  const qaBytes = Buffer.from(JSON.stringify(qaEvidence));
  writeFileSync(qaPath, qaBytes);
  const plan = {
    schemaVersion: 1,
    planType: 'global_reviewed_mixed_canonical_set_v1',
    fighter: fighterBinding,
    side: sideLineage,
    uprightAlias: {
      decision: GLOBAL_UPRIGHT_ALIAS_DECISION,
      fromProcessedSha256: sideLineage.processedSha256,
      fromRawSha256: sideLineage.rawSha256,
    },
    crouch: crouchLineage,
    qaEvidence: { path: 'qa-evidence.json', contentSha256: sha256(qaBytes) },
    safety: {
      providerCalls: 0,
      generationStarted: false,
      activated: false,
      preexistingSourceOverwrite: false,
      allowedSourcePosts: SOURCE_KINDS,
    },
  };
  const planPath = join(directory, 'assembly-plan.json');
  const planBytes = Buffer.from(JSON.stringify(plan));
  writeFileSync(planPath, planBytes);
  return {
    directory, outputDirectory, sideBundleDirectory, crouchBundleDirectory, fighter, target,
    sideBundle, crouchBundle, plan, planPath, planSha256: sha256(planBytes), qaPath,
    sideProcessed, sideRaw, crouchProcessed, crouchRaw,
  };
}

function apiFixture(value, options = {}) {
  const current = Object.fromEntries(SOURCE_KINDS.map((kind) => [kind, null]));
  const preexistingKind = options.preexistingKind ?? options.pointerWithoutHashKind;
  if (preexistingKind) {
    const bytes = png(`preexisting-${preexistingKind}`);
    current[preexistingKind] = record(preexistingKind, '9'.repeat(32), bytes, value.target.fighterId);
  }
  const versionIds = Object.fromEntries(SOURCE_KINDS.map((kind, index) => [
    kind,
    String.fromCharCode(97 + index).repeat(32),
  ]));
  const assetPath = (entry) => `/assets/${entry.blobKey}`;
  const detail = () => ({
    fighter: {
      id: value.target.fighterId,
      name: value.target.name,
      photoHash: value.target.photoHash,
      qualityTier: 'champion',
      public: false,
      sources: {
        original: 'https://api.example/assets/original.png',
        ...Object.fromEntries(SOURCE_KINDS.map((kind) => [
          RESPONSE_KEYS[kind],
          current[kind] ? `https://api.example${assetPath(current[kind])}` : null,
        ])),
      },
      sourceHashes: {
        original: value.target.photoHash,
        ...Object.fromEntries(SOURCE_KINDS.map((kind) => [
          kind, kind === options.pointerWithoutHashKind
            ? null
            : current[kind]?.contentSha256 ?? null,
        ])),
      },
    },
  });
  let posts = 0;
  let committedAmbiguousPost = false;
  const requestApi = vi.fn(async (path, init = {}) => {
    if (path === '/api/admin/arcade') {
      return { fighters: [{ slug: value.plan.fighter.slug, fighterId: value.target.fighterId, status: 'draft' }] };
    }
    if (path === `/api/fighters/${value.target.fighterId}` && !init.method) return detail();
    if (path === `/api/fighters/${value.target.fighterId}/sources` && init.method === 'POST') {
      posts += 1;
      if (options.throwOnFirstPost && posts === 1) throw new Error('simulated ambiguous mutation');
      const kind = init.body.get('kind');
      const bytes = Buffer.from(await init.body.get('file').arrayBuffer());
      current[kind] = record(kind, versionIds[kind], bytes, value.target.fighterId);
      if (options.throwAfterCommittedPostKind === kind && !committedAmbiguousPost) {
        committedAmbiguousPost = true;
        throw new Error('simulated committed mutation with ambiguous response');
      }
      return detail();
    }
    throw new Error(`Unexpected API request ${init.method ?? 'GET'} ${path}`);
  });
  const requestAsset = vi.fn(async (path) => {
    const entry = Object.values(current).find((candidate) => candidate && assetPath(candidate) === path);
    if (!entry) return new Response('missing', { status: 404 });
    return new Response(entry.bytes, {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(entry.bytes.byteLength) },
    });
  });
  return { current, requestApi, requestAsset, get posts() { return posts; } };
}

function record(kind, versionId, bytes, fighterId) {
  return {
    versionId,
    blobKey: `users/${OWNER_ID}/fighters/${fighterId}/sources/${kind}_${versionId}.png`,
    contentSha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bytes,
  };
}

function runOptions(value, api) {
  return {
    confirmation: GLOBAL_MIXED_IMPORT_CONFIRMATION,
    safetyConfirmation: GLOBAL_MIXED_IMPORT_SAFETY_CONFIRMATION,
    reviewedBy: 'qa-reviewer',
    assemblyPlanPath: value.planPath,
    assemblyPlanSha256: value.planSha256,
    sideBundleDirectory: value.sideBundleDirectory,
    crouchBundleDirectory: value.crouchBundleDirectory,
    outputDirectory: value.outputDirectory,
    rosterPath,
    workerUrl: 'https://api.example',
    requestApi: api.requestApi,
    requestAsset: api.requestAsset,
    loadReviewedBundle: ({ bundleDirectory }) => (
      bundleDirectory === value.sideBundleDirectory ? value.sideBundle : value.crouchBundle
    ),
    validateReviewedBundle: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('reviewed global SIDE alias + CROUCH importer', () => {
  it('keeps prepare/generate/import workflows explicit, review-gated, private, and source-only', () => {
    const prepare = readFileSync(new URL(
      '../.github/workflows/prepare-reviewed-global-crouch-input-private.yml',
      import.meta.url,
    ), 'utf8');
    const generate = readFileSync(new URL(
      '../.github/workflows/generate-xai-canonical-bundle-private.yml',
      import.meta.url,
    ), 'utf8');
    const importer = readFileSync(new URL(
      '../.github/workflows/import-reviewed-global-mixed-canonical-production.yml',
      import.meta.url,
    ), 'utf8');
    expect(prepare).toContain('APPROVE_REVIEWED_GLOBAL_SIDE_FOR_CROUCH_V1');
    expect(prepare).toContain('PREPARE_GLOBAL_CROUCH_FROM_REVIEWED_SIDE_PRIVATE_V1');
    expect(prepare).toContain('wrangler r2 object put');
    expect(prepare.match(/wrangler r2 object get/g)).toHaveLength(3);
    expect(prepare).toContain('Generate one private XAI canonical bundle');
    expect(prepare).toContain('reviewed-global-crouch-input-receipt.json');
    expect(prepare).not.toMatch(/PIXCLI_API_KEY|FAL_API_KEY|GEMINI_API_KEY|\/generate|\/activate/);
    for (const [tuple, hash] of [
      ['rosalia:crouch)', 'e8b11ecca2a2a1fbb958c427804631ec7eed5f901ae00bd6117a5b7f87c1cb82'],
      ['ibai-llanos:crouch)', '76e68a0c698326333e070bf5c3901570f994a24584fe3b65bad25b13a985becc'],
      ['lamine-yamal:crouch)', '800a2b5a1c1a90749490497f5b06a92707b3a35ed4784627b22b186a952224cf'],
    ]) {
      expect(generate).toContain(tuple);
      expect(generate).toContain(hash);
    }
    expect(generate).toContain(".workflowName' <<<\"$prior\")\" == \"Generate one private XAI canonical bundle\"");
    expect(importer).toContain('APPROVE_GLOBAL_SIDE_ALIAS_AND_CROUCH_V1');
    expect(importer).toContain('IMPORT_REVIEWED_GLOBAL_MIXED_CANONICAL_SET_V1');
    expect(importer).toContain('SOURCES_ONLY_NO_PROVIDER_NO_GENERATION_NO_ACTIVATION');
    expect(importer).toContain('arcade:assemble:reviewed-global-mixed');
    expect(importer).toContain('arcade:import:reviewed-global-mixed-canonical');
    expect(importer).toContain('resume_import_run_id');
    expect(importer).toContain('Generate one private XAI canonical bundle');
    expect(importer).toContain('Import reviewed global SIDE alias and CROUCH');
    expect(importer).not.toMatch(/PIXCLI_API_KEY|FAL_API_KEY|GEMINI_API_KEY|\/generate|\/activate/);
  });

  it('assembles the exact two reviewed bundle lineages into a hash-bound source-only plan', () => {
    const value = fixture();
    const assemblyOutput = join(value.directory, 'assembled');
    const receipt = assembleReviewedGlobalMixedCanonicalSet({
      confirmation: ASSEMBLE_REVIEWED_GLOBAL_MIXED_CONFIRMATION,
      qaDecision: GLOBAL_MIXED_QA_DECISION,
      slug: 'rosalia',
      reviewedBy: 'qa-reviewer',
      reviewedAt: '2026-08-27T05:30:00.000Z',
      sideBundleDirectory: value.sideBundleDirectory,
      sideBundleRunId: value.plan.side.bundleRunId,
      reviewedSideDescriptorSha256: value.plan.side.reviewedDescriptorSha256,
      crouchBundleDirectory: value.crouchBundleDirectory,
      crouchBundleRunId: value.plan.crouch.bundleRunId,
      reviewedCrouchDescriptorSha256: value.plan.crouch.reviewedDescriptorSha256,
      rosterPath,
      outputDirectory: assemblyOutput,
      loadReviewedBundle: ({ bundleDirectory }) => (
        bundleDirectory === value.sideBundleDirectory ? value.sideBundle : value.crouchBundle
      ),
      validateReviewedBundle: vi.fn(),
    });
    const planBytes = readFileSync(receipt.assemblyPlanPath);
    const plan = JSON.parse(planBytes);
    expect(sha256(planBytes)).toBe(receipt.assemblyPlanSha256);
    expect(plan).toMatchObject({
      planType: 'global_reviewed_mixed_canonical_set_v1',
      fighter: { slug: 'rosalia', fighterId: value.target.fighterId, photoHash: value.target.photoHash },
      side: value.plan.side,
      uprightAlias: {
        decision: GLOBAL_UPRIGHT_ALIAS_DECISION,
        fromProcessedSha256: value.plan.side.processedSha256,
        fromRawSha256: value.plan.side.rawSha256,
      },
      crouch: value.plan.crouch,
      safety: {
        providerCalls: 0,
        generationStarted: false,
        activated: false,
        preexistingSourceOverwrite: false,
        allowedSourcePosts: SOURCE_KINDS,
      },
    });
    expect(receipt).toMatchObject({
      status: 'assembled_reviewed_sources_only',
      providerCalls: 0,
      generationStarted: false,
      imported: false,
      activated: false,
    });
  });

  it('imports exactly six reviewed sources, aliases exact bytes, and never generates or activates', async () => {
    const value = fixture();
    const api = apiFixture(value);
    const result = await runReviewedGlobalMixedCanonicalImport(runOptions(value, api));
    const posts = api.requestApi.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.map(([, init]) => init.body.get('kind'))).toEqual(SOURCE_KINDS);
    expect(result.reviewedManifest).toEqual({
      schemaVersion: 1,
      canonicalSourceMode: 'reviewed-current-v1',
      slug: 'rosalia',
      fighterId: value.target.fighterId,
      photoHash: value.target.photoHash,
      canonicalSourceHashes: {
        side: { processedSha256: sha256(value.sideProcessed), rawSha256: sha256(value.sideRaw) },
        upright: { processedSha256: sha256(value.sideProcessed), rawSha256: sha256(value.sideRaw) },
        crouch: { processedSha256: sha256(value.crouchProcessed), rawSha256: sha256(value.crouchRaw) },
      },
    });
    expect(assertReviewedCanonicalManifest(result.reviewedManifest, {
      slug: 'rosalia', fighterId: value.target.fighterId, photoHash: value.target.photoHash,
    })).toBe(result.reviewedManifest);
    expect(result.operatorManifest).toMatchObject({
      status: 'completed_sources_only',
      sideBundle: { descriptorSha256: value.plan.side.reviewedDescriptorSha256 },
      crouchBundle: {
        descriptorSha256: value.plan.crouch.reviewedDescriptorSha256,
        poseSha256: XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE.contentSha256,
        renderingSideRawSha256: value.plan.side.rawSha256,
        identityPhotoSha256: value.target.photoHash,
      },
      safety: {
        providerCalls: 0,
        generationStarted: false,
        activated: false,
        preexistingSourcesOverwritten: false,
      },
    });
    expect(api.requestApi.mock.calls.map(([path]) => path).join('\n'))
      .not.toMatch(/generate|provider|activate|approve/i);
  });

  it('fails closed before mutation when any reviewed lineage or current source is unexpected', async () => {
    const value = fixture();
    value.crouchBundle.descriptor.sources.crouch.references.rendering.contentSha256 = 'f'.repeat(64);
    let api = apiFixture(value);
    await expect(runReviewedGlobalMixedCanonicalImport(runOptions(value, api)))
      .rejects.toThrow(/Trump pose \+ exact SIDE raw \+ original identity/i);
    expect(api.posts).toBe(0);

    const currentValue = fixture();
    api = apiFixture(currentValue, { preexistingKind: 'side' });
    await expect(runReviewedGlobalMixedCanonicalImport(runOptions(currentValue, api)))
      .rejects.toThrow(/unreviewed current source/i);
    expect(api.posts).toBe(0);
  });

  it('never treats a legacy source pointer without a hash as an empty slot', async () => {
    const value = fixture();
    const api = apiFixture(value, { pointerWithoutHashKind: 'side' });
    await expect(runReviewedGlobalMixedCanonicalImport(runOptions(value, api)))
      .rejects.toThrow(/inconsistent current source pointer\/hash lineage/i);
    expect(api.posts).toBe(0);
  });

  it('preflights every local byte and never re-POSTs an ambiguous mutation', async () => {
    const tampered = fixture();
    writeFileSync(tampered.crouchBundle.sources.crouch.raw.absolutePath, png('tampered-crouch-raw'));
    let api = apiFixture(tampered);
    await expect(runReviewedGlobalMixedCanonicalImport(runOptions(tampered, api)))
      .rejects.toThrow(/crouch_raw local reviewed bytes changed/i);
    expect(api.posts).toBe(0);

    const ambiguous = fixture();
    api = apiFixture(ambiguous, { throwOnFirstPost: true });
    const options = runOptions(ambiguous, api);
    await expect(runReviewedGlobalMixedCanonicalImport(options)).rejects.toThrow(/outcome is unknown/i);
    expect(api.posts).toBe(1);
    await expect(runReviewedGlobalMixedCanonicalImport(options)).rejects.toThrow(/ambiguous prior POST/i);
    expect(api.posts).toBe(1);
  });

  it('reconciles a committed side_raw POST after an ambiguous response without re-posting it', async () => {
    const value = fixture();
    const api = apiFixture(value, { throwAfterCommittedPostKind: 'side_raw' });
    const options = runOptions(value, api);

    await expect(runReviewedGlobalMixedCanonicalImport(options))
      .rejects.toThrow(/side_raw POST outcome is unknown/i);
    expect(api.posts).toBe(2);
    expect(api.current.side_raw?.contentSha256).toBe(value.plan.side.rawSha256);

    const result = await runReviewedGlobalMixedCanonicalImport(options);

    expect(api.posts).toBe(6);
    expect(result.operatorManifest.safety.sourceMutationResults.side_raw).toEqual({
      status: 'reconciled',
      expectedSha256: value.plan.side.rawSha256,
    });
  });
});
