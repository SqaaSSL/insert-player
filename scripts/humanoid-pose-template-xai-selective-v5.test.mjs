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
  HUMANOID_TEMPLATE_IDENTITY_CROP,
  HUMANOID_TEMPLATE_MODEL,
  HUMANOID_TEMPLATE_POLICY,
  HUMANOID_TEMPLATE_POSE_FOCUS,
  HUMANOID_TEMPLATE_PROMPT,
  HUMANOID_TEMPLATE_SOURCE_SHEETS,
  HUMANOID_TEMPLATE_SUBMISSION_TIMEOUT_MS,
  buildHumanoidTemplatePayload,
  buildHumanoidTemplatePoseDirective,
  buildHumanoidTemplatePrompt,
  buildPoseFocusTransform,
  compositeRgbaOnChroma,
  findOpaqueChromaBounds,
  parseHumanoidTemplateCliArgs,
  validateCompletedArchive,
  verifyStoredSlotContract,
} from './humanoid-pose-template-xai-selective-v5.mjs';

function canonicalForTest(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalForTest).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalForTest(value[key])}`).join(',')}}`;
}

function poseForTest(animationName, frameNumber, poseId = 'pose-007-8a6769c69246') {
  return { poseId, sourceSlots: [{ animationName, frameNumber }] };
}

