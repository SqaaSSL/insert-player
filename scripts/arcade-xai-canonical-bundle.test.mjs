import { createHash } from 'node:crypto';
import {
  existsSync,
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
  XAI_CANONICAL_BUNDLE_CLEANUP,
  XAI_CANONICAL_BUNDLE_CONFIRMATION,
  XAI_CANONICAL_BUNDLE_MODEL,
  XAI_CANONICAL_BUNDLE_PRIVATE_CONFIRMATION,
  buildXaiCanonicalBundlePayload,
  loadXaiCanonicalPoseManifest,
  runXaiCanonicalBundle,
} from './arcade-xai-canonical-bundle.mjs';
import { buildXaiCanonicalContainerPlan } from './run-xai-canonical-bundle-container.mjs';
import {
  PRIVATE_INPUT_CONFIRMATION,
  packageXaiCanonicalInput,
} from './package-xai-canonical-input.mjs';

const roster = JSON.parse(readFileSync(new URL('../arcade/roster-2026.json', import.meta.url), 'utf8'));
const temporaryDirectories = [];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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

function makeFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'insert-player-canonical-bundle-'));
  temporaryDirectories.push(directory);
  const sourceDir = join(directory, 'sources');
  const poseDir = join(directory, 'pose-bundle');
  mkdirSync(sourceDir);
  mkdirSync(poseDir);
  const controlledRoster = structuredClone(roster);
  const fighter = controlledRoster.fighters.find((entry) => entry.slug === 'elon-musk');
  const identity = png('identity-elon', 256, 256);
  fighter.reference.sourceSha256 = sha256(identity);
  writeFileSync(join(sourceDir, 'elon-musk.png'), identity);
  const rosterPath = join(directory, 'roster.json');
  writeFileSync(rosterPath, JSON.stringify(controlledRoster));

  const approvals = { approved: {} };
  const references = {};
  for (const sourceName of ['side', 'upright', 'crouch']) {
    references[sourceName] = {};
    for (const role of ['pose', 'rendering']) {
      const id = `${sourceName}-${role}-reviewed-v1`;
      const bytes = png(id, role === 'pose' ? 768 : 921, role === 'pose' ? 1024 : 1152);
      const path = `${id}.png`;
      writeFileSync(join(poseDir, path), bytes);
      approvals.approved[id] = true;
      references[sourceName][role] = { id, path, bytes };
    }
  }
  const evidenceBytes = Buffer.from(JSON.stringify(approvals));
  writeFileSync(join(poseDir, 'approval.json'), evidenceBytes);
  const describe = (entry) => ({
    id: entry.id,
    path: entry.path,
    contentSha256: sha256(entry.bytes),
    sizeBytes: entry.bytes.byteLength,
    width: entry.bytes.readUInt32BE(16),
    height: entry.bytes.readUInt32BE(20),
    approvalEvidence: {
      path: 'approval.json',
      contentSha256: sha256(evidenceBytes),
      selector: `approved.${entry.id}`,
      expectedValue: true,
    },
  });
  const poseManifest = {
    schemaVersion: 1,
    manifestId: 'arcade-xai-canonical-pose-bundle-test-v1',
    status: 'human_reviewed',
    referenceOrder: [
      'pose_composition_master',
      'canonical_rendering_master',
      'identity_photo',
    ],
    sources: Object.fromEntries(['side', 'upright', 'crouch'].map((sourceName) => [sourceName, {
      pose: describe(references[sourceName].pose),
      rendering: describe(references[sourceName].rendering),
    }])),
  };
  const poseManifestBytes = Buffer.from(JSON.stringify(poseManifest));
  const poseManifestPath = join(poseDir, 'pose-manifest.json');
  writeFileSync(poseManifestPath, poseManifestBytes);
  return {
    directory,
    sourceDir,
    rosterPath,
    poseDir,
    poseManifest,
    poseManifestPath,
    poseManifestSha256: sha256(poseManifestBytes),
    statePath: join(directory, 'state.json'),
    outputDirectory: join(directory, 'output'),
    fighter,
  };
}

