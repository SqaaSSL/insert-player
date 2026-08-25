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
  BAKEOFF_COHORT,
  BAKEOFF_MODELS,
  buildBakeoffPlan,
  buildPixcliPayload,
  resumeActionForSlot,
  runBakeoff,
  submitBakeoffSlot,
} from './arcade-side-bakeoff.mjs';

const manifest = JSON.parse(readFileSync(new URL('../arcade/roster-2026.json', import.meta.url), 'utf8'));
const temporaryDirectories = [];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function tempDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'insert-player-side-bakeoff-'));
  temporaryDirectories.push(path);
  return path;
}

function invariantFixture() {
  return {
    slotKey: 'donald-trump:grok-imagine-image-2-edit',
    slug: 'donald-trump',
    fighterName: 'Donald Trump',
    modelId: 'grok-imagine-image-2-edit',
    providerEndpoint: 'xai/grok-imagine-image/v2.0/edit',
    sourceSha256: 'a'.repeat(64),
    promptSha256: 'b'.repeat(64),
    requestSha256: 'c'.repeat(64),
  };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Arcade SIDE bakeoff matrix', () => {
  it('is sealed to four fighters, two explicit models, and eight slots', () => {
    expect(BAKEOFF_COHORT).toEqual([
      'donald-trump',
      'cristiano-ronaldo',
      'bad-bunny',
      'mrbeast',
    ]);
    expect(BAKEOFF_MODELS.map((model) => model.id)).toEqual([
      'grok-imagine-image-2-edit',
      'seedream-v5-pro-edit',
    ]);
    const plan = buildBakeoffPlan(manifest);
    expect(plan).toHaveLength(8);
    expect(new Set(plan.map((slot) => slot.slotKey)).size).toBe(8);
  });

  it('sends the exact source prompt without enrichment, fallback, or extra outputs', () => {
    const fighter = manifest.fighters.find((entry) => entry.slug === 'donald-trump');
    const grok = BAKEOFF_MODELS.find((entry) => entry.id === 'grok-imagine-image-2-edit');
    const payload = buildPixcliPayload({
      fighter,
      model: grok,
      sourceAssetHash: 'a'.repeat(32),
    });
    expect(payload.prompt).toBe(fighter.referencePrompt);
    expect(payload.model).toBe('grok-imagine-image-2-edit');
    expect(payload.image).toBe('a'.repeat(32));
    expect(payload.enrich_prompt).toBe(false);
    expect(payload.publish).toBe(false);
    expect(payload.params).toEqual({
      num_images: 1,
      aspect_ratio: '1:1',
      resolution: '1k',
      output_format: 'png',
      quality: 'medium',
    });
    expect(JSON.stringify(payload)).not.toMatch(/fallback|retry/i);
  });

  it('rejects a source hash mismatch before any provider submission', async () => {
    const directory = tempDirectory();
    const sourceDir = join(directory, 'sources');
    mkdirSync(sourceDir);
    const controlledManifest = structuredClone(manifest);
    for (const slug of BAKEOFF_COHORT) {
      const bytes = Buffer.concat([PNG_SIGNATURE, Buffer.from(`source:${slug}`)]);
      const fighter = controlledManifest.fighters.find((entry) => entry.slug === slug);
      fighter.reference.sourceSha256 = sha256(bytes);
      writeFileSync(join(sourceDir, `${slug}.png`), bytes);
    }
    writeFileSync(
      join(sourceDir, 'donald-trump.png'),
      Buffer.concat([PNG_SIGNATURE, Buffer.from('tampered')]),
    );
    const manifestPath = join(directory, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(controlledManifest));
    const fetchImpl = vi.fn();

    await expect(runBakeoff({
      apiKey: 'test-key',
      manifestPath,
      sourceDir,
      statePath: join(directory, 'state.json'),
      outputDir: join(directory, 'output'),
      fetchImpl,
    })).rejects.toThrow(/source hash mismatch/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Arcade SIDE bakeoff submission integrity', () => {
  it('writes submitting state first and performs at most one POST for a known slot', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      job_id: 'job-one',
      status: 'pending',
    }), { status: 202 }));
    const saves = [];
    const options = {
      apiBase: 'https://pixcli.example',
      apiKey: 'test-key',
      payload: { prompt: 'exact', model: 'grok-imagine-image-2-edit' },
      slot: null,
      invariants: invariantFixture(),
      save: (slot) => saves.push(slot),
      fetchImpl,
    };

    const first = await submitBakeoffSlot(options);
    expect(first.action).toBe('submitted');
    expect(saves[0].status).toBe('submitting');
    expect(saves.at(-1)).toMatchObject({ status: 'submitted', pixcliJobId: 'job-one' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST' });

    const resumed = await submitBakeoffSlot({ ...options, slot: first.slot });
    expect(resumed.action).toBe('poll');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed after an ambiguous POST and never submits it again', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connection reset'));
    let persisted;
    const options = {
      apiBase: 'https://pixcli.example',
      apiKey: 'test-key',
      payload: { prompt: 'exact', model: 'grok-imagine-image-2-edit' },
      slot: null,
      invariants: invariantFixture(),
      save: (slot) => { persisted = slot; },
      fetchImpl,
    };

    await expect(submitBakeoffSlot(options)).rejects.toThrow(/automatic retry is forbidden/i);
    expect(persisted.status).toBe('submission_outcome_unknown');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const resumed = await submitBakeoffSlot({ ...options, slot: persisted });
    expect(resumed.action).toBe('block');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('persists an unknown outcome when the submit response cannot be decoded', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>upstream failure</html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    }));
    let persisted;
    await expect(submitBakeoffSlot({
      apiBase: 'https://pixcli.example',
      apiKey: 'test-key',
      payload: { prompt: 'exact', model: 'grok-imagine-image-2-edit' },
      slot: null,
      invariants: invariantFixture(),
      save: (slot) => { persisted = slot; },
      fetchImpl,
    })).rejects.toThrow(/automatic retry is forbidden/i);
    expect(persisted).toMatchObject({
      status: 'submission_outcome_unknown',
      submissionHttpStatus: 502,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('skips every terminal slot without contacting PixCLI', () => {
    expect(resumeActionForSlot({ status: 'completed' })).toBe('skip');
    expect(resumeActionForSlot({ status: 'failed' })).toBe('skip');
    expect(resumeActionForSlot({ status: 'submission_rejected' })).toBe('skip');
  });

  it('completes the sealed matrix with exactly eight POST requests and archives every audit tuple', async () => {
    const directory = tempDirectory();
    const sourceDir = join(directory, 'sources');
    mkdirSync(sourceDir);
    const controlledManifest = structuredClone(manifest);
    for (const slug of BAKEOFF_COHORT) {
      const bytes = Buffer.concat([PNG_SIGNATURE, Buffer.from(`source:${slug}`)]);
      controlledManifest.fighters.find((entry) => entry.slug === slug).reference.sourceSha256 = sha256(bytes);
      writeFileSync(join(sourceDir, `${slug}.png`), bytes);
    }
    const manifestPath = join(directory, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(controlledManifest));

    const jobs = new Map();
    const artifacts = new Map();
    let submitted = 0;
    let uploaded = 0;
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      if (init.method === 'POST' && parsed.pathname === '/api/v1/uploads') {
        uploaded += 1;
        const hash = uploaded.toString(16).padStart(32, '0');
        return new Response(JSON.stringify({
          hash,
          url: `https://pixcli.example/api/v1/assets/${hash}`,
          mime_type: 'image/png',
          size: 100,
        }), { status: 201 });
      }
      if (init.method === 'POST' && parsed.pathname === '/api/v1/edit/advanced') {
        submitted += 1;
        const jobId = `job-${submitted}`;
        jobs.set(jobId, JSON.parse(init.body));
        return new Response(JSON.stringify({ job_id: jobId, status: 'pending' }), { status: 202 });
      }
      const statusMatch = parsed.pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
      if (statusMatch) {
        return new Response(JSON.stringify({
          job_id: statusMatch[1],
          status: 'completed',
          cost: 0.07,
        }), { status: 200 });
      }
      const canvaMatch = parsed.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/canva$/);
      if (canvaMatch) {
        const jobId = canvaMatch[1];
        const payload = jobs.get(jobId);
        const requestBytes = Buffer.from(JSON.stringify({ model: payload.model, input: { prompt: payload.prompt } }));
        const responseBytes = Buffer.from(JSON.stringify({ images: [{ url: `https://cdn.example/${jobId}.png` }] }));
        const imageBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from(jobId)]);
        artifacts.set(`${jobId}-request`, requestBytes);
        artifacts.set(`${jobId}-response`, responseBytes);
        artifacts.set(`${jobId}-image`, imageBytes);
        const asset = (kind, bytes, mimeType) => ({
          hash: sha256(bytes).slice(0, 32),
          url: `https://pixcli.example/artifacts/${jobId}-${kind}`,
          mime_type: mimeType,
          metadata: kind === 'image' ? { model: payload.model } : {
            artifact_kind: kind === 'request' ? 'provider_request' : 'provider_response',
            content_sha256: sha256(bytes),
            provider_request_id: `provider-${jobId}`,
          },
        });
        return new Response(JSON.stringify({
          job: { job_id: jobId, status: 'completed', cost: 0.07 },
          input: payload,
          provider_runs: [{ requestId: `provider-${jobId}`, modelId: payload.model }],
          assets: [
            asset('request', requestBytes, 'application/json'),
            asset('response', responseBytes, 'application/json'),
            asset('image', imageBytes, 'image/png'),
          ],
        }), { status: 200 });
      }
      const artifactMatch = parsed.pathname.match(/^\/artifacts\/(job-\d+)-(request|response|image)$/);
      if (artifactMatch) {
        const bytes = artifacts.get(`${artifactMatch[1]}-${artifactMatch[2]}`);
        return new Response(bytes, { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    });

    const state = await runBakeoff({
      apiKey: 'test-key',
      apiBase: 'https://pixcli.example',
      manifestPath,
      sourceDir,
      statePath: join(directory, 'state.json'),
      outputDir: join(directory, 'output'),
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 0,
    });

    expect(state.status).toBe('complete');
    expect(Object.values(state.slots)).toHaveLength(8);
    expect(Object.values(state.slots).every((slot) => slot.status === 'completed')).toBe(true);
    expect(submitted).toBe(8);
    expect(uploaded).toBe(4);
    expect(fetchImpl.mock.calls.filter(([url, init]) => (
      init?.method === 'POST' && new URL(url).pathname === '/api/v1/edit/advanced'
    ))).toHaveLength(8);
    expect(Object.values(state.slots).every((slot) => (
      slot.artifacts.image
      && slot.artifacts.provider_request
      && slot.artifacts.provider_response
    ))).toBe(true);

    await runBakeoff({
      apiKey: 'test-key',
      apiBase: 'https://pixcli.example',
      manifestPath,
      sourceDir,
      statePath: join(directory, 'state.json'),
      outputDir: join(directory, 'output'),
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 0,
    });
    expect(submitted).toBe(8);
    expect(uploaded).toBe(4);
  });
});
