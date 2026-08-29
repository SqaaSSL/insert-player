import { describe, expect, it } from 'vitest';
import {
  VIDEO_SPRITE_ACTIONS,
  type VideoSpriteAutomaticSelectionPolicy,
  type VideoSpriteCompileResponse,
} from '../../src/services/VideoSpriteCompileContract';
import {
  SELF_SERVICE_VIDEO_POLICY,
  STUDIO_CURATED_VIDEO_POLICY,
  videoGenerationPolicyContract,
} from '../../src/services/VideoGenerationPolicy';
import { hashString } from './auth';
import {
  PIXCLI_VIDEO_MODEL,
  PIXCLI_VIDEO_PROVIDER_ENDPOINT,
  buildPixcliVideoPayload,
  buildVideoSpritePrompt,
  canonicalJson,
  projectCompilerReport,
  validatePixcliProviderRequestAudit,
  validatePixcliProviderResponseAudit,
  validatePixcliVideoAudit,
} from './videoSpriteGeneration';

const PIXCLI_ORIGIN = 'https://pixcli.example';
const PROMPT = 'Pinned screen-right high kick prompt with an approved identity anchor.';
const STUDIO_PROMPT_SHA256 = {
  idle: '23fe26b48f606ab2bfd041df36770614f131343855657847f00376860243d0d0',
  walk: '7d484f588962efe7f0f897c725fb70c6a5c5c0bc2a8ac4eb46edea7d067a0443',
  high_punch: '005777f720531162e3b9a6aa35216e46dd22563166f5848d74964e542d78376b',
  high_kick: 'cb2b36ecc865d8d88bc02626f3b387dd8f10b8340e4769c66ab65c490d624eb8',
  low_punch: 'b79f1d3c5aab70391fe6c9da32c64b591b26050bceae133294cb9cdd514dd4c6',
  low_kick: '239c8430cfb6930b83f178016b880f9d831ac3a3e93e3b67ce0424c96f735c51',
  jump: 'e637dfe2338757e10b7605c358e5c1cd1214962ebd41fc74d7b37a40aad3f9fc',
  crouch: '0686b15fb84e48b0b181ed5ae61f3630f92ba608c0245ca03feaf43fc8737316',
  hit: '76d4048b05a830b92a970900cbaf976d014eb9823217c518e6689d83b2036699',
  ko: '3c69f80a848f177d9da647a56afc6293d7d01eae5cd010a24800407e2c4cbee3',
  victory: 'b01dd6004363d0b003f554e7cc9496e242da50127343ef12e456942ade76e717',
} as const;

function liveCanvaFixture() {
  const canonicalHash = 'a'.repeat(32);
  const payload = buildPixcliVideoPayload('high_kick', canonicalHash, PROMPT);
  const providerRequestId = '01a03b3c-5e4a-7eb2-8881-3ff0aafebe36';
  const asset = (
    hash: string,
    mimeType: 'application/json' | 'video/mp4',
    sizeBytes: number,
    metadata: Record<string, unknown>,
  ) => ({
    hash,
    url: `${PIXCLI_ORIGIN}/api/v1/assets/${hash}`,
    mime_type: mimeType,
    width: null,
    height: null,
    size_bytes: sizeBytes,
    metadata,
    created_at: '2026-08-27T00:00:00.000Z',
  });
  return {
    payload,
    providerRequestId,
    document: {
      job: {
        job_id: 'b'.repeat(32),
        status: 'completed',
        type: 'video',
        mode: 'advanced',
        total_steps: 1,
        current_step: 0,
        cost: 330000,
      },
      input: {
        ...payload,
        image_url: `${PIXCLI_ORIGIN}/api/v1/assets/${canonicalHash}`,
        image_urls: [`${PIXCLI_ORIGIN}/api/v1/assets/${canonicalHash}`],
        enriched_prompt: PROMPT,
      },
      classification: {},
      pipeline: {},
      provider_runs: [{
        provider: 'fal',
        modelId: PIXCLI_VIDEO_MODEL,
        requestId: providerRequestId,
      }],
      assets: [
        asset('c'.repeat(32), 'application/json', 512, {
          artifact_kind: 'provider_request',
          model: PIXCLI_VIDEO_MODEL,
          content_sha256: '1'.repeat(64),
        }),
        asset('d'.repeat(32), 'application/json', 640, {
          artifact_kind: 'provider_response',
          model: PIXCLI_VIDEO_MODEL,
          provider_request_id: providerRequestId,
          content_sha256: '2'.repeat(64),
        }),
        asset('e'.repeat(32), 'video/mp4', 621_474, {
          model: PIXCLI_VIDEO_MODEL,
          prompt: PROMPT,
          provider_request_id: providerRequestId,
          source_url: 'https://v3b.fal.media/files/example/video.mp4',
        }),
      ],
      traces: [],
    },
  };
}