function commandFixture() {
  return vi.fn((binary, args) => {
    if (args[0] === '-version') {
      return { stdout: `ffmpeg version ${XAI_CANONICAL_BUNDLE_CLEANUP.ffmpegVersion} Copyright\n`, stderr: '' };
    }
    const outputPath = args.at(-1);
    const contact = args.includes('-filter_complex');
    writeFileSync(outputPath, png(contact ? 'contact-sheet' : 'clean-source', contact ? 1152 : 128, contact ? 1024 : 192));
    return { stdout: '', stderr: '' };
  });
}

function providerFixture(options = {}) {
  const uploads = new Map();
  const jobs = new Map();
  const artifacts = new Map();
  let uploadCount = 0;
  let jobCount = 0;
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/models') {
      return new Response(JSON.stringify({ models: [{
        id: XAI_CANONICAL_BUNDLE_MODEL.id,
        provider: XAI_CANONICAL_BUNDLE_MODEL.provider,
        backend: XAI_CANONICAL_BUNDLE_MODEL.backend,
        cost_per_image: options.catalogCost ?? XAI_CANONICAL_BUNDLE_MODEL.catalogCostPerImage,
        advanced_mode: true,
        capabilities: ['edit', 'image-to-image'],
      }] }), { status: 200 });
    }
    if (init.method === 'POST' && parsed.pathname === '/api/v1/uploads') {
      uploadCount += 1;
      const hash = uploadCount.toString(16).padStart(32, '0');
      uploads.set(hash, true);
      return new Response(JSON.stringify({
        hash,
        url: `https://pixcli.example/assets/${hash}`,
        mime_type: 'image/png',
        size: 64,
      }), { status: 201 });
    }
    if (init.method === 'POST' && parsed.pathname === '/api/v1/edit/advanced') {
      jobCount += 1;
      if (options.submitThrows && jobCount === 1) throw new Error('connection reset');
      const jobId = `job-${jobCount}`;
      jobs.set(jobId, JSON.parse(init.body));
      return new Response(JSON.stringify({ job_id: jobId, status: 'pending' }), { status: 202 });
    }
    const jobMatch = parsed.pathname.match(/^\/api\/v1\/jobs\/(job-[0-9]+)$/);
    if (jobMatch) {
      return new Response(JSON.stringify({
        job_id: jobMatch[1],
        status: 'completed',
        cost: Object.hasOwn(options, 'jobCost')
          ? options.jobCost
          : XAI_CANONICAL_BUNDLE_MODEL.auditedCostUsd,
      }), { status: 200 });
    }
    const canvaMatch = parsed.pathname.match(/^\/api\/v1\/jobs\/(job-[0-9]+)\/canva$/);
    if (canvaMatch) {
      const jobId = canvaMatch[1];
      const input = jobs.get(jobId);
      const request = Buffer.from(JSON.stringify(input));
      const response = Buffer.from(JSON.stringify({ images: [`${jobId}.png`] }));
      const image = png(`raw-${jobId}`, 1024, 1536);
      artifacts.set(`${jobId}-request`, request);
      artifacts.set(`${jobId}-response`, response);
      artifacts.set(`${jobId}-image`, image);
      const asset = (kind, bytes, mimeType) => ({
        hash: sha256(bytes).slice(0, 32),
        url: `https://pixcli.example/artifacts/${jobId}-${kind}`,
        mime_type: mimeType,
        metadata: kind === 'image' ? { content_sha256: sha256(bytes) } : {
          artifact_kind: kind === 'request' ? 'provider_request' : 'provider_response',
          content_sha256: sha256(bytes),
          provider_request_id: `fal-${jobId}`,
        },
      });
      return new Response(JSON.stringify({
        job: {
          job_id: jobId,
          status: 'completed',
          cost: Object.hasOwn(options, 'canvaCost')
            ? options.canvaCost
            : XAI_CANONICAL_BUNDLE_MODEL.auditedCostUsd,
        },
        input,
        provider_runs: [{
          provider: XAI_CANONICAL_BUNDLE_MODEL.backend,
          modelId: XAI_CANONICAL_BUNDLE_MODEL.id,
          requestId: `fal-${jobId}`,
        }],
        assets: [
          asset('request', request, 'application/json'),
          asset('response', response, 'application/json'),
          asset('image', image, 'image/png'),
        ],
      }), { status: 200 });
    }
    const artifactMatch = parsed.pathname.match(/^\/artifacts\/(job-[0-9]+)-(request|response|image)$/);
    if (artifactMatch) {
      return new Response(artifacts.get(`${artifactMatch[1]}-${artifactMatch[2]}`), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  });
  return { fetchImpl, jobs, uploads };
}

