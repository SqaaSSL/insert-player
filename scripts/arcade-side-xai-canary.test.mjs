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
import { BAKEOFF_MODELS } from './arcade-side-bakeoff.mjs';
import {
  XAI_SIDE_CANARY_CONFIRMATION,
  XAI_SIDE_CANARY_EXPERIMENT_ID,
  XAI_SIDE_CANARY_MODEL,
  buildXaiSideCanaryInitialState,
  buildXaiSideCanaryPayload,
  buildXaiSideCanaryPlan,
  buildXaiSideCanaryPrompt,
  runXaiSideCanary,
} from './arcade-side-xai-canary.mjs';

const manifest = JSON.parse(readFileSync(new URL('../arcade/roster-2026.json', import.meta.url), 'utf8'));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const temporaryDirectories = [];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function tempDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'insert-player-xai-side-canary-'));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('XAI realistic-adult SIDE canary', () => {
  it('is sealed to exactly one Trump SIDE request', () => {
    const plan = buildXaiSideCanaryPlan(manifest);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      slotKey: 'donald-trump:grok-imagine-image-2-edit:xai-realistic-adult-v1',
      fighter: { slug: 'donald-trump' },
      model: {
        id: 'grok-imagine-image-2-edit',
        endpoint: 'xai/grok-imagine-image/v2.0/edit',
      },
    });
    expect(XAI_SIDE_CANARY_CONFIRMATION).toBe('ARCADE_SIDE_XAI_TRUMP_REALISTIC_V1');
  });

  it('uses the XAI-only prompt and vertical high-quality composition', () => {
    const [{ fighter, model }] = buildXaiSideCanaryPlan(manifest);
    const prompt = buildXaiSideCanaryPrompt({ fighter, model });
    const payload = buildXaiSideCanaryPayload({
      fighter,
      model,
      sourceAssetHash: 'a'.repeat(32),
      prompt,
    });

    expect(prompt).not.toBe(fighter.referencePrompt);
    expect(payload.prompt).toBe(prompt);
    expect(payload.model).toBe('grok-imagine-image-2-edit');
    expect(payload.image).toBe('a'.repeat(32));
    expect(payload.enrich_prompt).toBe(false);
    expect(payload.publish).toBe(false);
    expect(payload.params).toEqual({
      num_images: 1,
      aspect_ratio: '3:4',
      resolution: '2k',
      output_format: 'png',
      quality: 'medium',
    });
    expect(JSON.stringify(payload)).not.toMatch(/fallback|retry/i);
  });

  it('records a one-call immutable experiment policy', () => {
    const state = buildXaiSideCanaryInitialState('a'.repeat(64));
    expect(state.experimentId).toBe(XAI_SIDE_CANARY_EXPERIMENT_ID);
    expect(state.policy).toEqual({
      expectedPaidCalls: 1,
      retries: 0,
      fallback: 'none',
      promptEnrichment: false,
      activation: false,
    });
  });

  it('keeps the prior 4x2 model configuration untouched', () => {
    const historicalGrok = BAKEOFF_MODELS.find((model) => model.id === 'grok-imagine-image-2-edit');
    expect(historicalGrok.params.aspect_ratio).toBe('1:1');
    expect(historicalGrok.params.resolution).toBe('1k');
    expect(XAI_SIDE_CANARY_MODEL.params.aspect_ratio).toBe('3:4');
    expect(XAI_SIDE_CANARY_MODEL.params.resolution).toBe('2k');
  });

  it('submits exactly one provider request and does not resubmit it on resume', async () => {
    const directory = tempDirectory();
    const sourceDir = join(directory, 'sources');
    mkdirSync(sourceDir);
    const controlledManifest = structuredClone(manifest);
    const sourceBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('licensed-trump-source')]);
    controlledManifest.fighters.find((fighter) => fighter.slug === 'donald-trump').reference.sourceSha256 = sha256(sourceBytes);
    writeFileSync(join(sourceDir, 'donald-trump.png'), sourceBytes);
    const manifestPath = join(directory, 'manifest.json');
    const statePath = join(directory, 'state.json');
    const outputDir = join(directory, 'output');
    writeFileSync(manifestPath, JSON.stringify(controlledManifest));

    let uploaded = 0;
    let submitted = 0;
    let submittedPayload;
    const requestBytes = Buffer.from(JSON.stringify({ provider: 'xai', kind: 'request' }));
    const responseBytes = Buffer.from(JSON.stringify({ provider: 'xai', kind: 'response' }));
    const imageBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('xai-side-output')]);
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (init.method === 'POST' && path === '/api/v1/uploads') {
        uploaded += 1;
        return new Response(JSON.stringify({
          hash: 'a'.repeat(32),
          url: 'https://pixcli.example/api/v1/assets/source',
          mime_type: 'image/png',
          size: sourceBytes.byteLength,
        }), { status: 201 });
      }
      if (init.method === 'POST' && path === '/api/v1/edit/advanced') {
        submitted += 1;
        submittedPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ job_id: 'job-canary', status: 'pending' }), { status: 202 });
      }
      if (path === '/api/v1/jobs/job-canary') {
        return new Response(JSON.stringify({ job_id: 'job-canary', status: 'completed', cost: 0.09 }), { status: 200 });
      }
      if (path === '/api/v1/jobs/job-canary/canva') {
        const asset = (kind, bytes, mimeType) => ({
          hash: sha256(bytes).slice(0, 32),
          url: `https://pixcli.example/artifacts/${kind}`,
          mime_type: mimeType,
          metadata: kind === 'image' ? {} : {
            artifact_kind: kind === 'request' ? 'provider_request' : 'provider_response',
            content_sha256: sha256(bytes),
            provider_request_id: 'provider-request-canary',
          },
        });
        return new Response(JSON.stringify({
          job: { job_id: 'job-canary', status: 'completed', cost: 0.09 },
          input: submittedPayload,
          provider_runs: [{ requestId: 'provider-request-canary', modelId: XAI_SIDE_CANARY_MODEL.id }],
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
      outputDir,
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 0,
    };
    const state = await runXaiSideCanary(options);

    expect(state.status).toBe('complete');
    expect(Object.values(state.slots)).toHaveLength(1);
    expect(Object.values(state.slots)[0].status).toBe('completed');
    expect(uploaded).toBe(1);
    expect(submitted).toBe(1);
    expect(submittedPayload).toMatchObject({
      model: 'grok-imagine-image-2-edit',
      enrich_prompt: false,
      publish: false,
      params: { aspect_ratio: '3:4', resolution: '2k', num_images: 1 },
    });
    expect(submittedPayload.prompt).toContain('never stylize anatomy, head size, apparent age, or identity');

    await runXaiSideCanary(options);
    expect(uploaded).toBe(1);
    expect(submitted).toBe(1);
  });
});