function fakePng(width: number, height: number, marker: number, byteLength = 25): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = marker;
  return bytes;
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function compilerFixture(
  operatorAdjustmentApplied = false,
  rawByteLength = 25,
  automaticSelectionPolicy: VideoSpriteAutomaticSelectionPolicy = 'cumulative-motion-quantiles-v2',
) {
  const selected = operatorAdjustmentApplied
    ? [1, 2, 3, 4, 5, 6, 7, 9]
    : [0, 1, 2, 3, 4, 5, 6, 7];
  const playback = [0, 1, 2, 3, 4, 5, 6, 7];
  const translations = selected.map(() => ({ dx: 0, dy: 0 }));
  const runtime = fakePng(1536, 256, 1);
  const raw = fakePng(3072, 2048, 2, rawByteLength);
  const contact = fakePng(768, 256, 3);
  const unique = fakePng(1536, 256, 4);
  const hashes = {
    runtime: await hashString(exactBuffer(runtime)),
    raw: await hashString(exactBuffer(raw)),
    contact: await hashString(exactBuffer(contact)),
    unique: await hashString(exactBuffer(unique)),
  };
  const lineage = {
    jobId: 'j'.repeat(32),
    runId: 'r'.repeat(32),
    fighterId: 'f'.repeat(32),
    provider: 'fal',
    modelId: PIXCLI_VIDEO_MODEL,
    providerRequestId: 'provider-request-idle',
    promptSha256: '1'.repeat(64),
    videoSha256: '2'.repeat(64),
    canonicalSha256: '3'.repeat(64),
  };
  const reportWithoutHash = {
    schema: 'video-sprite-compile-report.v1',
    schemaVersion: 1,
    compilerVersion: '1.0.0',
    policyVersion: 'video-sprite-policy.v1',
    action: 'idle',
    expectedFacing: 'right',
    animationFormat: 'video-dense-v1',
    processingVersion: 6,
    lineage,
    inputs: {
      videoSha256: lineage.videoSha256,
      canonicalSha256: lineage.canonicalSha256,
      videoSizeBytes: 621_474,
      canonicalSizeBytes: 4_096,
    },
    extraction: {
      decodedFrameCount: 10,
      selectedVideoIndices: selected,
      frameTranslations: translations,
      canonicalDerivedF0: false,
      operatorAdjustmentApplied,
      selectionAlgorithm: operatorAdjustmentApplied
        ? 'operator-selected-indices-v1'
        : automaticSelectionPolicy,
    },
    contract: {
      sequenceFormat: 'loop',
      frameSourceContract: 'video-raw-only',
      uniqueFrameCount: 8,
      playbackFrameCount: 8,
      frameWidth: 192,
      frameHeight: 256,
      allowStatic: true,
      playback,
    },
    decision: {
      outcome: 'technical_pass',
      reasonCodes: [],
      semanticPromotionApproved: false,
    },
    artifacts: {
      runtimeSheet: {
        sha256: hashes.runtime, sizeBytes: runtime.byteLength, width: 1536, height: 256,
      },
      rawUniqueFramesSheet: {
        sha256: hashes.raw, sizeBytes: raw.byteLength, width: 3072, height: 2048,
      },
      allFramesContactSheet: {
        sha256: hashes.contact, sizeBytes: contact.byteLength, width: 768, height: 256,
        columns: 8, rows: 2, cellWidth: 96, cellHeight: 128,
      },
      uniqueFramesSheet: {
        sha256: hashes.unique, sizeBytes: unique.byteLength, width: 1536, height: 256,
      },
    },
  };
  const report = {
    ...reportWithoutHash,
    reportSha256: await hashString(canonicalJson(reportWithoutHash)),
  };
  const response = {
    schemaVersion: 1,
    animationFormat: 'video-dense-v1',
    processingVersion: 6,
    frameW: 192,
    frameH: 256,
    frameCount: 8,
    spriteBase64: Buffer.from(runtime).toString('base64'),
    rawBase64: Buffer.from(raw).toString('base64'),
    rawFrameW: 768,
    rawFrameH: 1024,
    rawFrameCount: 8,
    allFramesContactSheetBase64: Buffer.from(contact).toString('base64'),
    uniqueFramesSheetBase64: Buffer.from(unique).toString('base64'),
    report,
  } as unknown as VideoSpriteCompileResponse;
  return { response, lineage, selected };
}

