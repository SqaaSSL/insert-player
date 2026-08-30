import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { submitBakeoffSlot } from './arcade-side-bakeoff.mjs';
import { decryptHumanoidBundle, encryptHumanoidBundle } from './encrypted-humanoid-bundle.mjs';
import {
  HUMANOID_TEMPLATE_CANARY_CONFIRMATION,
  HUMANOID_TEMPLATE_CANARY_FRAMES,
  HUMANOID_TEMPLATE_CANARY_POSE_IDS,
  HUMANOID_TEMPLATE_EXPERIMENT_ID,
  HUMANOID_TEMPLATE_FULL_CONFIRMATION,
  HUMANOID_TEMPLATE_MODEL,
  HUMANOID_TEMPLATE_POLICY,
  HUMANOID_TEMPLATE_PROMPT,
  HUMANOID_TEMPLATE_SOURCE_SHEETS,
  HUMANOID_TEMPLATE_SUBMISSION_TIMEOUT_MS,
  buildHumanoidTemplatePayload,
  parseHumanoidTemplateCliArgs,
  validateCompletedArchive,
  verifyStoredSlotContract,
} from './humanoid-pose-template-xai-batch.mjs';

function canonicalForTest(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalForTest).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalForTest(value[key])}`).join(',')}}`;
}

