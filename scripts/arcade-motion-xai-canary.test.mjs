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
import { QA_MOTION_CANARY } from './arcade-qa-motion-candidate.mjs';
import {
  XAI_QA_MOTION_CANARY_MODEL,
  buildXaiQaMotionCanaryInitialState,
  buildXaiQaMotionCanaryPayload,
  buildXaiQaMotionCanaryPlan,
  buildXaiQaMotionCanaryPrompt,
  qaMotionCatalogPreflightRequired,
  runXaiQaMotionCanary,
} from './arcade-motion-xai-canary.mjs';

const manifest = JSON.parse(readFileSync(new URL('../arcade/roster-2026.json', import.meta.url), 'utf8'));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const temporaryDirectories = [];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function tempDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'insert-player-xai-qa-motion-'));
  temporaryDirectories.push(path);
  return path;
}

function modelCatalog(cost = 70000) {
  return [{
    id: 'grok-imagine-image-2-edit',
    provider: 'xai',
    backend: 'fal',
    capabilities: ['edit', 'image-to-image'],
    cost_per_image: cost,
    advanced_mode: true,
  }];
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('XAI Milei HIGH_PUNCH QA motion canary', () => {
  it('seals one representative atlas frame, one canonical, and the real identity in order', () => {
    const plan = buildXaiQaMotionCanaryPlan(manifest);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      slotKey: 'arcade-qa-milei-high-punch-f4-xai-v1:grok-imagine-image-2-edit',
      fighter: { slug: 'javier-milei' },
      model: {
        id: 'grok-imagine-image-2-edit',
        endpoint: 'xai/grok-imagine-image/v2.0/edit',
      },
    });
    expect(plan[0].model.referenceInputs.map((entry) => entry.role)).toEqual([
      'motion_pose_composition_master',
      'canonical_character_rendering_master',
    ]);
    const prompt = buildXaiQaMotionCanaryPrompt(plan[0]);
    expect(prompt).toContain('exact standing high-punch impact pose from IMAGE 1');
    expect(prompt).not.toContain('high-kick');

    const payload = buildXaiQaMotionCanaryPayload({
      ...plan[0],
      sourceAssetHash: 'a'.repeat(32),
      poseAssetHash: 'b'.repeat(32),
      canonicalAssetHash: 'c'.repeat(32),
      prompt,
    });
    expect(payload.image).toEqual(['b'.repeat(32), 'c'.repeat(32), 'a'.repeat(32)]);
    expect(payload).toMatchObject({
      model: 'grok-imagine-image-2-edit',
      enrich_prompt: false,
      publish: false,
      publish_name: 'ip-motion-v1-javier-milei-high-punch-f4-grok2qa',
      params: { num_images: 1, resolution: '2k', quality: 'medium' },
    });
    expect(JSON.stringify(payload)).not.toMatch(/fallback|retry/i);
  });

  it('records the price pin and mandatory human review in immutable state policy', () => {
    const state = buildXaiQaMotionCanaryInitialState('a'.repeat(64));
    expect(state.policy).toMatchObject({
      expectedPaidCalls: 1,
      retries: 0,
      fallback: 'none',
      promptEnrichment: false,
      activation: false,
      candidateId: 'arcade-qa-milei-high-punch-f4-xai-v1',
      providerCatalogCostPerImage: 70000,
      maxEstimatedCostUsd: 0.07,
      humanReviewRequired: true,
    });
  });

  it('blocks before uploads or inference when the PixCLI model or price drifts', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(modelCatalog(70001)), { status: 200 }));
    await expect(runXaiQaMotionCanary({
      apiKey: 'test-key',
      apiBase: 'https://pixcli.example',
      fetchImpl,
    })).rejects.toThrow(/contract or price changed/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('submits exactly one frame, archives it, and never resubmits on resume', async () => {
    const directory = tempDirectory();
    const sourceDir = join(directory, 'sources');
    mkdirSync(sourceDir);
    const sourceBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('licensed-milei-source')]);
    const poseBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('atlas-high-punch-frame-4')]);
    const canonicalBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('approved-milei-canonical')]);
    const candidate = structuredClone(QA_MOTION_CANARY);
    candidate.identity.contentSha256 = sha256(sourceBytes);
    candidate.motion.asset.contentSha256 = sha256(poseBytes);
    candidate.canonical.contentSha256 = sha256(canonicalBytes);
    const controlledManifest = structuredClone(manifest);
    controlledManifest.fighters.find((fighter) => fighter.slug === 'javier-milei').reference.sourceSha256 = sha256(sourceBytes);

    writeFileSync(join(sourceDir, 'javier-milei.png'), sourceBytes);
    const posePath = join(directory, 'pose.png');
    const canonicalPath = join(directory, 'canonical.png');
    const manifestPath = join(directory, 'manifest.json');
    const statePath = join(directory, 'state.json');
    const poseUploadStatePath = join(directory, 'pose-upload.json');
    const canonicalUploadStatePath = join(directory, 'canonical-upload.json');
    const outputDir = join(directory, 'output');
    writeFileSync(posePath, poseBytes);
    writeFileSync(canonicalPath, canonicalBytes);
    writeFileSync(manifestPath, JSON.stringify(controlledManifest));

    const uploadHashes = ['b'.repeat(32), 'c'.repeat(32), 'a'.repeat(32)];
    let uploads = 0;
    let submissions = 0;
    let modelPreflights = 0;
    let submittedPayload;
    const requestBytes = Buffer.from(JSON.stringify({ provider: 'xai', kind: 'request' }));
    const responseBytes = Buffer.from(JSON.stringify({ provider: 'xai', kind: 'response' }));
    const imageBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('milei-high-punch')]);
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === '/api/v1/models') {
        modelPreflights += 1;
        return new Response(JSON.stringify(modelCatalog()), { status: 200 });
      }
      if (init.method === 'POST' && path === '/api/v1/uploads') {
        const hash = uploadHashes[uploads];
        uploads += 1;
        return new Response(JSON.stringify({
          hash,
          url: `https://pixcli.example/api/v1/assets/${hash}`,
          mime_type: 'image/png',
          size: 128,
        }), { status: 201 });
      }
      if (init.method === 'POST' && path === '/api/v1/edit/advanced') {
        submissions += 1;
        submittedPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ job_id: 'job-milei-punch', status: 'pending' }), { status: 202 });
      }
      if (path === '/api/v1/jobs/job-milei-punch') {
        return new Response(JSON.stringify({ job_id: 'job-milei-punch', status: 'completed', cost: 0.07 }), { status: 200 });
      }
      if (path === '/api/v1/jobs/job-milei-punch/canva') {
        const asset = (kind, bytes, mimeType) => ({
          hash: sha256(bytes).slice(0, 32),
          url: `https://pixcli.example/artifacts/${kind}`,
          mime_type: mimeType,
          metadata: kind === 'image' ? {} : {
            artifact_kind: kind === 'request' ? 'provider_request' : 'provider_response',
            content_sha256: sha256(bytes),
            provider_request_id: 'provider-milei-punch',
          },
        });
        return new Response(JSON.stringify({
          job: { job_id: 'job-milei-punch', status: 'completed', cost: 0.07 },
          input: submittedPayload,
          provider_runs: [{ requestId: 'provider-milei-punch', modelId: XAI_QA_MOTION_CANARY_MODEL.id }],
          assets: [
            asset('request', requestBytes, 'application/json'),
            asset('response', responseBytes, 'application/json'),
            asset('image', imageBytes, 'image/png'),
          ],
        }), { status: 200 });
      }
      if (path === '/artifacts/request') return new Response(requestBytes, { status: 200 });
      if (path === '/artifacts/response') return new Response(responseBytes, { status: 200 });
      if (path === '/artifacts/image') return new Response(imageBytes, { status: 200 });
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    });

    const options = {
      apiKey: 'test-key',
      apiBase: 'https://pixcli.example',
      candidate,
      manifestPath,
      sourceDir,
      statePath,
      posePath,
      poseUploadStatePath,
      canonicalPath,
      canonicalUploadStatePath,
      outputDir,
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 0,
    };
    const state = await runXaiQaMotionCanary(options);

    expect(state.status).toBe('complete');
    expect(Object.values(state.slots)[0]).toMatchObject({
      status: 'completed',
      pixcliCostEstimate: 0.07,
    });
    expect(uploads).toBe(3);
    expect(submissions).toBe(1);
    expect(modelPreflights).toBe(1);
    expect(submittedPayload).toMatchObject({
      model: 'grok-imagine-image-2-edit',
      image: uploadHashes,
      enrich_prompt: false,
      publish: false,
      publish_name: 'ip-motion-v1-javier-milei-high-punch-f4-grok2qa',
      params: { aspect_ratio: 'auto', resolution: '2k', num_images: 1 },
    });
    expect(submittedPayload.prompt).toContain('exact standing high-punch impact pose from IMAGE 1');

    await runXaiQaMotionCanary(options);
    expect(uploads).toBe(3);
    expect(submissions).toBe(1);
    expect(modelPreflights).toBe(1);
    expect(qaMotionCatalogPreflightRequired(statePath)).toBe(false);
  });

  it('retries only a definitively rolled-back source upload before the single paid submit', async () => {
    const directory = tempDirectory();
    const sourceDir = join(directory, 'sources');
    mkdirSync(sourceDir);
    const sourceBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('licensed-milei-source')]);
    const poseBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('atlas-high-punch-frame-4')]);
    const canonicalBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('approved-milei-canonical')]);
    const candidate = structuredClone(QA_MOTION_CANARY);
    candidate.identity.contentSha256 = sha256(sourceBytes);
    candidate.motion.asset.contentSha256 = sha256(poseBytes);
    candidate.canonical.contentSha256 = sha256(canonicalBytes);
    const controlledManifest = structuredClone(manifest);
    controlledManifest.fighters.find((fighter) => fighter.slug === 'javier-milei').reference.sourceSha256 = sha256(sourceBytes);

    const posePath = join(directory, 'pose.png');
    const canonicalPath = join(directory, 'canonical.png');
    const manifestPath = join(directory, 'manifest.json');
    const statePath = join(directory, 'state.json');
    const poseUploadStatePath = join(directory, 'pose-upload.json');
    const canonicalUploadStatePath = join(directory, 'canonical-upload.json');
    const outputDir = join(directory, 'output');
    writeFileSync(join(sourceDir, 'javier-milei.png'), sourceBytes);
    writeFileSync(posePath, poseBytes);
    writeFileSync(canonicalPath, canonicalBytes);
    writeFileSync(manifestPath, JSON.stringify(controlledManifest));

    let sourceUploadAttempts = 0;
    let submissions = 0;
    const requestBytes = Buffer.from(JSON.stringify({ provider: 'xai', kind: 'request' }));
    const responseBytes = Buffer.from(JSON.stringify({ provider: 'xai', kind: 'response' }));
    const imageBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('milei-high-punch')]);
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === '/api/v1/models') {
        return new Response(JSON.stringify(modelCatalog()), { status: 200 });
      }
      if (init.method === 'POST' && path === '/api/v1/uploads') {
        const form = init.body;
        const filename = form.get('file').name;
        if (filename === 'qa-atlas-high-punch-playback-04-v1.png') {
          return new Response(JSON.stringify({
            hash: 'b'.repeat(32),
            url: `https://pixcli.example/api/v1/assets/${'b'.repeat(32)}`,
            mime_type: 'image/png',
            size: 128,
          }), { status: 201 });
        }
        if (filename === 'gemini-javier-milei-side-clean-v1.png') {
          return new Response(JSON.stringify({
            hash: 'c'.repeat(32),
            url: `https://pixcli.example/api/v1/assets/${'c'.repeat(32)}`,
            mime_type: 'image/png',
            size: 128,
          }), { status: 201 });
        }
        sourceUploadAttempts += 1;
        if (sourceUploadAttempts === 1) {
          return new Response(JSON.stringify({ error: 'Upload storage failed' }), { status: 502 });
        }
        return new Response(JSON.stringify({
          hash: 'a'.repeat(32),
          url: `https://pixcli.example/api/v1/assets/${'a'.repeat(32)}`,
          mime_type: 'image/png',
          size: 128,
        }), { status: 201 });
      }
      if (init.method === 'POST' && path === '/api/v1/edit/advanced') {
        submissions += 1;
        return new Response(JSON.stringify({ job_id: 'job-milei-punch', status: 'pending' }), { status: 202 });
      }
      if (path === '/api/v1/jobs/job-milei-punch') {
        return new Response(JSON.stringify({ job_id: 'job-milei-punch', status: 'completed', cost: 0.07 }), { status: 200 });
      }
      if (path === '/api/v1/jobs/job-milei-punch/canva') {
        const asset = (kind, bytes, mimeType) => ({
          hash: sha256(bytes).slice(0, 32),
          url: `https://pixcli.example/artifacts/${kind}`,
          mime_type: mimeType,
          metadata: kind === 'image' ? {} : {
            artifact_kind: kind === 'request' ? 'provider_request' : 'provider_response',
            content_sha256: sha256(bytes),
            provider_request_id: 'provider-milei-punch',
          },
        });
        return new Response(JSON.stringify({
          job: { job_id: 'job-milei-punch', status: 'completed', cost: 0.07 },
          input: { model: XAI_QA_MOTION_CANARY_MODEL.id },
          provider_runs: [{ requestId: 'provider-milei-punch', modelId: XAI_QA_MOTION_CANARY_MODEL.id }],
          assets: [
            asset('request', requestBytes, 'application/json'),
            asset('response', responseBytes, 'application/json'),
            asset('image', imageBytes, 'image/png'),
          ],
        }), { status: 200 });
      }
      if (path === '/artifacts/request') return new Response(requestBytes, { status: 200 });
      if (path === '/artifacts/response') return new Response(responseBytes, { status: 200 });
      if (path === '/artifacts/image') return new Response(imageBytes, { status: 200 });
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    });
    const options = {
      apiKey: 'test-key',
      apiBase: 'https://pixcli.example',
      candidate,
      manifestPath,
      sourceDir,
      statePath,
      posePath,
      poseUploadStatePath,
      canonicalPath,
      canonicalUploadStatePath,
      outputDir,
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 0,
    };

    await expect(runXaiQaMotionCanary(options)).rejects.toThrow(/source upload failed/i);
    expect(sourceUploadAttempts).toBe(1);
    expect(submissions).toBe(0);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).sources['javier-milei']).toMatchObject({
      status: 'upload_outcome_unknown',
      uploadHttpStatus: 502,
      uploadError: 'Upload storage failed',
    });

    const resumed = await runXaiQaMotionCanary(options);
    expect(resumed.status).toBe('complete');
    expect(sourceUploadAttempts).toBe(2);
    expect(submissions).toBe(1);

    await runXaiQaMotionCanary(options);
    expect(sourceUploadAttempts).toBe(2);
    expect(submissions).toBe(1);
  });
});
