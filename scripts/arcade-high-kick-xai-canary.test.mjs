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
  XAI_HIGH_KICK_CANARY_CONFIRMATION,
  XAI_HIGH_KICK_CANARY_EXPERIMENT_ID,
  XAI_HIGH_KICK_CANARY_MODEL,
  XAI_HIGH_KICK_CANONICAL,
  buildXaiHighKickCanaryInitialState,
  buildXaiHighKickCanaryPayload,
  buildXaiHighKickCanaryPlan,
  buildXaiHighKickCanaryPrompt,
  runXaiHighKickCanary,
} from './arcade-high-kick-xai-canary.mjs';
import {
  XAI_HIGH_KICK_IMPACT_POSE_MASTER,
  verifyXaiMotionMasterBytes,
} from './fetch-arcade-motion-master.mjs';

const manifest = JSON.parse(readFileSync(new URL('../arcade/roster-2026.json', import.meta.url), 'utf8'));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const temporaryDirectories = [];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function tempDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'insert-player-xai-high-kick-'));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('XAI Trump HIGH_KICK three-reference canary', () => {
  it('is sealed to one Trump impact frame and three ordered reference roles', () => {
    const plan = buildXaiHighKickCanaryPlan(manifest);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      slotKey: 'donald-trump:high_kick:impact:grok-imagine-image-2-edit:xai-canonical-motion-transfer-v1',
      fighter: { slug: 'donald-trump' },
      model: {
        id: 'grok-imagine-image-2-edit',
        endpoint: 'xai/grok-imagine-image/v2.0/edit',
      },
    });
    expect(plan[0].model.referenceInputs).toEqual([
      {
        role: 'motion_pose_composition_master',
        id: XAI_HIGH_KICK_IMPACT_POSE_MASTER.id,
        contentSha256: XAI_HIGH_KICK_IMPACT_POSE_MASTER.contentSha256,
      },
      {
        role: 'canonical_character_rendering_master',
        id: XAI_HIGH_KICK_CANONICAL.id,
        contentSha256: XAI_HIGH_KICK_CANONICAL.contentSha256,
      },
    ]);
    expect(XAI_HIGH_KICK_CANARY_CONFIRMATION).toBe('ARCADE_HIGH_KICK_XAI_TRUMP_IMPACT_V1');
  });

  it('orders pose, canonical character, and real identity in the provider payload', () => {
    const [{ fighter, model }] = buildXaiHighKickCanaryPlan(manifest);
    const prompt = buildXaiHighKickCanaryPrompt({ fighter, model });
    const payload = buildXaiHighKickCanaryPayload({
      fighter,
      model,
      sourceAssetHash: 'a'.repeat(32),
      motionMasterAssetHash: 'b'.repeat(32),
      canonicalAssetHash: 'c'.repeat(32),
      prompt,
    });

    expect(payload.image).toEqual(['b'.repeat(32), 'c'.repeat(32), 'a'.repeat(32)]);
    expect(payload.enrich_prompt).toBe(false);
    expect(payload.publish).toBe(false);
    expect(payload.params).toEqual({
      num_images: 1,
      aspect_ratio: 'auto',
      resolution: '2k',
      output_format: 'png',
      quality: 'medium',
    });
    expect(prompt).toContain('IMAGE 1 is the MOTION POSE AND COMPOSITION MASTER only');
    expect(prompt).toContain('IMAGE 2 is the APPROVED CANONICAL CHARACTER AND RENDERING MASTER');
    expect(prompt).toContain('IMAGE 3 is the REAL IDENTITY SAFEGUARD only');
    expect(JSON.stringify(payload)).not.toMatch(/fallback|retry/i);
  });

  it('records a one-call immutable experiment policy', () => {
    const state = buildXaiHighKickCanaryInitialState('a'.repeat(64));
    expect(state.experimentId).toBe(XAI_HIGH_KICK_CANARY_EXPERIMENT_ID);
    expect(state.policy).toEqual({
      expectedPaidCalls: 1,
      retries: 0,
      fallback: 'none',
      promptEnrichment: false,
      activation: false,
    });
  });

  it('submits one three-reference frame and performs no paid work on resume', async () => {
    const directory = tempDirectory();
    const sourceDir = join(directory, 'sources');
    mkdirSync(sourceDir);
    const controlledManifest = structuredClone(manifest);
    const sourceBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('licensed-trump-source')]);
    const motionBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('high-kick-impact-master')]);
    const canonicalBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('approved-trump-canonical')]);
    const motionMaster = {
      id: 'test-high-kick-impact',
      slug: 'test-high-kick-impact',
      contentSha256: sha256(motionBytes),
    };
    const canonical = {
      id: 'test-trump-canonical',
      slug: 'test-trump-canonical',
      contentSha256: sha256(canonicalBytes),
    };
    controlledManifest.fighters.find((fighter) => fighter.slug === 'donald-trump').reference.sourceSha256 = sha256(sourceBytes);
    writeFileSync(join(sourceDir, 'donald-trump.png'), sourceBytes);
    const motionMasterPath = join(directory, 'motion.png');
    const canonicalPath = join(directory, 'canonical.png');
    writeFileSync(motionMasterPath, motionBytes);
    writeFileSync(canonicalPath, canonicalBytes);
    expect(verifyXaiMotionMasterBytes(motionBytes, motionMaster)).toBe(motionMaster.contentSha256);
    const manifestPath = join(directory, 'manifest.json');
    const statePath = join(directory, 'state.json');
    const motionMasterUploadStatePath = join(directory, 'motion-upload.json');
    const canonicalUploadStatePath = join(directory, 'canonical-upload.json');
    const outputDir = join(directory, 'output');
    writeFileSync(manifestPath, JSON.stringify(controlledManifest));

    const uploadHashes = ['b'.repeat(32), 'c'.repeat(32), 'a'.repeat(32)];
    let uploads = 0;
    let submissions = 0;
    let submittedPayload;
    const requestBytes = Buffer.from(JSON.stringify({ provider: 'xai', kind: 'request' }));
    const responseBytes = Buffer.from(JSON.stringify({ provider: 'xai', kind: 'response' }));
    const imageBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('trump-high-kick-impact')]);
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
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
        return new Response(JSON.stringify({ job_id: 'job-high-kick', status: 'pending' }), { status: 202 });
      }
      if (path === '/api/v1/jobs/job-high-kick') {
        return new Response(JSON.stringify({ job_id: 'job-high-kick', status: 'completed', cost: 0.07 }), { status: 200 });
      }
      if (path === '/api/v1/jobs/job-high-kick/canva') {
        const asset = (kind, bytes, mimeType) => ({
          hash: sha256(bytes).slice(0, 32),
          url: `https://pixcli.example/artifacts/${kind}`,
          mime_type: mimeType,
          metadata: kind === 'image' ? {} : {
            artifact_kind: kind === 'request' ? 'provider_request' : 'provider_response',
            content_sha256: sha256(bytes),
            provider_request_id: 'provider-high-kick',
          },
        });
        return new Response(JSON.stringify({
          job: { job_id: 'job-high-kick', status: 'completed', cost: 0.07 },
          input: submittedPayload,
          provider_runs: [{ requestId: 'provider-high-kick', modelId: XAI_HIGH_KICK_CANARY_MODEL.id }],
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
      manifestPath,
      sourceDir,
      statePath,
      motionMaster,
      motionMasterPath,
      motionMasterUploadStatePath,
      canonical,
      canonicalPath,
      canonicalUploadStatePath,
      outputDir,
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 0,
    };
    const state = await runXaiHighKickCanary(options);

    expect(state.status).toBe('complete');
    expect(Object.values(state.slots)[0].status).toBe('completed');
    expect(uploads).toBe(3);
    expect(submissions).toBe(1);
    expect(submittedPayload).toMatchObject({
      model: 'grok-imagine-image-2-edit',
      image: uploadHashes,
      enrich_prompt: false,
      publish: false,
      params: { aspect_ratio: 'auto', resolution: '2k', num_images: 1 },
    });
    expect(submittedPayload.prompt).toContain('same canonical character from IMAGE 2');

    await runXaiHighKickCanary(options);
    expect(uploads).toBe(3);
    expect(submissions).toBe(1);
  });
});