describe('humanoid Grok V5 selective pose-repair canary contract', () => {
  it('pins all 98 current Trump HQ forward frames', () => {
    expect(Object.keys(HUMANOID_TEMPLATE_SOURCE_SHEETS)).toHaveLength(11);
    expect(Object.values(HUMANOID_TEMPLATE_SOURCE_SHEETS).reduce((sum, entry) => sum + entry.frameCount, 0)).toBe(98);
    expect(Object.values(HUMANOID_TEMPLATE_SOURCE_SHEETS).every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
  });

  it('targets exactly the five reviewed V4 semantic failures', () => {
    expect(HUMANOID_TEMPLATE_CANARY_FRAMES).toEqual([
      { animationName: 'high_kick', frameNumber: 2 },
      { animationName: 'high_punch', frameNumber: 5 },
      { animationName: 'ko', frameNumber: 6 },
      { animationName: 'low_punch', frameNumber: 7 },
      { animationName: 'victory', frameNumber: 10 },
    ]);
    expect(HUMANOID_TEMPLATE_CANARY_POSE_IDS).toEqual([
      'pose-007-8a6769c69246',
      'pose-022-df0e781f8635',
      'pose-050-3403e3eacd1f',
      'pose-071-138071f13b72',
      'pose-080-592f648f729a',
    ]);
  });

  it('locks the focused pose ahead of the arm-free identity reference', () => {
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('POSE OVERRIDES EVERYTHING');
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('EDIT IMAGE 1 ONLY');
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('sole source of action, silhouette, joint and limb geometry');
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('Do not preserve IMAGE 1\'s person, clothing, absolute canvas scale, or margins');
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('IMAGE 2 is a head, neck, and upper-shoulders crop with no arms, hands, guard, legs, or feet');
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('Never infer a neutral guard from IMAGE 2');
    expect(HUMANOID_TEMPLATE_PROMPT).not.toContain('IMAGE 3');
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('OUTFIT LOCK:');
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('ZERO visible skin exists below either ankle');
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('IDENTITY LOCK:');
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('Use it only for the exact skull, jaw, nose, lips, eyes, ears, skin tone, apparent age');
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('fully encloses both anatomically complete feet and every toe');
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('continue uninterrupted from each leg over each ankle and entire foot');
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('zero bare skin, toenails, soles, socks, shoes, or separate foot coverings');
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('Remove every Donald Trump trait');
    expect(HUMANOID_TEMPLATE_PROMPT).toContain('pure #00FF00');

    const checks = [
      ['high_kick', 2, /HIGH KICK FRAME 2.*pre-kick guard.*Do not raise a knee/i],
      ['high_punch', 5, /HIGH PUNCH FRAME 5.*fully extended straight punching arm.*neutral guard/i],
      ['ko', 6, /KO FRAME 6.*airborne and falling diagonally.*zero foot contact/i],
      ['low_punch', 7, /LOW PUNCH FRAME 7.*deep squat.*fully extended straight punch/i],
      ['victory', 10, /VICTORY FRAME 10.*head tipped upward.*fists held low beside the hips/i],
    ];
    for (const [animationName, frameNumber, expected] of checks) {
      const pose = poseForTest(animationName, frameNumber);
      expect(buildHumanoidTemplatePoseDirective(pose)).toMatch(expected);
      expect(buildHumanoidTemplatePrompt(pose)).toBe(`${HUMANOID_TEMPLATE_PROMPT}\n\n${buildHumanoidTemplatePoseDirective(pose)}`);
    }
  });

  it('builds the exact maximum-quality raw PixCLI advanced edit payload', () => {
    const pose = poseForTest('high_kick', 12);
    const payload = buildHumanoidTemplatePayload({
      poseAssetHash: 'a'.repeat(32),
      identityAssetHash: 'b'.repeat(32),
      pose,
    });
    expect(payload).toEqual({
      prompt: buildHumanoidTemplatePrompt(pose),
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
      publish_name: 'ip-humanoid-selective-v5-007',
    });
    expect(HUMANOID_TEMPLATE_MODEL.expectedTwoReferenceCostMicrocredits).toBe(100_000);
    expect(HUMANOID_TEMPLATE_MODEL.catalogMaximumCostMicrocredits).toBe(110_000);
    expect(HUMANOID_TEMPLATE_POLICY.maximumTotalCostMicrocredits).toBe(500_000);
    expect(HUMANOID_TEMPLATE_POLICY.catalogMaximumTotalCostMicrocredits).toBe(550_000);
    expect(HUMANOID_TEMPLATE_POLICY.paidCalls).toBe(5);
    expect(HUMANOID_TEMPLATE_POLICY.reviewedRepairSetPaidCalls).toBe(24);
    expect(HUMANOID_TEMPLATE_POLICY.reviewedRepairSetExpectedCostMicrocredits).toBe(2_400_000);
    expect(HUMANOID_TEMPLATE_POLICY.fullBatch).toBe(false);
    expect(HUMANOID_TEMPLATE_POLICY.import).toBe(false);
    expect(HUMANOID_TEMPLATE_POLICY.activation).toBe(false);
    expect(HUMANOID_TEMPLATE_POLICY.automaticRetries).toBe(0);
  });

  it('composites transparent pose pixels onto exact RGB24 #00FF00', () => {
    const rgba = Buffer.from([
      12, 34, 56, 0,
      255, 0, 0, 255,
      255, 0, 0, 128,
    ]);
    expect([...compositeRgbaOnChroma(rgba, 3, 1)]).toEqual([
      0, 255, 0,
      255, 0, 0,
      128, 127, 0,
    ]);
  });

  it('derives a tight aspect-safe pose crop and an invertible registration record', () => {
    const width = 12;
    const height = 16;
    const rgb = Buffer.alloc(width * height * 3);
    for (let offset = 0; offset < rgb.length; offset += 3) rgb[offset + 1] = 255;
    for (let y = 5; y <= 8; y += 1) {
      for (let x = 4; x <= 6; x += 1) {
        const offset = ((y * width) + x) * 3;
        rgb[offset] = 80;
        rgb[offset + 1] = 90;
        rgb[offset + 2] = 100;
      }
    }
    expect(findOpaqueChromaBounds(rgb, width, height)).toEqual({ x: 4, y: 5, width: 3, height: 4 });
    const transform = buildPoseFocusTransform(rgb, width, height, {
      marginPixels: 1,
      outputWidth: 12,
      outputHeight: 16,
    });
    expect(transform.crop).toEqual({ x: 3, y: 3, width: 6, height: 8 });
    expect(transform.focusedCanvas).toEqual({ width: 12, height: 16 });
    expect(transform.restore).toEqual({
      canvas: { width: 12, height: 16 },
      paste: { x: 3, y: 3, width: 6, height: 8 },
      background: '#00FF00',
      mode: 'scale-full-reviewed-output-into-paste-rect',
    });
    expect(HUMANOID_TEMPLATE_POSE_FOCUS).toEqual({ marginPixels: 24, outputWidth: 768, outputHeight: 1024 });
    expect(HUMANOID_TEMPLATE_IDENTITY_CROP).toMatchObject({ x: 64, y: 0, width: 640, height: 400 });
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
    mkdirSync(resolve('.humanoid-template-v5-selective-work'), { recursive: true });
    const directory = mkdtempSync(resolve('.humanoid-template-v5-selective-work/audit-test-'));
    try {
    const active = { pixcliJobId: 'job-1', submittedAt: '2026-08-30T21:18:56.000Z' };
    const job = { status: 'completed', cost: 100_000 };
    const pose = poseForTest('high_kick', 12);
    const payload = buildHumanoidTemplatePayload({
      poseAssetHash: 'a'.repeat(32),
      identityAssetHash: 'b'.repeat(32),
      pose,
    });
    const apiBase = 'https://pixcli.example';
    const signedAssetUrl = (hash, suffix) => `${apiBase}/api/v1/assets/${hash}?expires=1788211135&signature=${suffix.repeat(43)}`;
    const canvaInput = {
      ...payload,
      image_url: signedAssetUrl('a'.repeat(32), 'A'),
      image_urls: [signedAssetUrl('a'.repeat(32), 'A'), signedAssetUrl('b'.repeat(32), 'B')],
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
        canvaInput: {
          ...canvaInput,
          image_url: `${apiBase}/api/v1/assets/${'a'.repeat(32)}`,
          image_urls: payload.image.map((hash) => `${apiBase}/api/v1/assets/${hash}`),
        },
      },
      active,
      job,
      invariants,
      payload,
      apiBase,
    })).toEqual(expect.arrayContaining(['normalized prompt or reference URLs mismatch']));
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
      slotKey: 'pose-007-8a6769c69246:grok-imagine-image-2-edit',
      slug: 'pose-007-8a6769c69246',
      fighterName: 'Humanoid Neutral Medium',
      modelId: HUMANOID_TEMPLATE_MODEL.id,
      providerEndpoint: HUMANOID_TEMPLATE_MODEL.endpoint,
      sourceSha256: 'c'.repeat(64),
      poseReferenceSha256: '1'.repeat(64),
      poseTransformSha256: '2'.repeat(64),
      promptSha256: 'd'.repeat(64),
      poseAssetHash: 'a'.repeat(32),
      identityAssetHash: 'b'.repeat(32),
      requestSha256: 'e'.repeat(64),
    };
    expect(() => verifyStoredSlotContract({ ...expected }, expected)).not.toThrow();
    expect(() => verifyStoredSlotContract({ ...expected, requestSha256: 'f'.repeat(64) }, expected))
      .toThrow(/requestSha256/);
  });

  it('requires the isolated canary mode and rejects every full-mode invocation', () => {
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
    expect(HUMANOID_TEMPLATE_EXPERIMENT_ID).toBe('humanoid-neutral-medium-xai-selective-v5');
    expect(HUMANOID_TEMPLATE_CANARY_CONFIRMATION).toBe('GENERATE_HUMANOID_POSE_TEMPLATE_XAI_SELECTIVE_CANARY_V5');
    const prepared = parseHumanoidTemplateCliArgs(['--prepare']);
    expect(prepared.inputDirectory).toContain('/.humanoid-template-v5-selective-work/inputs');
    expect(prepared.outputDirectory).toContain('/.humanoid-template-v5-selective-work/outputs');
    expect(prepared.statePath).toContain('/.humanoid-template-v5-selective-work/state.json');
    expect(() => parseHumanoidTemplateCliArgs([
      '--execute',
      '--mode=full',
      '--confirm=GENERATE_HUMANOID_POSE_TEMPLATE_XAI_FULL_V5',
    ])).toThrow(/canary/i);
  });

  it('keeps V4 immutable and adds an encrypted, commit-bound, canary-only V5 workflow', () => {
    const workflow = readFileSync(resolve('.github/workflows/humanoid-pose-template-xai-v5-selective-canary.yml'), 'utf8');
    const v4 = readFileSync(resolve('.github/workflows/humanoid-pose-template-xai-production.yml'), 'utf8');
    const original = readFileSync(resolve('.github/workflows/arcade-qa-motion-xai-canary-production.yml'), 'utf8');
    expect(original).toContain('Run production Milei XAI HIGH_PUNCH QA canary');
    expect(v4).toContain('GENERATE_HUMANOID_POSE_TEMPLATE_XAI_FULL_V4');
    expect(v4).toContain('HUMANOID_WORK_DIR: .humanoid-template-v4-work');
    expect(workflow).toContain('HUMANOID_ARTIFACT_KEY');
    expect(workflow).toContain('GITHUB_RUN_ATTEMPT');
    expect(workflow).toContain('gh api --paginate');
    expect(workflow).toContain('This exact paid authorization was already consumed');
    expect(workflow).toContain('scripts/encrypted-humanoid-bundle.mjs');
    expect(workflow).toContain('humanoid-neutral-medium-xai-selective-v5-encrypted');
    expect(workflow).toContain('HUMANOID_WORK_DIR: .humanoid-template-v5-selective-work');
    expect(workflow).toContain('humanoid-selective-v5-checkpoint.tar.gz.ipenc');
    expect(workflow).toContain('GENERATE_HUMANOID_POSE_TEMPLATE_XAI_SELECTIVE_CANARY_V5');
    expect(workflow).toContain("&& 'canary' || 'invalid'");
    expect(readFileSync(resolve('package.json'), 'utf8')).toContain('scripts/humanoid-pose-template-xai-selective-v5.mjs');
    expect(workflow).not.toContain('resume_run_id');
    expect(workflow).not.toContain('FULL_V5');
    expect(workflow).not.toContain('--mode=full');
    expect(workflow).not.toContain('seed-arcade-roster');
    expect(workflow).not.toContain('wrangler');
    expect(readFileSync(resolve('scripts/encrypted-humanoid-bundle.mjs'), 'utf8')).toContain("createCipheriv('aes-256-gcm'");
    expect(workflow).not.toContain('path: .humanoid-template-v5-selective-work/');
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
