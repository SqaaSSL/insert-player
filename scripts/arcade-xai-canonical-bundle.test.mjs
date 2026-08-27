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
  XAI_CANONICAL_BUNDLE_CLEANUP_FIXTURE,
  XAI_CANONICAL_BUNDLE_CONFIRMATION,
  XAI_CANONICAL_BUNDLE_LEGACY_CLEANUP,
  XAI_CANONICAL_BUNDLE_MODEL,
  XAI_CANONICAL_BUNDLE_PRIVATE_CONFIRMATION,
  XAI_CANONICAL_BUNDLE_RECLEAN_CONFIRMATION,
  XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE,
  XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE,
  XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_SHA256_BY_SLUG,
  XAI_CANONICAL_GLOBAL_SIDE_PROMPT_PROFILE,
  XAI_CANONICAL_GLOBAL_SIDE_PROMPT_SHA256_BY_SLUG,
  XAI_CANONICAL_GLOBAL_SIDE_REFERENCES,
  XAI_CANONICAL_GLOBAL_SIDE_SLUGS,
  XAI_CANONICAL_PIXCLI_PROMPT_MAX,
  XAI_CANONICAL_SINGLE_SOURCE_CONFIRMATION,
  XAI_CANONICAL_SINGLE_SOURCE_PROMPT_PROFILE,
  XAI_CANONICAL_SINGLE_SOURCE_PROMPT_SHA256,
  assertXaiCanonicalPromptFitsPixcliSchema,
  buildXaiCanonicalBundlePayload,
  buildXaiCanonicalBundlePrompt,
  loadXaiCanonicalPoseManifest,
  parseXaiCanonicalBundleCliArgs,
  recleanXaiCanonicalBundle,
  resolveXaiCanonicalSingleSourcePromptProfile,
  runXaiCanonicalBundle,
  verifyCanonicalCleanupFixture,
  validateXaiCanonicalPromptProfileReferences,
} from './arcade-xai-canonical-bundle.mjs';
import { parseXaiCanonicalRecleanCliArgs } from './reclean-xai-canonical-bundle.mjs';
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

