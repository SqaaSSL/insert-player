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
  XAI_GLOBAL_SIDE_BATCH_CONFIRMATION,
  XAI_GLOBAL_SIDE_BATCH_EXPERIMENT_ID,
  XAI_GLOBAL_SIDE_BATCH_SLUGS,
  buildXaiGlobalSideBatchInitialState,
  buildXaiGlobalSideBatchPlan,
  runXaiGlobalSideBatch,
} from './arcade-side-xai-global-batch.mjs';

const manifest = JSON.parse(readFileSync(new URL('../arcade/roster-2026.json', import.meta.url), 'utf8'));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const temporaryDirectories = [];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function tempDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'insert-player-xai-global-side-'));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('XAI global identity plus pose-master SIDE batch', () => {
  it('is sealed to four explicit global identities and one provider model', () => {
    const plan = buildXaiGlobalSideBatchPlan(manifest);
    expect(plan.map(({ fighter }) => fighter.slug)).toEqual([
      'cristiano-ronaldo',
      'lionel-messi',
      'bad-bunny',
      'mrbeast',
    ]);
    expect(plan).toHaveLength(4);
    expect(new Set(plan.map(({ slotKey }) => slotKey)).size).toBe(4);
    for (const { model } of plan) {
      expect(model).toMatchObject({
        id: 'grok-imagine-image-2-edit',
        endpoint: 'xai/grok-imagine-image/v2.0/edit',
        promptProfile: 'xai-identity-pose-transfer-v1',
        params: {
          num_images: 1,
          aspect_ratio: 'auto',
          resolution: '2k',
          output_format: 'png',
          quality: 'medium',
        },
      });
    }
    expect(XAI_GLOBAL_SIDE_BATCH_CONFIRMATION).toBe('ARCADE_SIDE_XAI_GLOBAL_4_V1');
  });

  it('records an immutable four-call policy with no retry, fallback, or activation', () => {
    const state = buildXaiGlobalSideBatchInitialState('a'.repeat(64));
    expect(state.experimentId).toBe(XAI_GLOBAL_SIDE_BATCH_EXPERIMENT_ID);
    expect(state.policy).toEqual({
      expectedPaidCalls: 4,
      retries: 0,
      fallback: 'none',
      promptEnrichment: false,
      activation: false,
    });
  });

  it('submits each sealed identity once and performs no paid work on resume', async () => {
    const directory = tempDirectory();
    const sourceDir = join(directory, 'sources');
    mkdirSync(sourceDir);
    const controlledManifest = structuredClone(manifest);
    const sourceAssetHashes = [];
    for (const [index, slug] of XAI_GLOBAL_SIDE_BATCH_SLUGS.entries()) {
      const bytes = Buffer.concat([PNG_SIGNATURE, Buffer.from(`licensed-source-${slug}`)]);
      controlledManifest.fighters.find((fighter) => fighter.slug === slug).reference.sourceSha256 = sha256(bytes);
      writeFileSync(join(sourceDir, `${slug}.png`), bytes);
      sourceAssetHashes.push(String(index + 1).repeat(32));
    }
    const poseMasterBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('approved-pose-master')]);
    const poseMaster = {
      id: 'test-pose-master-v1',
      slug: 'test-pose-master-v1',
      contentSha256: sha256(poseMasterBytes),
    };
    const poseMasterPath = join(directory, 'pose-master.png');
    writeFileSync(poseMasterPath, poseMasterBytes);
    const manifestPath = join(directory, 'manifest.json');
    const statePath = join(directory, 'state.json');
    const poseMasterUploadStatePath = join(directory, 'pose-master-upload.json');
    const outputDir = join(directory, 'output');
    writeFileSync(manifestPath, JSON.stringify(controlledManifest));

    const masterAssetHash = 'f'.repeat(32);
    let uploads = 0;
    const submissions = [];
    const jobs = new Map();
    const artifacts = new Map();
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (init.method === 'POST' && path === '/api/v1/uploads') {
        const hash = uploads === 0 ? masterAssetHash : sourceAssetHashes[uploads - 1];
        uploads += 1;
        return new Response(JSON.stringify({
          hash,
          url: `https://pixcli.example/api/v1/assets/${hash}`,
          mime_type: 'image/png',
          size: 128,
        }), { status: 201 });
      }
      if (init.method === 'POST' && path === '/api/v1/edit/advanced') {
        const payload = JSON.parse(init.body);
        const jobId = `job-${submissions.length + 1}`;
        submissions.push(payload);
        jobs.set(jobId, payload);
        return new Response(JSON.stringify({ job_id: jobId, status: 'pending' }), { status: 202 });
      }
      const jobMatch = path.match(/^\/api\/v1\/jobs\/(job-\d+)$/);
      if (jobMatch) {
        return new Response(JSON.stringify({ job_id: jobMatch[1], status: 'completed', cost: 0.07 }), { status: 200 });
      }
      const canvaMatch = path.match(/^\/api\/v1\/jobs\/(job-\d+)\/canva$/);
      if (canvaMatch) {
        const jobId = canvaMatch[1];
        const createAsset = (kind, mimeType) => {
          const bytes = kind === 'image'
            ? Buffer.concat([PNG_SIGNATURE, Buffer.from(`${jobId}-${kind}`)])
            : Buffer.from(JSON.stringify({ jobId, kind }));
          const assetPath = `/artifacts/${jobId}/${kind}`;
          artifacts.set(assetPath, bytes);
          return {
            hash: sha256(bytes).slice(0, 32),
            url: `https://pixcli.example${assetPath}`,
            mime_type: mimeType,
            metadata: kind === 'image' ? {} : {
              artifact_kind: kind === 'request' ? 'provider_request' : 'provider_response',
              content_sha256: sha256(bytes),
              provider_request_id: `provider-${jobId}`,
            },
          };
        };
        return new Response(JSON.stringify({
          job: { job_id: jobId, status: 'completed', cost: 0.07 },
          input: jobs.get(jobId),
          provider_runs: [{ requestId: `provider-${jobId}`, modelId: 'grok-imagine-image-2-edit' }],
          assets: [
            createAsset('request', 'application/json'),
            createAsset('response', 'application/json'),
            createAsset('image', 'image/png'),
          ],
        }), { status: 200 });
      }
      if (artifacts.has(path)) return new Response(artifacts.get(path), { status: 200 });
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    });

    const options = {
      apiKey: 'test-key',
      apiBase: 'https://pixcli.example',
      manifestPath,
      sourceDir,
      statePath,
      poseMaster,
      poseMasterPath,
      poseMasterUploadStatePath,
      outputDir,
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 0,
    };
    const state = await runXaiGlobalSideBatch(options);

    expect(state.status).toBe('complete');
    expect(Object.values(state.slots)).toHaveLength(4);
    expect(Object.values(state.slots).every((slot) => slot.status === 'completed')).toBe(true);
    expect(uploads).toBe(5);
    expect(submissions).toHaveLength(4);
    for (const [index, payload] of submissions.entries()) {
      expect(payload).toMatchObject({
        model: 'grok-imagine-image-2-edit',
        image: [masterAssetHash, sourceAssetHashes[index]],
        enrich_prompt: false,
        publish: false,
        params: { aspect_ratio: 'auto', resolution: '2k', num_images: 1 },
      });
      expect(payload.prompt).toContain('Never blend the two faces');
    }

    await runXaiGlobalSideBatch(options);
    expect(uploads).toBe(5);
    expect(submissions).toHaveLength(4);
  });
});