describe('humanoid Grok pose-template contract', () => {
  it('pins all 98 current Trump HQ forward frames', () => {
    expect(Object.keys(HUMANOID_TEMPLATE_SOURCE_SHEETS)).toHaveLength(11);
    expect(Object.values(HUMANOID_TEMPLATE_SOURCE_SHEETS).reduce((sum, entry) => sum + entry.frameCount, 0)).toBe(98);
    expect(Object.values(HUMANOID_TEMPLATE_SOURCE_SHEETS).every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
  });

  it('uses five hard canaries that are retained in the final plan', () => {
    expect(HUMANOID_TEMPLATE_CANARY_FRAMES).toEqual([
      { animationName: 'walk', frameNumber: 7 },
      { animationName: 'high_kick', frameNumber: 7 },
      { animationName: 'high_kick', frameNumber: 12 },
      { animationName: 'crouch', frameNumber: 6 },
      { animationName: 'ko', frameNumber: 12 },
    ]);
    expect(HUMANOID_TEMPLATE_CANARY_POSE_IDS).toEqual([
      'pose-089-bdcf17fb68d5',
      'pose-012-b0390c8ff88c',
      'pose-017-ed99c6001f85',
      'pose-006-f381aa6fdd00',
      'pose-056-011d4a420454',
    ]);
  });

  it('keeps one stable two-reference prompt without frame chaining', () => {
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('IMAGE 1 is the POSE AND COMPOSITION MASTER only');
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('IMAGE 2 is the APPROVED CANONICAL HUMANOID');
    expect(HUMANOID_TEMPLATE_PROMPT).not.toContain('IMAGE 3');
    expect(HUMANOID_TEMPLATE_PROMPT).not.toMatch(/frame [0-9]/i);
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('zero Donald Trump traits');
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('Background pure #00FF00');
  });

  it('builds the exact maximum-quality raw PixCLI advanced edit payload', () => {
    const payload = buildHumanoidTemplatePayload({
      poseAssetHash: 'a'.repeat(32),
      canonicalAssetHash: 'b'.repeat(32),
      poseId: 'pose-017-ed99c6001f85',
    });
    expect(payload).toEqual({
      prompt: HUMANOID_TEMPLATE_PROMPT,
      model: 'grok-imagine-image-2-edit',
      image: ['a'.repeat(32), 'b'.repeat(32)],
      params: {
        num_images: 1,
        aspect_ratio: 'auto',
        resolution: '2k',
        output_format: 'png',
        quality: 'medium',
      },
      enrich_prompt: false,
      search: false,
      output_format: 'url',
      publish: false,
      publish_name: 'ip-humanoid-template-v2-017',
    });
    expect(HUMANOID_TEMPLATE_MODEL.expectedTwoReferenceCostMicrocredits).toBe(100_000);
    expect(HUMANOID_TEMPLATE_MODEL.catalogMaximumCostMicrocredits).toBe(110_000);
    expect(HUMANOID_TEMPLATE_POLICY.maximumTotalCostMicrocredits).toBe(9_400_000);
    expect(HUMANOID_TEMPLATE_POLICY.automaticRetries).toBe(0);
  });

  it('uses PixCLI 3.4 submission timing and checkpoints before the paid POST', async () => {
    const saves = [];
    const result = await submitBakeoffSlot({
      apiBase: 'https://pixcli.example',
      apiKey: 'test-key',
      payload: { model: HUMANOID_TEMPLATE_MODEL.id },
      slot: null,
      invariants: {
        slotKey: 'pose-001-test:grok',
        slug: 'pose-001-test',
        modelId: HUMANOID_TEMPLATE_MODEL.id,
      },
      requestTimeoutMs: HUMANOID_TEMPLATE_SUBMISSION_TIMEOUT_MS,
      save: (record) => saves.push(record),
      fetchImpl: async () => new Response(JSON.stringify({ job_id: 'job-1', status: 'pending' }), { status: 202 }),
    });
    expect(HUMANOID_TEMPLATE_SUBMISSION_TIMEOUT_MS).toBe(180_000);
    expect(saves[0]).toMatchObject({ status: 'submitting', submissionTimeoutMs: 180_000 });
    expect(result.slot).toMatchObject({ status: 'submitted', pixcliJobId: 'job-1', submissionTimeoutMs: 180_000 });
  });

  it('accepts only one exact sealed PixCLI audit tuple', () => {
    mkdirSync(resolve('.humanoid-template-work'), { recursive: true });
    const directory = mkdtempSync(resolve('.humanoid-template-work/audit-test-'));
    try {
    const active = { pixcliJobId: 'job-1' };
    const job = { status: 'completed', cost: 100_000 };
    const payload = buildHumanoidTemplatePayload({
      poseAssetHash: 'a'.repeat(32),
      canonicalAssetHash: 'b'.repeat(32),
      poseId: 'pose-017-ed99c6001f85',
    });
    const apiBase = 'https://pixcli.example';
    const canvaInput = {
      ...payload,
      image_url: `${apiBase}/api/v1/assets/${'a'.repeat(32)}`,
      image_urls: payload.image.map((hash) => `${apiBase}/api/v1/assets/${hash}`),
      enriched_prompt: payload.prompt,
    };
    const invariants = { requestSha256: 'placeholder' };
    const archivedInputHash = (value) => createHash('sha256').update(canonicalForTest(value)).digest('hex');
    invariants.requestSha256 = archivedInputHash(payload);
    const providerRequest = {
      model: HUMANOID_TEMPLATE_MODEL.endpoint,
      input: { ...payload.params, prompt: payload.prompt, image_urls: canvaInput.image_urls },
      retry_policy: 'none',
      fallback_policy: 'none',
    };
    const sourceUrl = 'https://v3b.fal.media/files/humanoid-output.png';
    const imageBytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes, 0);
    Buffer.from('IHDR').copy(imageBytes, 12);
    imageBytes.writeUInt32BE(1536, 16);
    imageBytes.writeUInt32BE(2048, 20);
    const providerResponse = {
      images: [{
        url: sourceUrl,
        content_type: 'image/png',
        file_name: 'humanoid-output.png',
        file_size: imageBytes.length,
        width: 1536,
        height: 2048,
      }],
      revised_prompt: null,
    };
    const requestPath = join(directory, 'provider-request.json');
    const responsePath = join(directory, 'provider-response.json');
    const imagePath = join(directory, 'output.png');
    writeFileSync(requestPath, JSON.stringify(providerRequest));
    writeFileSync(responsePath, JSON.stringify(providerResponse));
    writeFileSync(imagePath, imageBytes);
    const artifact = (path, mimeType, extra = {}) => {
      const bytes = readFileSync(path);
      return {
        path: relative(resolve('.'), path),
        mimeType,
        contentSha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        ...extra,
      };
    };
    const archived = {
      assetCounts: { provider_request: 1, provider_response: 1, image: 1 },
      canvaInput,
      pixcliInputSha256: archivedInputHash(canvaInput),
      canvaJob: { job_id: 'job-1', status: 'completed', cost: 100_000 },
      providerRuns: [{ requestId: 'provider-1', modelId: HUMANOID_TEMPLATE_MODEL.id, provider: 'fal' }],
      artifacts: {
        provider_request: artifact(requestPath, 'application/json', { providerRequestId: null, modelId: HUMANOID_TEMPLATE_MODEL.id }),
        provider_response: artifact(responsePath, 'application/json', { providerRequestId: 'provider-1', modelId: HUMANOID_TEMPLATE_MODEL.id }),
        image: artifact(imagePath, 'image/png', {
          providerRequestId: null,
          modelId: HUMANOID_TEMPLATE_MODEL.id,
          prompt: payload.prompt,
          sourceUrl,
          declaredSizeBytes: imageBytes.length,
          width: 1536,
          height: 2048,
        }),
      },
    };
    expect(validateCompletedArchive({ archived, active, job, invariants, payload, apiBase })).toEqual([]);
    expect(validateCompletedArchive({
      archived: {
        ...archived,
        assetCounts: { ...archived.assetCounts, image: 2 },
        canvaInput: { ...canvaInput, image_urls: [...canvaInput.image_urls].reverse() },
      },
      active,
      job: { status: 'completed_with_fallback', cost: 110_000 },
      invariants,
      payload,
      apiBase,
    })).toEqual(expect.arrayContaining([
      'provider status completed_with_fallback',
      'job cost 110000',
      'image asset count 2',
      'normalized prompt or reference URLs mismatch',
    ]));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects any restored slot whose sealed request contract changed', () => {
    const expected = {
      slotKey: 'pose-017-ed99c6001f85:grok-imagine-image-2-edit',
      slug: 'pose-017-ed99c6001f85',
      fighterName: 'Humanoid Neutral Medium',
      modelId: HUMANOID_TEMPLATE_MODEL.id,
      providerEndpoint: HUMANOID_TEMPLATE_MODEL.endpoint,
      sourceSha256: 'c'.repeat(64),
      promptSha256: 'd'.repeat(64),
      poseAssetHash: 'a'.repeat(32),
      canonicalAssetHash: 'b'.repeat(32),
      requestSha256: 'e'.repeat(64),
    };
    expect(() => verifyStoredSlotContract({ ...expected }, expected)).not.toThrow();
    expect(() => verifyStoredSlotContract({ ...expected, requestSha256: 'f'.repeat(64) }, expected))
      .toThrow(/requestSha256/);
  });

  it('requires explicit canary/full mode and respects exact paths', () => {
    const parsed = parseHumanoidTemplateCliArgs([
      '--execute',
      '--mode=canary',
      `--confirm=${HUMANOID_TEMPLATE_CANARY_CONFIRMATION}`,
      '--work-dir=/tmp/humanoid-test',
      '--input-dir=/tmp/humanoid-input',
      '--output-dir=/tmp/humanoid-output',
      '--state=/tmp/humanoid-state.json',
    ]);
    expect(parsed.mode).toBe('canary');
    expect(parsed.confirmation).toBe(HUMANOID_TEMPLATE_CANARY_CONFIRMATION);
    expect(parsed.inputDirectory).toBe(resolve('/tmp/humanoid-input'));
    expect(parsed.outputDirectory).toBe(resolve('/tmp/humanoid-output'));
    expect(parsed.statePath).toBe(resolve('/tmp/humanoid-state.json'));
    expect(HUMANOID_TEMPLATE_EXPERIMENT_ID).toBe('humanoid-neutral-medium-xai-template-v2');
    expect(HUMANOID_TEMPLATE_CANARY_CONFIRMATION).toBe('GENERATE_HUMANOID_POSE_TEMPLATE_XAI_CANARY_V2');
    expect(HUMANOID_TEMPLATE_FULL_CONFIRMATION).toBe('GENERATE_HUMANOID_POSE_TEMPLATE_XAI_FULL_V2');
  });

  it('keeps the original QA flow and uses an encrypted, commit-bound, single-use workflow', () => {
    const workflow = readFileSync(resolve('.github/workflows/humanoid-pose-template-xai-production.yml'), 'utf8');
    const original = readFileSync(resolve('.github/workflows/arcade-qa-motion-xai-canary-production.yml'), 'utf8');
    expect(original).toContain('Run production Milei XAI HIGH_PUNCH QA canary');
    expect(workflow).toContain('HUMANOID_ARTIFACT_KEY');
    expect(workflow).toContain('GITHUB_RUN_ATTEMPT');
    expect(workflow).toContain('gh api --paginate');
    expect(workflow).toContain('This exact paid authorization was already consumed');
    expect(workflow).toContain('scripts/encrypted-humanoid-bundle.mjs');
    expect(workflow).toContain('humanoid-neutral-medium-xai-template-v2-encrypted');
    expect(workflow).not.toContain('humanoid-neutral-medium-xai-template-v1-encrypted');
    expect(readFileSync(resolve('scripts/encrypted-humanoid-bundle.mjs'), 'utf8')).toContain("createCipheriv('aes-256-gcm'");
    expect(workflow).not.toContain('path: .humanoid-template-work/');
    expect(workflow).toContain('full_interrupted_manual_review_required');
  });

  it('round-trips authenticated private bundles and rejects tampering', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'humanoid-encryption-'));
    try {
      const source = join(directory, 'source.tar.gz');
      const encrypted = join(directory, 'source.ipenc');
      const restored = join(directory, 'restored.tar.gz');
      writeFileSync(source, Buffer.from('private humanoid checkpoint\n'.repeat(256)));
      const passphrase = 'test-only-passphrase-that-is-deliberately-long-enough';
      await encryptHumanoidBundle({ inputPath: source, outputPath: encrypted, passphrase });
      await decryptHumanoidBundle({ inputPath: encrypted, outputPath: restored, passphrase });
      expect(readFileSync(restored)).toEqual(readFileSync(source));
      const tampered = Buffer.from(readFileSync(encrypted));
      tampered[Math.floor(tampered.length / 2)] ^= 1;
      const tamperedPath = join(directory, 'tampered.ipenc');
      writeFileSync(tamperedPath, tampered);
      await expect(decryptHumanoidBundle({
        inputPath: tamperedPath,
        outputPath: join(directory, 'tampered-output'),
        passphrase,
      })).rejects.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