function makeFixture(slug = 'elon-musk') {
  const directory = mkdtempSync(join(tmpdir(), 'insert-player-canonical-bundle-'));
  temporaryDirectories.push(directory);
  const sourceDir = join(directory, 'sources');
  const poseDir = join(directory, 'pose-bundle');
  mkdirSync(sourceDir);
  mkdirSync(poseDir);
  const controlledRoster = structuredClone(roster);
  const fighter = controlledRoster.fighters.find((entry) => entry.slug === slug);
  const identity = png(`identity-${slug}`, 256, 256);
  fighter.reference.sourceSha256 = sha256(identity);
  writeFileSync(join(sourceDir, `${slug}.png`), identity);
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
    const contact = args.includes('[review]');
    const contactInputs = args.filter((arg) => arg === '-i').length;
    writeFileSync(
      outputPath,
      png(
        contact ? 'contact-sheet' : 'clean-source',
        contact ? (contactInputs === 2 ? 768 : 1152) : 128,
        contact ? (contactInputs === 2 ? 512 : 1024) : 192,
      ),
    );
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
          : XAI_CANONICAL_BUNDLE_MODEL.auditedCostMicrocredits,
      }), { status: 200 });
    }
    const canvaMatch = parsed.pathname.match(/^\/api\/v1\/jobs\/(job-[0-9]+)\/canva$/);
    if (canvaMatch) {
      const jobId = canvaMatch[1];
      const submitted = jobs.get(jobId);
      const imageUrls = submitted.image.map((hash) => `https://pixcli.example/api/v1/assets/${hash}`);
      let input = {
        ...submitted,
        image_url: imageUrls[0],
        image_urls: imageUrls,
        enriched_prompt: submitted.prompt,
      };
      input = options.mutateCanvaInput?.(structuredClone(input)) ?? input;
      let providerRequest = {
        model: XAI_CANONICAL_BUNDLE_MODEL.endpoint,
        input: {
          ...submitted.params,
          prompt: submitted.prompt,
          image_urls: imageUrls,
        },
        retry_policy: 'none',
        fallback_policy: 'none',
      };
      providerRequest = options.mutateProviderRequest?.(structuredClone(providerRequest)) ?? providerRequest;
      const request = Buffer.from(JSON.stringify(providerRequest));
      const image = png(`raw-${jobId}`, 1024, 1536);
      const sourceUrl = `https://v3b.fal.media/files/test/${jobId}.png`;
      let providerResponse = {
        images: [{
          url: sourceUrl,
          content_type: 'image/png',
          file_name: `${jobId}.png`,
          file_size: null,
          width: 1024,
          height: 1536,
        }],
        revised_prompt: null,
      };
      providerResponse = options.mutateProviderResponse?.(structuredClone(providerResponse)) ?? providerResponse;
      const response = Buffer.from(JSON.stringify(providerResponse));
      const asset = (kind, bytes, mimeType) => ({
        hash: sha256(bytes).slice(0, 32),
        url: `https://pixcli.example/api/v1/assets/${sha256(bytes).slice(0, 32)}`,
        mime_type: mimeType,
        size_bytes: bytes.byteLength,
        width: kind === 'image' ? 1024 : null,
        height: kind === 'image' ? 1536 : null,
        metadata: kind === 'image' ? {
          ...(options.includeImageContentSha ? { content_sha256: sha256(bytes) } : {}),
          model: XAI_CANONICAL_BUNDLE_MODEL.id,
          prompt: submitted.prompt,
          source_url: sourceUrl,
        } : {
          artifact_kind: kind === 'request' ? 'provider_request' : 'provider_response',
          content_sha256: sha256(bytes),
          model: XAI_CANONICAL_BUNDLE_MODEL.id,
          ...(kind === 'response' ? { provider_request_id: `fal-${jobId}` } : {}),
        },
      });
      const assets = [
        asset('request', request, 'application/json'),
        asset('response', response, 'application/json'),
        asset('image', image, 'image/png'),
      ];
      for (const [index, entry] of assets.entries()) {
        const bytes = [request, response, image][index];
        artifacts.set(entry.hash, { bytes, mimeType: entry.mime_type });
      }
      options.mutateCanvaAssets?.(assets);
      return new Response(JSON.stringify({
        job: {
          job_id: jobId,
          status: 'completed',
          cost: Object.hasOwn(options, 'canvaCost')
            ? options.canvaCost
            : XAI_CANONICAL_BUNDLE_MODEL.auditedCostMicrocredits,
        },
        input,
        provider_runs: [{
          provider: XAI_CANONICAL_BUNDLE_MODEL.backend,
          modelId: XAI_CANONICAL_BUNDLE_MODEL.id,
          requestId: `fal-${jobId}`,
        }],
        assets,
      }), { status: 200 });
    }
    const artifactMatch = parsed.pathname.match(/^\/api\/v1\/assets\/([a-f0-9]{32})$/);
    if (artifactMatch) {
      const artifact = artifacts.get(artifactMatch[1]);
      if (!artifact) return new Response('missing', { status: 404 });
      if (options.assetRedirect) {
        return new Response(null, { status: 302, headers: { location: 'https://attacker.example/asset' } });
      }
      return new Response(artifact.bytes, {
        status: 200,
        headers: {
          'content-type': options.assetMimeType ?? artifact.mimeType,
          'content-length': String(options.assetContentLength ?? artifact.bytes.byteLength),
        },
      });
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
    slug: fixture.fighter.slug,
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

function selectedPoseManifest(fixture, sourceName) {
  const poseManifest = {
    ...fixture.poseManifest,
    sources: { [sourceName]: fixture.poseManifest.sources[sourceName] },
  };
  const poseManifestBytes = Buffer.from(JSON.stringify(poseManifest));
  const poseManifestPath = join(fixture.poseDir, `${sourceName}-pose-manifest.json`);
  writeFileSync(poseManifestPath, poseManifestBytes);
  return {
    poseManifestPath,
    poseManifestSha256: sha256(poseManifestBytes),
  };
}

function singleSourcePoseOptions(fixture) {
  const selected = selectedPoseManifest(fixture, 'crouch');
  const prompt = buildXaiCanonicalBundlePrompt(fixture.fighter, 'crouch', {
    promptProfile: XAI_CANONICAL_SINGLE_SOURCE_PROMPT_PROFILE,
  });
  return {
    ...selected,
    promptSha256: sha256(prompt),
  };
}

function singleSourceRunOptions(fixture, provider, runCommand = commandFixture()) {
  return {
    ...runOptions(fixture, provider, runCommand),
    confirmation: XAI_CANONICAL_SINGLE_SOURCE_CONFIRMATION,
    maxCostUsd: 0.11,
    sourceName: 'crouch',
    ...singleSourcePoseOptions(fixture),
    statePath: join(fixture.directory, 'crouch-state.json'),
    outputDirectory: join(fixture.directory, 'crouch-output'),
  };
}

function rewriteCompletedBundleAsLegacyCleanup(outputDirectory) {
  const descriptorPath = join(outputDirectory, 'review-descriptor.json');
  const statePath = join(outputDirectory, 'generation-state.json');
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const sourceNames = descriptor.sourceNames ?? ['side', 'upright', 'crouch'];
  for (const sourceName of sourceNames) {
    const cleanBytes = png(`legacy-green-edge-${sourceName}`, 128, 192);
    writeFileSync(join(outputDirectory, 'sources', `${sourceName}.png`), cleanBytes);
    const clean = {
      width: 128,
      height: 192,
      sizeBytes: cleanBytes.byteLength,
      contentSha256: sha256(cleanBytes),
      path: `sources/${sourceName}.png`,
    };
    descriptor.sources[sourceName].raw.providerRequestId = null;
    descriptor.sources[sourceName].clean = clean;
    state.slots[sourceName].raw.providerRequestId = null;
    state.slots[sourceName].clean = clean;
    state.slots[sourceName].cleanupFfmpegVersion =
      `ffmpeg version ${XAI_CANONICAL_BUNDLE_LEGACY_CLEANUP.ffmpegVersion} Copyright`;
    delete state.slots[sourceName].cleanupFilter;
  }
  const contactBytes = png(
    'legacy-green-contact',
    sourceNames.length === 1 ? 768 : 1152,
    sourceNames.length === 1 ? 512 : 1024,
  );
  writeFileSync(join(outputDirectory, 'contact-sheet.png'), contactBytes);
  descriptor.cleanup = { ...XAI_CANONICAL_BUNDLE_LEGACY_CLEANUP };
  descriptor.contactSheet = {
    ...descriptor.contactSheet,
    contentSha256: sha256(contactBytes),
    sizeBytes: contactBytes.byteLength,
  };
  const { descriptorSha256: _oldDescriptorSha256, ...unsignedDescriptor } = descriptor;
  descriptor.descriptorSha256 = sha256(canonicalJson(unsignedDescriptor));
  state.descriptorSha256 = descriptor.descriptorSha256;
  state.contactSheetSha256 = descriptor.contactSheet.contentSha256;
  writeFileSync(descriptorPath, JSON.stringify(descriptor));
  writeFileSync(statePath, JSON.stringify(state));
  return { descriptor, state };
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

  it('seals a synthetic gradient/edge fixture to the pinned key and despill contract', () => {
    const fixturePath = new URL(`../${XAI_CANONICAL_BUNDLE_CLEANUP_FIXTURE.path}`, import.meta.url);
    expect(sha256(readFileSync(fixturePath))).toBe(XAI_CANONICAL_BUNDLE_CLEANUP_FIXTURE.inputSha256);
    expect(XAI_CANONICAL_BUNDLE_CLEANUP.filter).toContain("between(alpha(X,Y),1,254)");
    expect(XAI_CANONICAL_BUNDLE_CLEANUP.filter).toContain("g(X,Y)-(255-alpha(X,Y))");
    expect(XAI_CANONICAL_BUNDLE_CLEANUP.filter).toContain("g(X,Y)-max(r(X,Y),b(X,Y)),4");
    expect(XAI_CANONICAL_BUNDLE_CLEANUP.filter).toContain("b(X,Y)-r(X,Y),12");
    expect(XAI_CANONICAL_BUNDLE_CLEANUP.filter).toContain("if(eq(val,255),255,0)");
    const opaqueErosionBand = XAI_CANONICAL_BUNDLE_CLEANUP.filter
      .match(/\[opaque_for_erode\]([^[]+)\[opaque_eroded\]/)?.[1]
      .split(',');
    expect(opaqueErosionBand).toHaveLength(24);
    expect(opaqueErosionBand.every((filter) => filter === 'erosion')).toBe(true);
    expect(XAI_CANONICAL_BUNDLE_CLEANUP.filter).toContain('despill=green:mix=1:expand=0.15');
    expect(XAI_CANONICAL_BUNDLE_CLEANUP.filter).toContain("if(gt(val,0),255,0)");
    expect(readFileSync(fixturePath, 'utf8')).toContain('0 96 96   0 96 96');
    const directory = mkdtempSync(join(tmpdir(), 'insert-player-cleanup-fixture-'));
    temporaryDirectories.push(directory);
    const runCommand = commandFixture();
    expect(() => verifyCanonicalCleanupFixture({
      outputPath: join(directory, 'clean.png'),
      runCommand,
    })).toThrow(/key\/despill output changed/i);
    expect(runCommand.mock.calls.some(([, args]) => (
      args.includes('-filter_complex') && args.includes(XAI_CANONICAL_BUNDLE_CLEANUP.filter)
    ))).toBe(true);
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
    expect(generation).toContain('expected_r2_key="temp/arcade-xai-canonical-inputs-v1/$REQUESTED_SLUG/$archive_stem--${INPUT_BUNDLE_SHA256:0:16}.tar.gz"');
    expect(generation).toContain('printf \'%s  %s\\n\' "$INPUT_BUNDLE_SHA256" "$archive" | sha256sum --check --strict');
    expect(generation).toContain('printf \'%s  %s\\n\' "$POSE_MANIFEST_SHA256" "$input_root/pose/pose-manifest.json" | sha256sum --check --strict');
    expect(generation).toContain('ffmpeg=7:5.1.9-0+deb12u1');
    expect(generation).toContain('npm run arcade:verify:xai-canonical-cleanup -- --output=/tmp/xai-canonical-cleanup-fixture.png');
    expect(generation).toContain('reclean_bundle_run_id:');
    expect(generation).toContain("if: inputs.reclean_bundle_run_id == ''");
    expect(generation).toContain("if: inputs.reclean_bundle_run_id != ''");
    expect(generation).toContain('RECLEAN_XAI_CANONICAL_BUNDLE_OFFLINE_V1');
    expect(generation).toContain('--network none');
    expect(generation).toContain('--bundle-dir=/input');
    expect(generation).toContain('--reviewed-descriptor-sha256="$1"');
    expect(generation).toContain('workflowName\' <<<"$prior")" == "Generate one private XAI canonical bundle"');
    const offlineJob = generation.slice(generation.indexOf('  reclean-private-bundle:'));
    expect(offlineJob).not.toContain('secrets.PIXCLI_API_KEY');
    expect(offlineJob).not.toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(offlineJob).not.toContain('wrangler r2 object get');
    expect(offlineJob).not.toContain('/api/v1/edit/advanced');
    expect(generation).toContain('--max-cost-usd="$MAX_COST_USD"');
    expect(generation).toContain('REQUESTED_SOURCE: ${{ inputs.source }}');
    expect(generation).toContain('PROMPT_SHA256: ${{ inputs.prompt_sha256 }}');
    expect(generation).toContain('"--source=$REQUESTED_SOURCE" "--prompt-sha256=$PROMPT_SHA256"');
    expect(generation).toContain('elon-musk:crouch)');
    expect(generation).toContain('rosalia:side)');
    expect(generation).toContain('ibai-llanos:side)');
    expect(generation).toContain('lamine-yamal:side)');
    expect(generation).not.toContain('aitana:side)');
    for (const promptSha256 of [
      XAI_CANONICAL_SINGLE_SOURCE_PROMPT_SHA256,
      ...Object.values(XAI_CANONICAL_GLOBAL_SIDE_PROMPT_SHA256_BY_SLUG),
    ]) expect(generation).toContain(promptSha256);
    expect(generation).toContain('actual_sources="$(jq -c \'.sources | keys | sort\' "$input_root/pose/pose-manifest.json")"');
    expect(generation).toContain('[[ "$MAX_COST_USD" == "0.11" ]]');
    expect(generation).toContain('name: arcade-xai-canonical-bundle-${{ inputs.slug }}');
    expect(generation).toContain('name: arcade-xai-canonical-bundle-checkpoint-${{ inputs.slug }}');
    expect(generation).toContain('- name: Repair private checkpoint ownership after the cleanup container');
    expect(generation).toMatch(/- name: Repair private checkpoint ownership after the cleanup container\n\s+if: always\(\)/);
    expect(generation).toContain('sudo chown -R --no-dereference -- "$(id -u):$(id -g)" "$work_root"');
    expect(generation.indexOf('Repair private checkpoint ownership')).toBeLessThan(
      generation.indexOf('Preserve the resumable private paid-call checkpoint'),
    );
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

  it('mirrors the PixCLI EditAdvanced prompt schema and seals UTF-8 bytes fail-closed', () => {
    expect(XAI_CANONICAL_PIXCLI_PROMPT_MAX).toBe(4000);
    const exactAsciiBoundary = 'x'.repeat(XAI_CANONICAL_PIXCLI_PROMPT_MAX);
    expect(assertXaiCanonicalPromptFitsPixcliSchema(exactAsciiBoundary)).toBe(exactAsciiBoundary);
    expect(() => assertXaiCanonicalPromptFitsPixcliSchema(`${exactAsciiBoundary}x`))
      .toThrow(/exceeds max 4000 \(4001 characters, 4001 UTF-8 bytes\)/i);
    expect(() => assertXaiCanonicalPromptFitsPixcliSchema(
      `${'x'.repeat(XAI_CANONICAL_PIXCLI_PROMPT_MAX - 1)}é`,
    )).toThrow(/4000 characters, 4001 UTF-8 bytes/i);
  });

  it('preserves every original three-source prompt byte-for-byte', () => {
    const snapshots = [];
    for (const fighter of roster.fighters) {
      for (const sourceName of ['side', 'upright', 'crouch']) {
        const prompt = buildXaiCanonicalBundlePrompt(fighter, sourceName);
        snapshots.push([
          fighter.slug,
          sourceName,
          sha256(prompt),
          Buffer.byteLength(prompt, 'utf8'),
          prompt.length,
        ]);
      }
    }
    expect(sha256(JSON.stringify(snapshots)))
      .toBe('7415c82e9130840939192f1d969207362480ce25fb00e23db5146455f0de029a');
  });

  it('seals the single CROUCH identity-first prompt and wires its reviewed hash through the CLI', () => {
    const fixture = makeFixture();
    const prompt = buildXaiCanonicalBundlePrompt(fixture.fighter, 'crouch', {
      promptProfile: XAI_CANONICAL_SINGLE_SOURCE_PROMPT_PROFILE,
    });
    const promptSha256 = sha256(prompt);
    expect(promptSha256).toBe(XAI_CANONICAL_SINGLE_SOURCE_PROMPT_SHA256);
    expect(prompt.length).toBe(3653);
    expect(Buffer.byteLength(prompt, 'utf8')).toBe(3661);
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(XAI_CANONICAL_PIXCLI_PROMPT_MAX);
    expect(prompt).toContain('strict lateral profile facing screen-right');
    expect(prompt).not.toContain('3/4');
    expect(prompt).toContain('both soles planted on one shared ground line');
    expect(prompt).toContain('two distinct complete hands close to face/upper chest in closed defensive guard');
    expect(prompt).toContain('not frontal, three-quarter, or screen-left; do not mirror');
    expect(prompt).toContain('IMAGE 1 = CROUCH STRUCTURE only: joints, depth, two-hand guard');
    expect(prompt).toContain('TARGET/OUTPUT override yaw, perspective, facing, framing, silhouette, foot baseline, background');
    expect(prompt).toContain('static—no attack, lunge, jump, kneel, or motion');
    expect(prompt).toContain('generous overscan');
    expect(prompt).toContain('OUTPUT — HARD EVEN IF A REFERENCE CONFLICTS');
    expect(prompt).toContain('Render Elon Musk exactly as shown, never model memory/generic substitute');
    expect(prompt).toContain('Never copy its clothing/suit/shirt/tie/colors/accessories');
    expect(prompt).toContain('Never copy identity, face, hair, physique, background/green vignette/gradient/logos');
    expect(prompt).toContain('OUTPUT alone background');
    expect(prompt).toContain('no shadow, floor, gradient, text, watermark, logo, badge, emblem, brand-like symbol, prop, border');
    expect(prompt.indexOf('IMAGE 3 = REAL IDENTITY')).toBeLessThan(
      prompt.indexOf('IMAGE 1 = CROUCH STRUCTURE'),
    );
    expect(prompt.indexOf('1) IDENTITY/PHYSIQUE from IMAGE 3')).toBeLessThan(
      prompt.indexOf('2) CROUCH joints from IMAGE 1'),
    );
    expect(prompt).toContain('subject to TARGET/OUTPUT');
    expect(() => buildXaiCanonicalBundlePrompt(fixture.fighter, 'side', {
      promptProfile: XAI_CANONICAL_SINGLE_SOURCE_PROMPT_PROFILE,
    })).toThrow(/only for Elon Musk CROUCH/i);

    const parsed = parseXaiCanonicalBundleCliArgs([
      '--execute',
      '--slug=elon-musk',
      '--source=crouch',
      `--prompt-sha256=${promptSha256}`,
      `--confirm=${XAI_CANONICAL_SINGLE_SOURCE_CONFIRMATION}`,
      `--confirm-private=${XAI_CANONICAL_BUNDLE_PRIVATE_CONFIRMATION}`,
      '--max-cost-usd=0.11',
    ], { PIXCLI_API_KEY: 'private-test-key', PIXCLI_BASE_URL: 'https://pixcli.example' });
    expect(parsed).toMatchObject({
      slug: 'elon-musk',
      sourceName: 'crouch',
      promptSha256,
      maxCostUsd: '0.11',
      apiKey: 'private-test-key',
    });
  });

  it('seals one distinct identity-first global SIDE prompt per allowed roster identity', () => {
    const prompts = new Map();
    const expectedPromptBytes = {
      rosalia: 3855,
      'ibai-llanos': 3856,
      'lamine-yamal': 3879,
    };
    for (const slug of XAI_CANONICAL_GLOBAL_SIDE_SLUGS) {
      const fighter = roster.fighters.find((entry) => entry.slug === slug);
      expect(resolveXaiCanonicalSingleSourcePromptProfile(slug, 'side'))
        .toBe(XAI_CANONICAL_GLOBAL_SIDE_PROMPT_PROFILE);
      const prompt = buildXaiCanonicalBundlePrompt(fighter, 'side', {
        promptProfile: XAI_CANONICAL_GLOBAL_SIDE_PROMPT_PROFILE,
      });
      const promptSha256 = sha256(prompt);
      expect(promptSha256).toBe(XAI_CANONICAL_GLOBAL_SIDE_PROMPT_SHA256_BY_SLUG[slug]);
      expect(Buffer.byteLength(prompt, 'utf8')).toBe(expectedPromptBytes[slug]);
      expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(XAI_CANONICAL_PIXCLI_PROMPT_MAX);
      expect(prompt).toContain(`Render ${fighter.name} exactly as IMAGE 3`);
      expect(prompt).toContain('no model memory, celebrity prior, web knowledge, generic approximation, substitute');
      expect(prompt).toContain('IMAGE 1 = APPROVED TRUMP UPRIGHT POSE/COMPOSITION ONLY');
      expect(prompt).toContain('TARGET/OUTPUT override perspective/yaw/frame/facing/crop/floor/shadow/background');
      expect(prompt).toContain('IMAGE 2 = APPROVED MILEI RENDERING-LANGUAGE ONLY');
      expect(prompt).toContain('it supplies no clothing/body instructions');
      expect(prompt).toContain('strict lateral profile facing screen-right');
      expect(prompt).not.toContain('3/4');
      expect(prompt).toContain('not frontal, three-quarter, or screen-left; do not mirror');
      expect(prompt).toContain('Wardrobe/garments/footwear/palette/design ONLY from ROSTER');
      expect(prompt).toContain('pure bright green (#00FF00), flat/uniform');
      expect(prompt).toContain('generous green overscan');
      expect(prompt.indexOf('IMAGE 3 = REAL')).toBeLessThan(prompt.indexOf('IMAGE 1 = APPROVED TRUMP'));
      expect(prompt.indexOf(`1) ${fighter.name.toUpperCase()} IDENTITY`))
        .toBeLessThan(prompt.indexOf('2) strict screen-right pose'));
      prompts.set(slug, prompt);
    }
    expect(new Set([...prompts.values()].map(sha256)).size).toBe(3);
    expect(prompts.get('rosalia')).toContain('Never masculinize face, jaw, neck, shoulders, torso, limbs, or proportions');
    expect(prompts.get('ibai-llanos')).toContain('Absolutely no mic, microphone, headset, headphones, earbuds');
    expect(prompts.get('lamine-yamal')).toContain('Absolutely no athletic/kinesiology tape, bandage');
    expect(prompts.get('lamine-yamal')).toContain('number, lettering, text, logo');

    const payload = buildXaiCanonicalBundlePayload({
      fighter: roster.fighters.find((entry) => entry.slug === 'rosalia'),
      sourceName: 'side',
      promptProfile: XAI_CANONICAL_GLOBAL_SIDE_PROMPT_PROFILE,
      poseAssetHash: '1'.repeat(32),
      renderingAssetHash: '2'.repeat(32),
      identityAssetHash: '3'.repeat(32),
    });
    expect(payload.image).toEqual(['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)]);
    expect(payload.prompt).toBe(prompts.get('rosalia'));
    expect(Buffer.byteLength(payload.prompt, 'utf8')).toBe(3855);
    expect(Object.keys(payload).sort()).toEqual([
      'enrich_prompt',
      'image',
      'model',
      'output_format',
      'params',
      'prompt',
      'publish',
      'publish_name',
      'search',
    ]);
    expect(payload).toMatchObject({
      enrich_prompt: false,
      search: false,
      publish: false,
      params: { num_images: 1 },
    });
    expect(JSON.stringify(payload)).not.toMatch(/fallback|retry/i);
  });

  it('seals global CROUCH to original identity + Trump crouch + that fighter reviewed SIDE raw', () => {
    const expectedPromptBytes = {
      rosalia: 3820,
      'ibai-llanos': 3824,
      'lamine-yamal': 3848,
    };
    for (const slug of XAI_CANONICAL_GLOBAL_SIDE_SLUGS) {
      const fighter = roster.fighters.find((entry) => entry.slug === slug);
      expect(resolveXaiCanonicalSingleSourcePromptProfile(slug, 'crouch'))
        .toBe(XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE);
      const prompt = buildXaiCanonicalBundlePrompt(fighter, 'crouch', {
        promptProfile: XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE,
      });
      expect(sha256(prompt)).toBe(XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_SHA256_BY_SLUG[slug]);
      expect(Buffer.byteLength(prompt, 'utf8')).toBe(expectedPromptBytes[slug]);
      expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(XAI_CANONICAL_PIXCLI_PROMPT_MAX);
      expect(prompt).toContain(`IMAGE 3 = REAL ${fighter.name.toUpperCase()}`);
      expect(prompt).toContain('IMAGE 1 = APPROVED TRUMP CROUCH STRUCTURE ONLY');
      expect(prompt).toContain(`IMAGE 2 = APPROVED ${fighter.name.toUpperCase()} SIDE RAW; RENDERING/WARDROBE ONLY`);
      expect(prompt).toContain('strict lateral profile facing screen-right');
      expect(prompt).not.toContain('3/4');
      expect(prompt).toContain('both soles planted on one shared ground line');
      expect(prompt).toContain('two distinct complete hands close to face/upper chest');
      expect(prompt).toContain('no model memory, celebrity prior, web knowledge, generic substitute');
      expect(prompt.indexOf('IMAGE 3 = REAL')).toBeLessThan(prompt.indexOf('IMAGE 1 = APPROVED TRUMP'));
      expect(prompt.indexOf('1) ')).toBeLessThan(prompt.indexOf('2) deep strict screen-right CROUCH'));
    }

    const rosalia = roster.fighters.find((entry) => entry.slug === 'rosalia');
    const renderingHash = 'a'.repeat(64);
    const approvalRecord = {
      schemaVersion: 1,
      evidenceType: 'reviewed_global_side_for_crouch_v1',
      status: 'approved',
      decision: 'APPROVE_REVIEWED_GLOBAL_SIDE_FOR_CROUCH_V1',
      sideBundleRunId: '33040000000',
      reviewedDescriptorSha256: 'b'.repeat(64),
      fighter: { slug: 'rosalia', name: rosalia.name, photoHash: rosalia.reference.sourceSha256 },
      side: {
        bundleId: 'arcade-xai-canonical-source-rosalia-side-v1',
        rawSha256: renderingHash,
      },
      blockingFindings: [],
    };
    const validReferences = {
      sources: {
        crouch: {
          pose: { ...XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE },
          rendering: {
            id: 'reviewed-rosalia-side-raw-v1',
            contentSha256: renderingHash,
            approvalRecord,
          },
        },
      },
    };
    expect(validateXaiCanonicalPromptProfileReferences(
      validReferences,
      XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE,
      rosalia,
    )).toBe(validReferences);
    expect(() => validateXaiCanonicalPromptProfileReferences({
      sources: {
        crouch: {
          pose: { ...XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE, contentSha256: 'b'.repeat(64) },
          rendering: validReferences.sources.crouch.rendering,
        },
      },
    }, XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE, rosalia)).toThrow(/reviewed Trump crouch/i);
    expect(() => validateXaiCanonicalPromptProfileReferences({
      sources: {
        crouch: {
          pose: { ...XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE },
          rendering: { id: 'milei-side-reviewed-v1', contentSha256: renderingHash, approvalRecord },
        },
      },
    }, XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE, rosalia)).toThrow(/reviewed SIDE raw/i);
    expect(() => validateXaiCanonicalPromptProfileReferences({
      sources: {
        crouch: {
          pose: { ...XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE },
          rendering: {
            id: 'reviewed-rosalia-side-raw-v1',
            contentSha256: renderingHash,
            approvalRecord: { ...approvalRecord, blockingFindings: ['identity mismatch'] },
          },
        },
      },
    }, XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE, rosalia)).toThrow(/unblocked SIDE review lineage/i);
  });

  it('fails closed on global SIDE reference roles, slugs, sources, and cross-identity names', async () => {
    const validReferences = {
      sources: {
        side: {
          pose: { ...XAI_CANONICAL_GLOBAL_SIDE_REFERENCES.pose },
          rendering: { ...XAI_CANONICAL_GLOBAL_SIDE_REFERENCES.rendering },
        },
      },
    };
    expect(validateXaiCanonicalPromptProfileReferences(
      validReferences,
      XAI_CANONICAL_GLOBAL_SIDE_PROMPT_PROFILE,
    )).toBe(validReferences);
    expect(() => validateXaiCanonicalPromptProfileReferences({
      sources: {
        side: {
          pose: { ...XAI_CANONICAL_GLOBAL_SIDE_REFERENCES.rendering },
          rendering: { ...XAI_CANONICAL_GLOBAL_SIDE_REFERENCES.pose },
        },
      },
    }, XAI_CANONICAL_GLOBAL_SIDE_PROMPT_PROFILE)).toThrow(/global SIDE pose reference/i);
    expect(() => validateXaiCanonicalPromptProfileReferences({
      sources: { ...validReferences.sources, upright: validReferences.sources.side },
    }, XAI_CANONICAL_GLOBAL_SIDE_PROMPT_PROFILE)).toThrow(/exact single-side/i);

    expect(() => resolveXaiCanonicalSingleSourcePromptProfile('aitana', 'side')).toThrow(/not sealed/i);
    expect(resolveXaiCanonicalSingleSourcePromptProfile('rosalia', 'crouch'))
      .toBe(XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE);
    expect(() => resolveXaiCanonicalSingleSourcePromptProfile('elon-musk', 'side')).toThrow(/not sealed/i);
    expect(resolveXaiCanonicalSingleSourcePromptProfile('elon-musk', 'crouch'))
      .toBe(XAI_CANONICAL_SINGLE_SOURCE_PROMPT_PROFILE);
    expect(() => buildXaiCanonicalBundlePrompt(
      { ...roster.fighters.find((entry) => entry.slug === 'rosalia'), name: 'Aitana' },
      'side',
      { promptProfile: XAI_CANONICAL_GLOBAL_SIDE_PROMPT_PROFILE },
    )).toThrow(/exact roster identities/i);
    expect(() => buildXaiCanonicalBundlePrompt(
      roster.fighters.find((entry) => entry.slug === 'rosalia'),
      'side',
      { promptProfile: XAI_CANONICAL_SINGLE_SOURCE_PROMPT_PROFILE },
    )).toThrow(/only for Elon Musk CROUCH/i);

    const fixture = makeFixture('rosalia');
    const provider = providerFixture();
    const selected = selectedPoseManifest(fixture, 'side');
    await expect(runXaiCanonicalBundle({
      ...runOptions(fixture, provider),
      confirmation: XAI_CANONICAL_SINGLE_SOURCE_CONFIRMATION,
      maxCostUsd: 0.11,
      sourceName: 'side',
      promptSha256: XAI_CANONICAL_GLOBAL_SIDE_PROMPT_SHA256_BY_SLUG.rosalia,
      ...selected,
    })).rejects.toThrow(/global SIDE pose reference/i);
    expect(provider.fetchImpl).not.toHaveBeenCalled();

    const parsed = parseXaiCanonicalBundleCliArgs([
      '--execute',
      '--slug=rosalia',
      '--source=side',
      `--prompt-sha256=${XAI_CANONICAL_GLOBAL_SIDE_PROMPT_SHA256_BY_SLUG.rosalia}`,
      `--confirm=${XAI_CANONICAL_SINGLE_SOURCE_CONFIRMATION}`,
      `--confirm-private=${XAI_CANONICAL_BUNDLE_PRIVATE_CONFIRMATION}`,
      '--max-cost-usd=0.11',
    ], { PIXCLI_API_KEY: 'private-test-key' });
    expect(parsed).toMatchObject({ slug: 'rosalia', sourceName: 'side', maxCostUsd: '0.11' });
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

  it('rejects an oversized single-source prompt before uploads, preflight, or edit POST', async () => {
    const fixture = makeFixture();
    const oversizedRoster = JSON.parse(readFileSync(fixture.rosterPath, 'utf8'));
    oversizedRoster.fighters.find((entry) => entry.slug === fixture.fighter.slug).referencePrompt
      += ` ${'licensed detail '.repeat(50)}`;
    writeFileSync(fixture.rosterPath, JSON.stringify(oversizedRoster));
    const provider = providerFixture();
    const selected = selectedPoseManifest(fixture, 'crouch');
    await expect(runXaiCanonicalBundle({
      ...runOptions(fixture, provider),
      confirmation: XAI_CANONICAL_SINGLE_SOURCE_CONFIRMATION,
      maxCostUsd: 0.11,
      sourceName: 'crouch',
      promptSha256: '0'.repeat(64),
      ...selected,
    })).rejects.toThrow(/PixCLI EditAdvanced prompt exceeds max 4000/i);
    expect(provider.fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(fixture.statePath)).toBe(false);
    expect(existsSync(fixture.outputDirectory)).toBe(false);
  });
});

describe('resumable exactly-once XAI canonical bundle', () => {
  it('isolates one CROUCH call behind a source-specific state and an exact $0.11 ceiling', async () => {
    const fixture = makeFixture();
    const provider = providerFixture();
    const options = singleSourceRunOptions(fixture, provider);
    const result = await runXaiCanonicalBundle(options);
    const paidPosts = provider.fetchImpl.mock.calls.filter(([url, init]) => (
      new URL(url).pathname === '/api/v1/edit/advanced' && init.method === 'POST'
    ));
    expect(paidPosts).toHaveLength(1);
    expect([...provider.jobs.values()]).toHaveLength(1);
    expect([...provider.jobs.values()][0]).toMatchObject({
      publish_name: 'ip-canonical-v1-elon-musk-crouch',
      publish: false,
      enrich_prompt: false,
      search: false,
    });
    expect(result.state).toMatchObject({
      bundleId: 'arcade-xai-canonical-source-elon-musk-crouch-v1',
      sourceNames: ['crouch'],
      policy: {
        expectedPaidCalls: 1,
        maximumPaidCalls: 1,
        maximumCostPerOutputUsd: 0.11,
        maximumBundleCostUsd: 0.11,
        automaticRetries: 0,
        fallback: 'none',
      },
    });
    expect(result.descriptor).toMatchObject({
      sourceNames: ['crouch'],
      provider: { paidCalls: 1, actualCostUsd: 0.11, maximumBundleCostUsd: 0.11 },
      contactSheet: { width: 768, height: 512, layout: ['crouch_raw', 'crouch_clean'] },
    });
    const rawBytes = readFileSync(join(options.outputDirectory, 'sources', 'crouch_raw.png'));
    expect(result.descriptor.sources.crouch.raw).toMatchObject({
      contentSha256: sha256(rawBytes),
      sizeBytes: rawBytes.byteLength,
      mimeType: 'image/png',
      width: 1024,
      height: 1536,
    });
    expect(Object.keys(result.descriptor.sources)).toEqual(['crouch']);
    expect(existsSync(join(options.outputDirectory, 'sources', 'side.png'))).toBe(false);
    expect(existsSync(join(options.outputDirectory, 'sources', 'upright.png'))).toBe(false);

    const rejectedProvider = providerFixture();
    await expect(runXaiCanonicalBundle({
      ...singleSourceRunOptions(makeFixture(), rejectedProvider),
      maxCostUsd: 0.12,
    })).rejects.toThrow(/max-cost-usd=0\.11/i);
    expect(rejectedProvider.fetchImpl).not.toHaveBeenCalled();
  });

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

  it.each([
    ['an extra stored input field', {
      mutateCanvaInput: (input) => ({ ...input, unsealed: true }),
      error: /normalized input keys are not sealed/i,
    }],
    ['a changed field from the sealed submitted request', {
      mutateCanvaInput: (input) => ({ ...input, publish_name: `${input.publish_name}-changed` }),
      error: /input does not match the sealed request/i,
    }],
    ['reordered normalized references', {
      mutateCanvaInput: (input) => ({ ...input, image_urls: [...input.image_urls].reverse() }),
      error: /normalized prompt or reference URLs changed/i,
    }],
    ['an enriched prompt despite enrichment being disabled', {
      mutateCanvaInput: (input) => ({ ...input, enriched_prompt: `${input.enriched_prompt} changed` }),
      error: /normalized prompt or reference URLs changed/i,
    }],
    ['a changed archived provider prompt', {
      mutateProviderRequest: (request) => ({
        ...request,
        input: { ...request.input, prompt: `${request.input.prompt} changed` },
      }),
      error: /provider request does not match the sealed provider contract/i,
    }],
  ])('rejects %s without a second POST', async (_label, providerOptions) => {
    const fixture = makeFixture();
    const provider = providerFixture(providerOptions);
    await expect(runXaiCanonicalBundle(runOptions(fixture, provider))).rejects.toThrow(providerOptions.error);
    const paidPosts = provider.fetchImpl.mock.calls.filter(([url, init]) => (
      new URL(url).pathname === '/api/v1/edit/advanced' && init.method === 'POST'
    ));
    expect(paidPosts).toHaveLength(1);
  });

  it('accepts an optional correct image content hash but rejects a malformed or mismatched one', async () => {
    const acceptedFixture = makeFixture();
    const acceptedProvider = providerFixture({ includeImageContentSha: true });
    await expect(runXaiCanonicalBundle(singleSourceRunOptions(acceptedFixture, acceptedProvider)))
      .resolves.toMatchObject({ state: { status: 'awaiting_human_review' } });

    for (const declaredContentSha256 of ['invalid', '0'.repeat(64)]) {
      const fixture = makeFixture();
      const provider = providerFixture({
        mutateCanvaAssets: (assets) => {
          const image = assets.find((asset) => asset.mime_type === 'image/png');
          image.metadata.content_sha256 = declaredContentSha256;
        },
      });
      await expect(runXaiCanonicalBundle(singleSourceRunOptions(fixture, provider)))
        .rejects.toThrow(/content SHA-256 is invalid|artifact hash mismatch/i);
      const paidPosts = provider.fetchImpl.mock.calls.filter(([url, init]) => (
        new URL(url).pathname === '/api/v1/edit/advanced' && init.method === 'POST'
      ));
      expect(paidPosts).toHaveLength(1);
    }
  });

  it.each([
    ['an extra provider response field', (response) => ({ ...response, unsealed: true })],
    ['a revised provider prompt', (response) => ({ ...response, revised_prompt: 'changed' })],
    ['a changed provider output URL', (response) => ({
      ...response,
      images: [{ ...response.images[0], url: 'https://v3b.fal.media/files/test/changed.png' }],
    })],
    ['changed provider output dimensions', (response) => ({
      ...response,
      images: [{ ...response.images[0], width: response.images[0].width + 1 }],
    })],
  ])('rejects %s without another paid POST', async (_label, mutateProviderResponse) => {
    const fixture = makeFixture();
    const provider = providerFixture({ mutateProviderResponse });
    await expect(runXaiCanonicalBundle(singleSourceRunOptions(fixture, provider)))
      .rejects.toThrow(/provider response/i);
    const paidPosts = provider.fetchImpl.mock.calls.filter(([url, init]) => (
      new URL(url).pathname === '/api/v1/edit/advanced' && init.method === 'POST'
    ));
    expect(paidPosts).toHaveLength(1);
  });

  it.each([
    ['a non-canonical authenticated asset URL', {
      mutateCanvaAssets: (assets) => {
        assets.find((asset) => asset.mime_type === 'image/png').url = 'https://attacker.example/output.png';
      },
      error: /exact authenticated asset route/i,
    }],
    ['an asset redirect', { assetRedirect: true, error: /HTTP 302/i }],
    ['an asset MIME mismatch', { assetMimeType: 'text/plain', error: /MIME mismatch/i }],
    ['an oversized declared asset', { assetContentLength: 13 * 1024 * 1024, error: /invalid declared size/i }],
  ])('fails closed on %s', async (_label, providerOptions) => {
    const fixture = makeFixture();
    const provider = providerFixture(providerOptions);
    await expect(runXaiCanonicalBundle(singleSourceRunOptions(fixture, provider)))
      .rejects.toThrow(providerOptions.error);
    const paidPosts = provider.fetchImpl.mock.calls.filter(([url, init]) => (
      new URL(url).pathname === '/api/v1/edit/advanced' && init.method === 'POST'
    ));
    expect(paidPosts).toHaveLength(1);
  });

  it('resumes the exact completed single-source job after an audit failure without another POST', async () => {
    const fixture = makeFixture();
    let corruptImageSha = true;
    const provider = providerFixture({
      mutateCanvaAssets: (assets) => {
        if (corruptImageSha) {
          assets.find((asset) => asset.mime_type === 'image/png').metadata.content_sha256 = 'invalid';
        }
      },
    });
    const options = singleSourceRunOptions(fixture, provider);
    await expect(runXaiCanonicalBundle(options)).rejects.toThrow(/content SHA-256 is invalid/i);
    expect(JSON.parse(readFileSync(options.statePath, 'utf8')).slots.crouch.status).toBe('submitted');
    corruptImageSha = false;
    await expect(runXaiCanonicalBundle(options))
      .resolves.toMatchObject({ state: { status: 'awaiting_human_review' } });
    const paidPosts = provider.fetchImpl.mock.calls.filter(([url, init]) => (
      new URL(url).pathname === '/api/v1/edit/advanced' && init.method === 'POST'
    ));
    expect(paidPosts).toHaveLength(1);
    expect([...provider.jobs]).toHaveLength(1);
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

  it('re-cleans a sealed legacy bundle offline and rebuilds its descriptor without uploads or paid POSTs', async () => {
    const fixture = makeFixture();
    const provider = providerFixture();
    const generated = await runXaiCanonicalBundle(singleSourceRunOptions(fixture, provider));
    const legacy = rewriteCompletedBundleAsLegacyCleanup(generated.outputDirectory);
    const providerCallsBeforeReclean = provider.fetchImpl.mock.calls.length;
    const paidPostsBeforeReclean = provider.fetchImpl.mock.calls.filter(([url, init]) => (
      new URL(url).pathname === '/api/v1/edit/advanced' && init.method === 'POST'
    )).length;
    const outputDirectory = join(fixture.directory, 'offline-recleaned');
    const runCommand = commandFixture();

    const result = recleanXaiCanonicalBundle({
      confirmation: XAI_CANONICAL_BUNDLE_RECLEAN_CONFIRMATION,
      bundleDirectory: generated.outputDirectory,
      outputDirectory,
      reviewedDescriptorSha256: legacy.descriptor.descriptorSha256,
      runCommand,
    });

    expect(provider.fetchImpl.mock.calls).toHaveLength(providerCallsBeforeReclean);
    expect(provider.fetchImpl.mock.calls.filter(([url, init]) => (
      new URL(url).pathname === '/api/v1/edit/advanced' && init.method === 'POST'
    ))).toHaveLength(paidPostsBeforeReclean);
    expect(result.descriptor.descriptorSha256).not.toBe(legacy.descriptor.descriptorSha256);
    expect(result.descriptor.cleanup).toEqual(XAI_CANONICAL_BUNDLE_CLEANUP);
    expect(result.descriptor.sources.crouch.raw.contentSha256)
      .toBe(legacy.descriptor.sources.crouch.raw.contentSha256);
    expect(result.descriptor.sources.crouch.raw.providerRequestId)
      .toBe(result.descriptor.sources.crouch.providerRequestId);
    expect(result.descriptor.sources.crouch.clean.contentSha256)
      .not.toBe(legacy.descriptor.sources.crouch.clean.contentSha256);
    expect(result.state.slots.crouch).toMatchObject({
      cleanupFfmpegVersion: XAI_CANONICAL_BUNDLE_CLEANUP.ffmpegVersion,
      cleanupFilter: XAI_CANONICAL_BUNDLE_CLEANUP.filter,
    });
    expect(readFileSync(join(outputDirectory, 'audit/crouch/provider_request.json')))
      .toEqual(readFileSync(join(generated.outputDirectory, 'audit/crouch/provider_request.json')));
    expect(runCommand.mock.calls.some(([, args]) => (
      args.includes('-filter_complex') && args.includes(XAI_CANONICAL_BUNDLE_CLEANUP.filter)
    ))).toBe(true);
    expect(parseXaiCanonicalRecleanCliArgs([
      '--execute',
      `--confirm=${XAI_CANONICAL_BUNDLE_RECLEAN_CONFIRMATION}`,
      `--bundle-dir=${generated.outputDirectory}`,
      `--output-dir=${join(fixture.directory, 'parsed-output')}`,
      `--reviewed-descriptor-sha256=${legacy.descriptor.descriptorSha256}`,
    ])).toEqual({
      confirmation: XAI_CANONICAL_BUNDLE_RECLEAN_CONFIRMATION,
      bundleDirectory: generated.outputDirectory,
      outputDirectory: join(fixture.directory, 'parsed-output'),
      reviewedDescriptorSha256: legacy.descriptor.descriptorSha256,
    });
  });

  it('rejects tampered offline audit bytes before invoking the cleanup toolchain', async () => {
    const fixture = makeFixture();
    const provider = providerFixture();
    const generated = await runXaiCanonicalBundle(singleSourceRunOptions(fixture, provider));
    const legacy = rewriteCompletedBundleAsLegacyCleanup(generated.outputDirectory);
    writeFileSync(join(generated.outputDirectory, 'audit/crouch/provider_response.json'), '{"tampered":true}');
    const runCommand = commandFixture();
    expect(() => recleanXaiCanonicalBundle({
      confirmation: XAI_CANONICAL_BUNDLE_RECLEAN_CONFIRMATION,
      bundleDirectory: generated.outputDirectory,
      outputDirectory: join(fixture.directory, 'must-not-exist'),
      reviewedDescriptorSha256: legacy.descriptor.descriptorSha256,
      runCommand,
    })).toThrow(/audit.*tampered/i);
    expect(runCommand).not.toHaveBeenCalled();
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
      if (!failedCleanup && args.includes('[out]')) {
        failedCleanup = true;
        throw new Error('simulated host cleanup crash');
      }
      const outputPath = args.at(-1);
      const contact = args.includes('[review]');
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
    const provider = providerFixture({ jobCost: 120000 });
    await expect(runXaiCanonicalBundle(runOptions(fixture, provider))).rejects.toThrow(/audited \$0\.11/i);
    const paidPosts = provider.fetchImpl.mock.calls.filter(([url, init]) => (
      new URL(url).pathname === '/api/v1/edit/advanced' && init.method === 'POST'
    ));
    expect(paidPosts).toHaveLength(1);
  });

  it.each([
    ['job null', { jobCost: null }],
    ['job USD instead of microcredits', { jobCost: 0.11 }],
    ['job string', { jobCost: '110000' }],
    ['job NaN', { jobCost: Number.NaN }],
    ['Canva null', { canvaCost: null }],
    ['Canva USD instead of microcredits', { canvaCost: 0.11 }],
    ['Canva string', { canvaCost: '110000' }],
    ['Canva NaN', { canvaCost: Number.NaN }],
  ])('rejects unproved %s cost values', async (_label, overrides) => {
    const fixture = makeFixture();
    const provider = providerFixture(overrides);
    await expect(runXaiCanonicalBundle(runOptions(fixture, provider))).rejects.toThrow(/\$0\.11/i);
  });
});

describe('portable private canonical input packaging', () => {
  it('packages an exact one-source CROUCH tree for the sealed $0.11 workflow', () => {
    const fixture = makeFixture();
    const singlePose = singleSourcePoseOptions(fixture);
    const outputDirectory = join(fixture.directory, 'portable-crouch-input');
    const receipt = packageXaiCanonicalInput({
      confirmation: PRIVATE_INPUT_CONFIRMATION,
      slug: 'elon-musk',
      sourceName: 'crouch',
      rosterPath: fixture.rosterPath,
      sourceDir: fixture.sourceDir,
      ...singlePose,
      outputDirectory,
    });
    expect(receipt).toMatchObject({
      slug: 'elon-musk',
      sourceName: 'crouch',
      portablePoseManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      uploaded: false,
      providerCalled: false,
    });
    expect(receipt.archivePath).toContain('elon-musk-crouch--canonical-input-v1.tar.gz');
    expect(receipt.r2Key).toMatch(/^temp\/arcade-xai-canonical-inputs-v1\/elon-musk\/elon-musk-crouch--[a-f0-9]{16}\.tar\.gz$/);
  });

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

  it('packages an exact one-source tree and binds its source-specific prompt and R2 key', () => {
    const fixture = makeFixture();
    const selected = selectedPoseManifest(fixture, 'crouch');
    const outputDirectory = join(fixture.directory, 'portable-crouch-input');
    const receipt = packageXaiCanonicalInput({
      confirmation: PRIVATE_INPUT_CONFIRMATION,
      slug: 'elon-musk',
      sourceName: 'crouch',
      rosterPath: fixture.rosterPath,
      sourceDir: fixture.sourceDir,
      poseManifestPath: selected.poseManifestPath,
      poseManifestSha256: selected.poseManifestSha256,
      outputDirectory,
    });
    expect(receipt).toMatchObject({
      sourceNames: ['crouch'],
      promptProfile: XAI_CANONICAL_SINGLE_SOURCE_PROMPT_PROFILE,
      promptSha256: XAI_CANONICAL_SINGLE_SOURCE_PROMPT_SHA256,
      uploaded: false,
      providerCalled: false,
    });
    expect(receipt.r2Key).toMatch(/^temp\/arcade-xai-canonical-inputs-v1\/elon-musk\/elon-musk-crouch--[a-f0-9]{16}\.tar\.gz$/);
    expect(receipt.archivePath).toBe(join(outputDirectory, 'elon-musk-crouch--canonical-input-v1.tar.gz'));
    const portablePose = join(outputDirectory, 'staging/canonical-input-v1/pose/pose-manifest.json');
    const portable = loadXaiCanonicalPoseManifest(
      portablePose,
      receipt.portablePoseManifestSha256,
      ['crouch'],
    );
    expect(Object.keys(portable.manifest.sources)).toEqual(['crouch']);
    expect(existsSync(join(outputDirectory, 'staging/canonical-input-v1/pose/references'))).toBe(true);
  });

  it('refuses to package a global SIDE archive with swapped or unsealed masters', () => {
    const fixture = makeFixture('rosalia');
    const selected = selectedPoseManifest(fixture, 'side');
    const outputDirectory = join(fixture.directory, 'portable-global-side-input');
    expect(() => packageXaiCanonicalInput({
      confirmation: PRIVATE_INPUT_CONFIRMATION,
      slug: 'rosalia',
      sourceName: 'side',
      rosterPath: fixture.rosterPath,
      sourceDir: fixture.sourceDir,
      poseManifestPath: selected.poseManifestPath,
      poseManifestSha256: selected.poseManifestSha256,
      outputDirectory,
    })).toThrow(/global SIDE pose reference/i);
    expect(existsSync(join(outputDirectory, 'rosalia-side--canonical-input-v1.tar.gz'))).toBe(false);
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
