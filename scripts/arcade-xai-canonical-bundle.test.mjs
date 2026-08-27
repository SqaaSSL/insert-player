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
  XAI_CANONICAL_BUNDLE_CLEANUP,
  XAI_CANONICAL_BUNDLE_CONFIRMATION,
  XAI_CANONICAL_BUNDLE_MODEL,
  XAI_CANONICAL_BUNDLE_PRIVATE_CONFIRMATION,
  buildXaiCanonicalBundlePayload,
  loadXaiCanonicalPoseManifest,
  runXaiCanonicalBundle,
} from './arcade-xai-canonical-bundle.mjs';

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
        cost: options.jobCost ?? XAI_CANONICAL_BUNDLE_MODEL.auditedCostUsd,
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
        job: { job_id: jobId, status: 'completed', cost: 0.11 },
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
});