function runOptions(fixture, provider, runCommand = commandFixture()) {
  return {
    confirmation: XAI_CANONICAL_BUNDLE_CONFIRMATION,
    privateConfirmation: XAI_CANONICAL_BUNDLE_PRIVATE_CONFIRMATION,
    maxCostUsd: 0.36,
    slug: 'elon-musk',
    apiKey: 'test-key',
    apiBase: 'https://pixcli.example',
    manifestPath: fixture.rosterPath,
    sourceDir: fixture.sourceDir,
    poseManifestPath: fixture.poseManifestPath,
    poseManifestSha256: fixture.poseManifestSha256,
    statePath: fixture.statePath,
    outputDirectory: fixture.outputDirectory,
    fetchImpl: provider.fetchImpl,
    runCommand,
    sleepImpl: async () => {},
    pollIntervalMs: 1,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('sealed XAI canonical bundle inputs', () => {
  it('provides a supported exact 5.1.9 container command with private read-only inputs', () => {
    const fixture = makeFixture();
    const writableRoot = mkdtempSync(join(tmpdir(), 'insert-player-canonical-container-output-'));
    temporaryDirectories.push(writableRoot);
    const statePath = join(writableRoot, 'state.json');
    const outputDirectory = join(writableRoot, 'bundle');
    const plan = buildXaiCanonicalContainerPlan([
      '--execute',
      '--slug=elon-musk',
      `--manifest=${fixture.rosterPath}`,
      `--source-dir=${fixture.sourceDir}`,
      `--pose-manifest=${fixture.poseManifestPath}`,
      `--pose-manifest-sha256=${fixture.poseManifestSha256}`,
      `--state=${statePath}`,
      `--output-dir=${outputDirectory}`,
      `--confirm=${XAI_CANONICAL_BUNDLE_CONFIRMATION}`,
      `--confirm-private=${XAI_CANONICAL_BUNDLE_PRIVATE_CONFIRMATION}`,
      '--max-cost-usd=0.36',
    ], { repositoryRoot: fixture.directory, uid: 501, gid: 20 });
    expect(plan.build).toContain('media-runtime');
    expect(plan.run).toContain('insert-player-xai-canonical-media-runtime:v1');
    expect(plan.run).toContain(`${fixture.sourceDir}:/private-sources:ro`);
    expect(plan.run).toContain(`${fixture.poseDir}:/private-pose:ro`);
    expect(plan.run).toContain(`${writableRoot}:/private-work`);
    expect(plan.run).toContain('--state=/private-work/state.json');
    expect(plan.run).toContain('--output-dir=/private-work/bundle');
    expect(plan.run).toContain('PIXCLI_API_KEY');
    expect(plan.run.join(' ')).not.toContain('test-key');
  });

  it('publishes the exact private artifact consumed by the separate reviewed importer', () => {
    const generation = readFileSync(new URL(
      '../.github/workflows/generate-xai-canonical-bundle-private.yml',
      import.meta.url,
    ), 'utf8');
    const reviewedImport = readFileSync(new URL(
      '../.github/workflows/import-reviewed-xai-canonical-production.yml',
      import.meta.url,
    ), 'utf8');
    expect(generation).toContain('temp/arcade-xai-canonical-inputs-v1/$REQUESTED_SLUG/');
    expect(generation).toContain('printf \'%s  %s\\n\' "$INPUT_BUNDLE_SHA256" "$archive" | sha256sum --check --strict');
    expect(generation).toContain('printf \'%s  %s\\n\' "$POSE_MANIFEST_SHA256" "$input_root/pose/pose-manifest.json" | sha256sum --check --strict');
    expect(generation).toContain('ffmpeg=7:5.1.9-0+deb12u1');
    expect(generation).toContain('--max-cost-usd="$MAX_COST_USD"');
    expect(generation).toContain('name: arcade-xai-canonical-bundle-${{ inputs.slug }}');
    expect(generation).toContain('name: arcade-xai-canonical-bundle-checkpoint-${{ inputs.slug }}');
    expect(generation).not.toMatch(/\/api\/fighters|\/approve(?:\/|\s|$)|--activate/);
    expect(reviewedImport).toContain('--name "arcade-xai-canonical-bundle-$REQUESTED_SLUG"');
    expect(reviewedImport).toContain('name: arcade-reviewed-canonical-manifest-${{ inputs.slug }}');
  });

  it('requires a hash-bound reviewed pose manifest with exact artifacts and evidence', () => {
    const fixture = makeFixture();
    const loaded = loadXaiCanonicalPoseManifest(fixture.poseManifestPath, fixture.poseManifestSha256);
    expect(Object.keys(loaded.sources)).toEqual(['side', 'upright', 'crouch']);
    expect(loaded.sources.crouch.pose.contentSha256).toMatch(/^[a-f0-9]{64}$/);

    writeFileSync(join(fixture.poseDir, fixture.poseManifest.sources.upright.pose.path), png('tampered'));
    expect(() => loadXaiCanonicalPoseManifest(
      fixture.poseManifestPath,
      fixture.poseManifestSha256,
    )).toThrow(/descriptor/i);
  });

  it('accepts only affirmative approval evidence and requires the selector to exist', () => {
    for (const expectedValue of [false, null, 'pending', { approved: true }]) {
      const fixture = makeFixture();
      fixture.poseManifest.sources.side.pose.approvalEvidence.expectedValue = expectedValue;
      const bytes = Buffer.from(JSON.stringify(fixture.poseManifest));
      writeFileSync(fixture.poseManifestPath, bytes);
      expect(() => loadXaiCanonicalPoseManifest(
        fixture.poseManifestPath,
        sha256(bytes),
      )).toThrow(/not an affirmative sealed decision/i);
    }
    const fixture = makeFixture();
    fixture.poseManifest.sources.side.pose.approvalEvidence.selector = 'approved.missing-reference';
    fixture.poseManifest.sources.side.pose.approvalEvidence.expectedValue = true;
    const bytes = Buffer.from(JSON.stringify(fixture.poseManifest));
    writeFileSync(fixture.poseManifestPath, bytes);
    expect(() => loadXaiCanonicalPoseManifest(
      fixture.poseManifestPath,
      sha256(bytes),
    )).toThrow(/selector does not exist/i);
  });

  it('orders three distinct references and disables enrichment, publishing, retries, and fallback', () => {
    const fixture = makeFixture();
    const payload = buildXaiCanonicalBundlePayload({
      fighter: fixture.fighter,
      sourceName: 'crouch',
      poseAssetHash: '1'.repeat(32),
      renderingAssetHash: '2'.repeat(32),
      identityAssetHash: '3'.repeat(32),
    });
    expect(payload.image).toEqual(['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)]);
    expect(payload.model).toBe('grok-imagine-image-2-edit');
    expect(payload.params.num_images).toBe(1);
    expect(payload).toMatchObject({ enrich_prompt: false, search: false, publish: false });
    expect(payload.prompt).toContain('deep but anatomically balanced crouching guard');
    expect(JSON.stringify(payload)).not.toMatch(/fallback|retry/i);
  });

  it('fails before provider access when confirmation, cap, manifest hash, or toolchain is wrong', async () => {
    const fixture = makeFixture();
    const provider = providerFixture();
    const base = runOptions(fixture, provider);
    await expect(runXaiCanonicalBundle({ ...base, maxCostUsd: 0.37 })).rejects.toThrow(/0\.36/);
    await expect(runXaiCanonicalBundle({ ...base, poseManifestSha256: '0'.repeat(64) })).rejects.toThrow(/manifest SHA/i);
    await expect(runXaiCanonicalBundle({
      ...base,
      runCommand: () => ({ stdout: 'ffmpeg version 7.0 unknown\n', stderr: '' }),
    })).rejects.toThrow(/toolchain/i);
    expect(provider.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('resumable exactly-once XAI canonical bundle', () => {
  it('produces three raw/clean pairs, a contact sheet, and a sealed private review descriptor', async () => {
    const fixture = makeFixture();
    const provider = providerFixture();
    const result = await runXaiCanonicalBundle(runOptions(fixture, provider));
    const paidPosts = provider.fetchImpl.mock.calls.filter(([url, init]) => (
      new URL(url).pathname === '/api/v1/edit/advanced' && init.method === 'POST'
    ));
    expect(paidPosts).toHaveLength(3);
    expect([...provider.jobs.values()].map((payload) => payload.publish_name)).toEqual([
      'ip-canonical-v1-elon-musk-side',
      'ip-canonical-v1-elon-musk-upright',
      'ip-canonical-v1-elon-musk-crouch',
    ]);
    expect([...provider.jobs.values()].every((payload) => payload.image.length === 3)).toBe(true);
    expect(result.state.status).toBe('awaiting_human_review');
    expect(result.descriptor.provider).toMatchObject({
      paidCalls: 3,
      auditedCostPerOutputUsd: 0.11,
      maximumCostPerOutputUsd: 0.12,
      maximumBundleCostUsd: 0.36,
      actualCostUsd: 0.33,
    });
    expect(result.descriptor.policy).toMatchObject({
      automaticRetries: 0,
      fallback: 'none',
      outputVisibility: 'private_local',
      import: false,
      activation: false,
      humanReviewRequired: true,
    });
    expect(result.descriptor.contactSheet).toMatchObject({ width: 1152, height: 1024 });
    for (const sourceName of ['side', 'upright', 'crouch']) {
      expect(readFileSync(join(fixture.outputDirectory, 'sources', `${sourceName}_raw.png`))).toBeTruthy();
      expect(readFileSync(join(fixture.outputDirectory, 'sources', `${sourceName}.png`))).toBeTruthy();
    }
    expect(readFileSync(join(fixture.outputDirectory, 'review-descriptor.json'))).toBeTruthy();
  });

  it('resumes a completed bundle without another provider request or upload', async () => {
    const fixture = makeFixture();
    const provider = providerFixture();
    const options = runOptions(fixture, provider);
    await runXaiCanonicalBundle(options);
    const callsAfterFirstRun = provider.fetchImpl.mock.calls.length;
    await runXaiCanonicalBundle(options);
    expect(provider.fetchImpl.mock.calls).toHaveLength(callsAfterFirstRun);
    const paidPosts = provider.fetchImpl.mock.calls.filter(([url, init]) => (
      new URL(url).pathname === '/api/v1/edit/advanced' && init.method === 'POST'
    ));
    expect(paidPosts).toHaveLength(3);
  });

  it('serializes concurrent invocations before state, output, or provider mutation', async () => {
    const fixture = makeFixture();
    const provider = providerFixture();
    const options = runOptions(fixture, provider);
    const results = await Promise.allSettled([
      runXaiCanonicalBundle(options),
      runXaiCanonicalBundle(options),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(results.find(({ status }) => status === 'rejected').reason.message).toMatch(/lock exists.*manual reconciliation/i);
    const paidPosts = provider.fetchImpl.mock.calls.filter(([url, init]) => (
      new URL(url).pathname === '/api/v1/edit/advanced' && init.method === 'POST'
    ));
    expect(paidPosts).toHaveLength(3);
    expect(existsSync(`${fixture.statePath}.lock`)).toBe(false);
    expect(existsSync(`${fixture.outputDirectory}.lock`)).toBe(false);
  });

  it('never deletes or bypasses a stale lock automatically', async () => {
    const fixture = makeFixture();
    const provider = providerFixture();
    const staleLock = `${fixture.statePath}.lock`;
    writeFileSync(staleLock, JSON.stringify({ nonce: 'manual-reconciliation-required' }));
    await expect(runXaiCanonicalBundle(runOptions(fixture, provider)))
      .rejects.toThrow(/lock exists.*manual reconciliation/i);
    expect(existsSync(staleLock)).toBe(true);
    expect(provider.fetchImpl).not.toHaveBeenCalled();
  });

  it('records an ambiguous POST before failure and never re-POSTs that source', async () => {
    const fixture = makeFixture();
    const provider = providerFixture({ submitThrows: true });
    const options = runOptions(fixture, provider);
    await expect(runXaiCanonicalBundle(options)).rejects.toThrow(/automatic retry is forbidden/i);
    expect(JSON.parse(readFileSync(fixture.statePath, 'utf8')).slots.side.status).toBe('submission_outcome_unknown');
    const paidCalls = () => provider.fetchImpl.mock.calls.filter(([url, init]) => (
      new URL(url).pathname === '/api/v1/edit/advanced' && init.method === 'POST'
    )).length;
    expect(paidCalls()).toBe(1);
    await expect(runXaiCanonicalBundle(options)).rejects.toThrow(/ambiguous POST/i);
    expect(paidCalls()).toBe(1);
  });

  it('resumes provider-completed work in the approved cleanup toolchain without another POST', async () => {
    const fixture = makeFixture();
    const provider = providerFixture();
    let failedCleanup = false;
    const crashingCleanup = vi.fn((binary, args) => {
      if (args[0] === '-version') {
        return { stdout: `ffmpeg version ${XAI_CANONICAL_BUNDLE_CLEANUP.ffmpegVersion} Copyright\n`, stderr: '' };
      }
      if (!failedCleanup && !args.includes('-filter_complex')) {
        failedCleanup = true;
        throw new Error('simulated host cleanup crash');
      }
      const outputPath = args.at(-1);
      const contact = args.includes('-filter_complex');
      writeFileSync(outputPath, png(contact ? 'contact-sheet' : 'clean-source', contact ? 1152 : 128, contact ? 1024 : 192));
      return { stdout: '', stderr: '' };
    });
    await expect(runXaiCanonicalBundle(runOptions(fixture, provider, crashingCleanup)))
      .rejects.toThrow(/simulated host cleanup crash/i);
    expect(JSON.parse(readFileSync(fixture.statePath, 'utf8')).slots.side.status).toBe('provider_completed');
    await runXaiCanonicalBundle(runOptions(fixture, provider));
    const paidPosts = provider.fetchImpl.mock.calls.filter(([url, init]) => (
      new URL(url).pathname === '/api/v1/edit/advanced' && init.method === 'POST'
    ));
    expect(paidPosts).toHaveLength(3);
  });

  it('rejects model or audited-price drift before uploads or paid calls', async () => {
    const fixture = makeFixture();
    const provider = providerFixture({ catalogCost: 120000 });
    await expect(runXaiCanonicalBundle(runOptions(fixture, provider))).rejects.toThrow(/price changed/i);
    const posts = provider.fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST');
    expect(posts).toHaveLength(0);
  });

  it('stops the bundle when the terminal charge is not exactly the audited $0.11', async () => {
    const fixture = makeFixture();
    const provider = providerFixture({ jobCost: 0.12 });
    await expect(runXaiCanonicalBundle(runOptions(fixture, provider))).rejects.toThrow(/audited \$0\.11/i);
    const paidPosts = provider.fetchImpl.mock.calls.filter(([url, init]) => (
      new URL(url).pathname === '/api/v1/edit/advanced' && init.method === 'POST'
    ));
    expect(paidPosts).toHaveLength(1);
  });

  it.each([
    ['job null', { jobCost: null }],
    ['job string', { jobCost: '0.11' }],
    ['job NaN', { jobCost: Number.NaN }],
    ['Canva null', { canvaCost: null }],
    ['Canva string', { canvaCost: '0.11' }],
    ['Canva NaN', { canvaCost: Number.NaN }],
  ])('rejects unproved %s cost values', async (_label, overrides) => {
    const fixture = makeFixture();
    const provider = providerFixture(overrides);
    await expect(runXaiCanonicalBundle(runOptions(fixture, provider))).rejects.toThrow(/\$0\.11/i);
  });
});

describe('portable private canonical input packaging', () => {
  it('rewrites reviewed references into a sealed portable tree and creates a private R2 handoff', () => {
    const fixture = makeFixture();
    const outputDirectory = join(fixture.directory, 'portable-input');
    const receipt = packageXaiCanonicalInput({
      confirmation: PRIVATE_INPUT_CONFIRMATION,
      slug: 'elon-musk',
      rosterPath: fixture.rosterPath,
      sourceDir: fixture.sourceDir,
      poseManifestPath: fixture.poseManifestPath,
      poseManifestSha256: fixture.poseManifestSha256,
      outputDirectory,
    });
    expect(receipt).toMatchObject({
      status: 'prepared_private_local',
      slug: 'elon-musk',
      originalSha256: fixture.fighter.reference.sourceSha256,
      sourcePoseManifestSha256: fixture.poseManifestSha256,
      r2Bucket: 'insert-player-assets',
      r2Jurisdiction: 'eu',
      lifecyclePrefix: 'temp/',
      uploaded: false,
      providerCalled: false,
    });
    expect(receipt.r2Key).toMatch(/^temp\/arcade-xai-canonical-inputs-v1\/elon-musk\/elon-musk--[a-f0-9]{16}\.tar\.gz$/);
    expect(sha256(readFileSync(receipt.archivePath))).toBe(receipt.archiveSha256);
    const portablePose = join(outputDirectory, 'staging/canonical-input-v1/pose/pose-manifest.json');
    const portable = loadXaiCanonicalPoseManifest(portablePose, receipt.portablePoseManifestSha256);
    expect(portable.manifest.sources.side.pose.path).toMatch(/^references\/[a-f0-9]{64}\.png$/);
    expect(portable.manifest.sources.side.pose.approvalEvidence.path).toMatch(/^evidence\/[a-f0-9]{64}\.json$/);
    expect(readFileSync(join(outputDirectory, 'staging/canonical-input-v1/sources/elon-musk.png'))).toEqual(
      readFileSync(join(fixture.sourceDir, 'elon-musk.png')),
    );
  });

  it('fails before producing an archive when the reviewed pose seal is wrong', () => {
    const fixture = makeFixture();
    const outputDirectory = join(fixture.directory, 'portable-input');
    expect(() => packageXaiCanonicalInput({
      confirmation: PRIVATE_INPUT_CONFIRMATION,
      slug: 'elon-musk',
      rosterPath: fixture.rosterPath,
      sourceDir: fixture.sourceDir,
      poseManifestPath: fixture.poseManifestPath,
      poseManifestSha256: '0'.repeat(64),
      outputDirectory,
    })).toThrow(/pose manifest SHA-256 mismatch/i);
    expect(existsSync(join(outputDirectory, 'elon-musk--canonical-input-v1.tar.gz'))).toBe(false);
  });
});
