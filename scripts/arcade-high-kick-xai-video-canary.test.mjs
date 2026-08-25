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
  XAI_HIGH_KICK_VIDEO_CONFIRMATION,
  XAI_HIGH_KICK_VIDEO_EXPERIMENT_ID,
  XAI_HIGH_KICK_VIDEO_MODEL,
  XAI_HIGH_KICK_VIDEO_PLAYBACK,
  buildXaiHighKickVideoPayload,
  buildXaiHighKickVideoPlan,
  buildXaiHighKickVideoPrompt,
  clearGeneratedFrames,
  runXaiHighKickVideoCanary,
  selectFrameIndices,
  selectMotionFrameIndices,
  validateMotionFrameIndices,
  validatePinnedProviderRequestAudit,
  validatePinnedVideoAudit,
} from './arcade-high-kick-xai-video-canary.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const temporaryDirectories = [];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function tempDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'insert-player-xai-video-'));
  temporaryDirectories.push(path);
  return path;
}

function jsonAsset(kind, bytes) {
  return {
    hash: sha256(bytes).slice(0, 32),
    url: `https://pixcli.example/artifacts/${kind}`,
    mime_type: 'application/json',
    metadata: {
      artifact_kind: kind === 'request' ? 'provider_request' : 'provider_response',
      content_sha256: sha256(bytes),
      model: XAI_HIGH_KICK_VIDEO_MODEL.id,
      provider_request_id: 'provider-video-1',
    },
  };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('XAI HIGH_KICK video sprite canary', () => {
  it('seals one pinned Grok call with no fallback, retry, enrichment, or activation', () => {
    const plan = buildXaiHighKickVideoPlan();
    expect(plan).toMatchObject({
      experimentId: XAI_HIGH_KICK_VIDEO_EXPERIMENT_ID,
      fighter: 'donald-trump',
      action: 'high_kick',
      model: {
        id: 'grok-imagine-i2v-pinned',
        endpoint: 'xai/grok-imagine-video/v1.5/image-to-video',
        durationSeconds: 2,
        resolution: '720p',
        pixcliReservedMicrocredits: 330000,
        pixcliReservedUsd: 0.33,
      },
      extraction: {
        uniqueFrames: 4,
        playback: [0, 1, 2, 3, 2, 1, 0],
      },
      policy: {
        expectedPaidCalls: 1,
        providerRetries: 0,
        fallback: 'none',
        promptEnrichment: false,
        activation: false,
        productionPointers: false,
      },
    });
    expect(XAI_HIGH_KICK_VIDEO_CONFIRMATION).toBe('ARCADE_HIGH_KICK_XAI_VIDEO_V1');

    const payload = buildXaiHighKickVideoPayload('a'.repeat(32));
    expect(payload).toEqual({
      prompt: buildXaiHighKickVideoPrompt(),
      model: XAI_HIGH_KICK_VIDEO_MODEL.id,
      image: 'a'.repeat(32),
      resolution: '720p',
      params: { duration: 2, resolution: '720p' },
      enrich_prompt: false,
      output_format: 'url',
      publish: false,
      publish_name: 'ip-trump-high-kick-xai-video-v1',
    });
    expect(payload.prompt).toContain('Do not retract the kick or return to idle');
    expect(payload.prompt).toContain('Do not introduce or duplicate limbs');
    expect(JSON.stringify(payload)).not.toMatch(/allow_fallback|retry/i);
  });

  it('selects deterministic motion frames while deriving F0 only from the canonical', () => {
    expect(selectFrameIndices(16, 4)).toEqual([0, 5, 10, 15]);
    expect(selectMotionFrameIndices(16)).toEqual([5, 10, 14]);
    expect(validateMotionFrameIndices([4, 9, 13], 16)).toEqual([4, 9, 13]);
    expect(XAI_HIGH_KICK_VIDEO_PLAYBACK).toEqual([0, 1, 2, 3, 2, 1, 0]);
    expect(() => selectMotionFrameIndices(3)).toThrow(/Cannot select/);
    expect(() => validateMotionFrameIndices([4, 4, 13], 16)).toThrow(/strictly ascending/);
  });

  it('requires one and only one pinned FAL provider run tied to its audit response', () => {
    const requestBytes = Buffer.from('{}');
    const responseBytes = Buffer.from('{"ok":true}');
    const video = {
      hash: 'd'.repeat(32),
      url: 'https://pixcli.example/video.mp4',
      mime_type: 'video/mp4',
      metadata: {
        model: XAI_HIGH_KICK_VIDEO_MODEL.id,
        provider_request_id: 'fal-request-1',
      },
    };
    const canva = {
      provider_runs: [{
        provider: 'fal',
        requestId: 'fal-request-1',
        modelId: XAI_HIGH_KICK_VIDEO_MODEL.id,
      }],
      assets: [
        jsonAsset('request', requestBytes),
        jsonAsset('response', responseBytes),
        video,
      ],
    };
    canva.assets[0].metadata.provider_request_id = undefined;
    canva.assets[1].metadata.provider_request_id = 'fal-request-1';
    expect(validatePinnedVideoAudit(canva).providerRequestId).toBe('fal-request-1');
    expect(() => validatePinnedVideoAudit({
      ...canva,
      provider_runs: [...canva.provider_runs, { ...canva.provider_runs[0], requestId: 'fal-request-2' }],
    })).toThrow(/exactly one provider run/);
    expect(() => validatePinnedVideoAudit({
      ...canva,
      provider_runs: [{ ...canva.provider_runs[0], provider: 'google-veo' }],
    })).toThrow(/unexpected provider/);
    expect(() => validatePinnedVideoAudit({
      ...canva,
      assets: canva.assets.map((asset, index) => index === 1
        ? { ...asset, metadata: { ...asset.metadata, provider_request_id: 'different-request' } }
        : asset),
    })).toThrow(/sole provider run/);
    expect(() => validatePinnedVideoAudit({
      ...canva,
      assets: canva.assets.map((asset, index) => index === 2
        ? { ...asset, metadata: { ...asset.metadata, provider_request_id: 'different-request' } }
        : asset),
    })).toThrow(/sole pinned provider run/);
  });

  it('validates the exact request PixCLI sent to the pinned FAL endpoint', () => {
    const expectedAssetHash = 'a'.repeat(32);
    const audit = {
      model: XAI_HIGH_KICK_VIDEO_MODEL.endpoint,
      input: {
        prompt: buildXaiHighKickVideoPrompt(),
        image_url: `https://pixcli.example/api/v1/assets/${expectedAssetHash}?expires=2000000000&signature=signed`,
        duration: 2,
        resolution: '720p',
      },
      retry_policy: 'none',
      fallback_policy: 'none',
    };
    const options = {
      expectedAssetHash,
      expectedApiBase: 'https://pixcli.example',
    };
    expect(validatePinnedProviderRequestAudit(audit, options)).toBe(audit);
    expect(() => validatePinnedProviderRequestAudit({
      ...audit,
      model: 'xai/grok-imagine-video/v1.5/text-to-video',
    }, options)).toThrow(/sealed Grok I2V payload/);
    expect(() => validatePinnedProviderRequestAudit({
      ...audit,
      input: { ...audit.input, duration: 3 },
    }, options)).toThrow(/sealed Grok I2V payload/);
    expect(() => validatePinnedProviderRequestAudit({
      ...audit,
      input: { ...audit.input, image_url: `https://pixcli.example/api/v1/assets/${'b'.repeat(32)}` },
    }, options)).toThrow(/sealed Grok I2V payload/);
    expect(() => validatePinnedProviderRequestAudit({
      ...audit,
      input: { ...audit.input, seed: 1234 },
    }, options)).toThrow(/sealed Grok I2V payload/);
  });

  it('removes only stale generated frames before decoding a new video', () => {
    const directory = tempDirectory();
    writeFileSync(join(directory, 'frame-001.png'), Buffer.from('old-1'));
    writeFileSync(join(directory, 'frame-999.png'), Buffer.from('old-999'));
    writeFileSync(join(directory, 'keep.txt'), Buffer.from('keep'));
    clearGeneratedFrames(directory);
    expect(existsSync(join(directory, 'frame-001.png'))).toBe(false);
    expect(existsSync(join(directory, 'frame-999.png'))).toBe(false);
    expect(readFileSync(join(directory, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('submits exactly once, archives the pinned provider run, extracts locally, and resumes for free', async () => {
    const directory = tempDirectory();
    const outputDir = join(directory, 'output');
    const statePath = join(directory, 'state.json');
    const canonicalPath = join(directory, 'canonical.png');
    const canonicalBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('approved-trump-canonical')]);
    const canonical = {
      id: 'test-trump-canonical',
      slug: 'test-trump-canonical',
      contentSha256: sha256(canonicalBytes),
    };
    writeFileSync(canonicalPath, canonicalBytes);

    const requestBytes = Buffer.from(JSON.stringify({
      model: XAI_HIGH_KICK_VIDEO_MODEL.endpoint,
      input: {
        prompt: buildXaiHighKickVideoPrompt(),
        image_url: `https://pixcli.example/api/v1/assets/${'a'.repeat(32)}`,
        duration: 2,
        resolution: '720p',
      },
      retry_policy: 'none',
      fallback_policy: 'none',
    }));
    const responseBytes = Buffer.from(JSON.stringify({ provider: 'fal', response: true }));
    const videoBytes = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from('ftypisom'),
      Buffer.from('mock-mp4-video'),
    ]);
    let submissions = 0;
    let submittedPayload;
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (init.method === 'POST' && path === '/api/v1/video/advanced') {
        submissions += 1;
        submittedPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ job_id: 'job-video-1', status: 'pending' }), { status: 202 });
      }
      if (path === '/api/v1/jobs/job-video-1') {
        return new Response(JSON.stringify({ job_id: 'job-video-1', status: 'completed', cost: 330000 }), { status: 200 });
      }
      if (path === '/api/v1/jobs/job-video-1/canva') {
        return new Response(JSON.stringify({
          job: { job_id: 'job-video-1', status: 'completed', cost: 330000 },
          input: submittedPayload,
          provider_runs: [{ provider: 'fal', requestId: 'provider-video-1', modelId: XAI_HIGH_KICK_VIDEO_MODEL.id }],
          assets: [
            jsonAsset('request', requestBytes),
            jsonAsset('response', responseBytes),
            {
              hash: sha256(videoBytes).slice(0, 32),
              url: 'https://pixcli.example/artifacts/video',
              mime_type: 'video/mp4',
              metadata: {
                content_sha256: sha256(videoBytes),
                model: XAI_HIGH_KICK_VIDEO_MODEL.id,
                provider_request_id: 'provider-video-1',
              },
            },
          ],
        }), { status: 200 });
      }
      if (path === '/artifacts/request') return new Response(requestBytes, { status: 200 });
      if (path === '/artifacts/response') return new Response(responseBytes, { status: 200 });
      if (path === '/artifacts/video') return new Response(videoBytes, { status: 200 });
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    });
    const extraction = {
      schemaVersion: 1,
      canonicalDerivedF0: true,
      selectedIndices: [5, 10, 14],
      playback: [...XAI_HIGH_KICK_VIDEO_PLAYBACK],
    };
    const extractVideoImpl = vi.fn(async (options) => {
      expect(readFileSync(options.videoPath)).toEqual(videoBytes);
      expect(options.canonicalPath).toBe(canonicalPath);
      mkdirSync(options.outputDir, { recursive: true });
      return extraction;
    });
    const ensureUploadImpl = vi.fn(async () => ({ pixcliAssetHash: 'a'.repeat(32) }));
    const options = {
      apiKey: 'test-key',
      apiBase: 'https://pixcli.example',
      canonical,
      canonicalPath,
      statePath,
      outputDir,
      fetchImpl,
      ensureUploadImpl,
      extractVideoImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 0,
    };

    const first = await runXaiHighKickVideoCanary(options);
    expect(first.status).toBe('completed');
    expect(first.pixcliCostEstimate).toBe(330000);
    expect(first.extraction).toEqual(extraction);
    expect(first.providerRuns).toEqual([
      { provider: 'fal', requestId: 'provider-video-1', modelId: XAI_HIGH_KICK_VIDEO_MODEL.id },
    ]);
    expect(first.artifacts.video.contentSha256).toBe(sha256(videoBytes));
    expect(submissions).toBe(1);
    expect(extractVideoImpl).toHaveBeenCalledOnce();
    expect(submittedPayload).toMatchObject({
      model: 'grok-imagine-i2v-pinned',
      image: 'a'.repeat(32),
      resolution: '720p',
      params: { duration: 2, resolution: '720p' },
      enrich_prompt: false,
      publish: false,
    });

    const second = await runXaiHighKickVideoCanary(options);
    expect(second.status).toBe('completed');
    expect(submissions).toBe(1);
    expect(extractVideoImpl).toHaveBeenCalledOnce();
  });

  it('never repeats a submission whose outcome is ambiguous', async () => {
    const directory = tempDirectory();
    const canonicalPath = join(directory, 'canonical.png');
    const canonicalBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('canonical-ambiguous')]);
    const canonical = {
      id: 'canonical-ambiguous',
      slug: 'canonical-ambiguous',
      contentSha256: sha256(canonicalBytes),
    };
    writeFileSync(canonicalPath, canonicalBytes);
    let submissions = 0;
    const fetchImpl = vi.fn(async (_url, init = {}) => {
      if (init.method === 'POST') {
        submissions += 1;
        throw new Error('connection lost after dispatch');
      }
      throw new Error('unexpected read');
    });
    const options = {
      apiKey: 'test-key',
      apiBase: 'https://pixcli.example',
      canonical,
      canonicalPath,
      statePath: join(directory, 'state.json'),
      outputDir: join(directory, 'output'),
      fetchImpl,
      ensureUploadImpl: async () => ({ pixcliAssetHash: 'b'.repeat(32) }),
    };
    await expect(runXaiHighKickVideoCanary(options)).rejects.toThrow(/outcome is unknown/);
    await expect(runXaiHighKickVideoCanary(options)).rejects.toThrow(/ambiguous/);
    expect(submissions).toBe(1);
    expect(JSON.parse(readFileSync(options.statePath, 'utf8')).status).toBe('submission_outcome_unknown');
  });

  it('uses an exclusive filesystem lock so two processes cannot both submit', async () => {
    const directory = tempDirectory();
    const canonicalPath = join(directory, 'canonical.png');
    const canonicalBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('canonical-lock')]);
    const canonical = {
      id: 'canonical-lock',
      slug: 'canonical-lock',
      contentSha256: sha256(canonicalBytes),
    };
    writeFileSync(canonicalPath, canonicalBytes);
    let releasePost;
    let signalPostStarted;
    const postStarted = new Promise((resolveStarted) => { signalPostStarted = resolveStarted; });
    const postGate = new Promise((resolvePost) => { releasePost = resolvePost; });
    let submissions = 0;
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (init.method === 'POST') {
        submissions += 1;
        signalPostStarted();
        await postGate;
        return new Response(JSON.stringify({ job_id: 'job-lock' }), { status: 202 });
      }
      if (path === '/api/v1/jobs/job-lock') {
        return new Response(JSON.stringify({ status: 'failed', error: 'fixture terminal' }), { status: 200 });
      }
      throw new Error('unexpected request');
    });
    const options = {
      apiKey: 'test-key',
      apiBase: 'https://pixcli.example',
      canonical,
      canonicalPath,
      statePath: join(directory, 'state.json'),
      outputDir: join(directory, 'output'),
      fetchImpl,
      ensureUploadImpl: async () => ({ pixcliAssetHash: 'e'.repeat(32) }),
      sleepImpl: async () => {},
      pollIntervalMs: 0,
    };
    const firstRun = runXaiHighKickVideoCanary(options);
    await postStarted;
    await expect(runXaiHighKickVideoCanary(options)).rejects.toThrow(/already locked/);
    releasePost();
    expect((await firstRun).status).toBe('failed');
    expect(submissions).toBe(1);
    expect(existsSync(`${options.statePath}.lock`)).toBe(false);
  });

  it('rejects completed_with_fallback instead of accepting a different video model', async () => {
    const directory = tempDirectory();
    const canonicalPath = join(directory, 'canonical.png');
    const canonicalBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('canonical-fallback')]);
    const canonical = {
      id: 'canonical-fallback',
      slug: 'canonical-fallback',
      contentSha256: sha256(canonicalBytes),
    };
    writeFileSync(canonicalPath, canonicalBytes);
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (init.method === 'POST') {
        return new Response(JSON.stringify({ job_id: 'job-fallback' }), { status: 202 });
      }
      if (path === '/api/v1/jobs/job-fallback') {
        return new Response(JSON.stringify({ status: 'completed_with_fallback' }), { status: 200 });
      }
      throw new Error('unexpected request');
    });
    const statePath = join(directory, 'state.json');
    await expect(runXaiHighKickVideoCanary({
      apiKey: 'test-key',
      apiBase: 'https://pixcli.example',
      canonical,
      canonicalPath,
      statePath,
      outputDir: join(directory, 'output'),
      fetchImpl,
      ensureUploadImpl: async () => ({ pixcliAssetHash: 'c'.repeat(32) }),
      sleepImpl: async () => {},
      pollIntervalMs: 0,
    })).rejects.toThrow(/forbidden fallback/);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).status).toBe('failed');
  });
});