describe('video sprite generation contracts', () => {
  it('freezes Studio Curated while giving self-service every action a timed anatomy-safe prompt', async () => {
    const studioIdle = buildVideoSpritePrompt(
      'idle',
      '  Approved   identity brief  ',
      STUDIO_CURATED_VIDEO_POLICY,
    );
    expect(studioIdle).toContain('A completely motionless result is valid and preferred');
    expect(studioIdle).not.toContain('hard choreography contract');
    expect(studioIdle).toContain('Preserve this approved character brief: Approved identity brief');
    for (const action of VIDEO_SPRITE_ACTIONS) {
      expect(await hashString(buildVideoSpritePrompt(
        action,
        undefined,
        STUDIO_CURATED_VIDEO_POLICY,
      ))).toBe(STUDIO_PROMPT_SHA256[action]);
    }

    const prompts = VIDEO_SPRITE_ACTIONS.map((action) => (
      buildVideoSpritePrompt(action, 'Approved identity brief', SELF_SERVICE_VIDEO_POLICY)
    ));
    expect(new Set(prompts).size).toBe(VIDEO_SPRITE_ACTIONS.length);
    for (const prompt of prompts) {
      expect(prompt.length).toBeLessThanOrEqual(8_000);
      expect(prompt).toContain('hard choreography contract');
      expect(prompt).toContain('exactly two attached arms and hands');
      expect(prompt).toContain('Do not improvise any action');
      expect(prompt).not.toContain('completely motionless result');
    }
    expect(prompts[VIDEO_SPRITE_ACTIONS.indexOf('idle')]).toContain('subtle breathing loop only');
    expect(prompts[VIDEO_SPRITE_ACTIONS.indexOf('high_kick')]).toContain('one unmistakable support leg');
    expect(prompts[VIDEO_SPRITE_ACTIONS.indexOf('ko')]).toContain('1.45-2.00s: hold a fully lying');
    expect(videoGenerationPolicyContract(SELF_SERVICE_VIDEO_POLICY)).toMatchObject({
      promptVersion: 'self-service-video-prompt.v2',
      automaticSelectionPolicy: 'action-profile-temporal-anchors-v1',
      humanReviewRequired: true,
    });
  });

  it('accepts the live Canva shape while deriving the MP4 hash only from downloaded bytes', async () => {
    const fixture = liveCanvaFixture();
    const audit = await validatePixcliVideoAudit(fixture.document, {
      jobId: 'b'.repeat(32),
      payload: fixture.payload,
      pixcliOrigin: PIXCLI_ORIGIN,
    });
    expect(audit.providerRequestId).toBe(fixture.providerRequestId);
    expect(audit.assets.providerRequest.contentSha256).toBe('1'.repeat(64));
    expect(audit.assets.providerResponse.contentSha256).toBe('2'.repeat(64));
    expect(audit.assets.video).toMatchObject({
      hash: 'e'.repeat(32),
      contentSha256: null,
      sizeBytes: 621_474,
      mimeType: 'video/mp4',
    });

    await expect(validatePixcliVideoAudit({
      ...fixture.document,
      job: { ...fixture.document.job, status: 'completed_with_fallback' },
    }, {
      jobId: 'b'.repeat(32), payload: fixture.payload, pixcliOrigin: PIXCLI_ORIGIN,
    })).rejects.toThrow(/completed requested job/);
    await expect(validatePixcliVideoAudit({
      ...fixture.document,
      assets: [...fixture.document.assets, {
        ...fixture.document.assets[2], hash: 'f'.repeat(32),
        url: `${PIXCLI_ORIGIN}/api/v1/assets/${'f'.repeat(32)}`,
      }],
    }, {
      jobId: 'b'.repeat(32), payload: fixture.payload, pixcliOrigin: PIXCLI_ORIGIN,
    })).rejects.toThrow(/exactly one pinned MP4/);
  });

  it('validates exact live provider request and response JSON without following the FAL URL', () => {
    const fixture = liveCanvaFixture();
    validatePixcliProviderRequestAudit({
      model: PIXCLI_VIDEO_PROVIDER_ENDPOINT,
      input: {
        duration: 2,
        resolution: '720p',
        prompt: PROMPT,
        image_url: `${PIXCLI_ORIGIN}/api/v1/assets/${'a'.repeat(32)}`,
      },
      retry_policy: 'none',
      fallback_policy: 'none',
    }, { payload: fixture.payload, pixcliOrigin: PIXCLI_ORIGIN });
    validatePixcliProviderResponseAudit({
      video: {
        url: 'https://v3b.fal.media/files/example/video.mp4',
        content_type: 'video/mp4',
        file_name: 'video-result.mp4',
        file_size: 621_474,
        width: 1280,
        height: 720,
        fps: 24,
        duration: 2.04,
        num_frames: 49,
      },
    }, { sizeBytes: 621_474 });
    expect(() => validatePixcliProviderRequestAudit({
      model: PIXCLI_VIDEO_PROVIDER_ENDPOINT,
      input: {
        duration: 2, resolution: '720p', prompt: PROMPT,
        image_url: `${PIXCLI_ORIGIN}/api/v1/assets/${'a'.repeat(32)}`,
      },
      retry_policy: 'none', fallback_policy: 'none', extra: true,
    }, { payload: fixture.payload, pixcliOrigin: PIXCLI_ORIGIN })).toThrow(/no-fallback/);
  });

  it('binds the compiler projection to exact lineage, playback, and operator-selected indices', async () => {
    const automatic = await compilerFixture(false);
    const projection = await projectCompilerReport(automatic.response, 'idle', {
      facing: 'right',
      lineage: automatic.lineage,
      videoSizeBytes: 621_474,
      canonicalSizeBytes: 4_096,
      operatorAdjustmentApplied: false,
    });
    expect(projection).toMatchObject({
      outcome: 'technical_pass', sourceFrameCount: 10, selectedIndices: automatic.selected,
    });

    await expect(projectCompilerReport(automatic.response, 'idle', {
      facing: 'right',
      lineage: { ...automatic.lineage, videoSha256: '9'.repeat(64) },
      videoSizeBytes: 621_474,
      canonicalSizeBytes: 4_096,
      operatorAdjustmentApplied: false,
    })).rejects.toThrow(/hashes, sizes, or PNG dimensions/);

    const adjusted = await compilerFixture(true);
    await expect(projectCompilerReport(adjusted.response, 'idle', {
      facing: 'right', lineage: adjusted.lineage,
      videoSizeBytes: 621_474, canonicalSizeBytes: 4_096,
      selectedVideoIndices: adjusted.selected.slice(0, -1),
      operatorAdjustmentApplied: true,
    })).rejects.toThrow(/action or artifact counts/);
    await expect(projectCompilerReport(adjusted.response, 'idle', {
      facing: 'right', lineage: adjusted.lineage,
      videoSizeBytes: 621_474, canonicalSizeBytes: 4_096,
      selectedVideoIndices: adjusted.selected,
      operatorAdjustmentApplied: true,
    })).resolves.toMatchObject({ selectedIndices: adjusted.selected });
  });

  it('binds an automatic self-service compile to the temporal selector', async () => {
    const guided = await compilerFixture(false, 25, 'action-profile-temporal-anchors-v1');
    await expect(projectCompilerReport(guided.response, 'idle', {
      facing: 'right',
      lineage: guided.lineage,
      videoSizeBytes: 621_474,
      canonicalSizeBytes: 4_096,
      automaticSelectionPolicy: 'action-profile-temporal-anchors-v1',
      operatorAdjustmentApplied: false,
    })).resolves.toMatchObject({ selectedIndices: guided.selected });

    await expect(projectCompilerReport(guided.response, 'idle', {
      facing: 'right',
      lineage: guided.lineage,
      videoSizeBytes: 621_474,
      canonicalSizeBytes: 4_096,
      automaticSelectionPolicy: 'cumulative-motion-quantiles-v2',
      operatorAdjustmentApplied: false,
    })).rejects.toThrow(/action or artifact counts/);
  });

  it('decodes a compiler PNG whose base64 crosses the Workerd RegExp stack limit', async () => {
    const large = await compilerFixture(false, 4_200_000);
    await expect(projectCompilerReport(large.response, 'idle', {
      facing: 'right',
      lineage: large.lineage,
      videoSizeBytes: 621_474,
      canonicalSizeBytes: 4_096,
      operatorAdjustmentApplied: false,
    })).resolves.toMatchObject({ selectedIndices: large.selected });

    const malformed = await compilerFixture(false);
    malformed.response.spriteBase64 = `${malformed.response.spriteBase64.slice(0, -4)}A=AA`;
    await expect(projectCompilerReport(malformed.response, 'idle', {
      facing: 'right',
      lineage: malformed.lineage,
      videoSizeBytes: 621_474,
      canonicalSizeBytes: 4_096,
      operatorAdjustmentApplied: false,
    })).rejects.toThrow(/not canonical base64/);
  });
});
