import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pollJob,
  submitBakeoffSlot,
  uploadBakeoffSource,
  verifyBakeoffSource,
} from './arcade-side-bakeoff.mjs';
import { validateManifest } from './seed-arcade-roster.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MANIFEST_PATH = join(root, 'arcade/roster-2026.json');
const DEFAULT_SOURCE_DIR = join(root, '.arcade-sources');
const DEFAULT_OUTPUT_ROOT = join(root, '.artifacts/arcade-xai-canonical-bundles');
const DEFAULT_STATE_ROOT = join(root, '.arcade-xai-canonical-bundle-states');
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_PNG_BYTES = 12 * 1024 * 1024;
const MAX_AUDIT_JSON_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const XAI_CANONICAL_BUNDLE_BASE_COMMIT = 'fca24ac39763b879eb6072c0cfb39ea098e5705d';
export const XAI_CANONICAL_BUNDLE_CONFIRMATION = 'GENERATE_XAI_CANONICAL_BUNDLE_PRIVATE_V1';
export const XAI_CANONICAL_SINGLE_SOURCE_CONFIRMATION = 'GENERATE_XAI_CANONICAL_SOURCE_PRIVATE_V1';
export const XAI_CANONICAL_BUNDLE_PRIVATE_CONFIRMATION = 'PRIVATE_ARTIFACTS_ONLY_HUMAN_REVIEW';
export const XAI_CANONICAL_BUNDLE_RECLEAN_CONFIRMATION = 'RECLEAN_XAI_CANONICAL_BUNDLE_OFFLINE_V1';
export const XAI_CANONICAL_SINGLE_SOURCE_PROMPT_PROFILE = 'elon_crouch_identity_hard_gate_v1';
export const XAI_CANONICAL_GLOBAL_SIDE_PROMPT_PROFILE = 'global_side_identity_hard_gate_v1';
export const XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE =
  'global_crouch_from_reviewed_side_identity_hard_gate_v1';
export const XAI_CANONICAL_LAMINE_CROUCH_RETRY_REQUEST_VERSION =
  'lamine-crouch-headwear-reject-v2';
export const XAI_CANONICAL_LAMINE_CROUCH_RETRY_PROMPT_PROFILE =
  'lamine_crouch_no_headwear_identity_hard_gate_v2';
export const XAI_CANONICAL_LAMINE_CROUCH_RETRY_CONFIRMATION =
  'GENERATE_LAMINE_CROUCH_HEADWEAR_REJECT_RETRY_PRIVATE_V2';
// Mirrors PixCLI EditAdvancedRequestSchema.promptSchema (`z.string().max(4000)`).
// We additionally seal UTF-8 bytes to the same ceiling so every accepted local
// payload is guaranteed to fit the remote character contract.
export const XAI_CANONICAL_PIXCLI_PROMPT_MAX = 4_000;
export const XAI_CANONICAL_GLOBAL_SIDE_SLUGS = Object.freeze([
  'rosalia',
  'ibai-llanos',
  'lamine-yamal',
]);
export const XAI_CANONICAL_GLOBAL_SIDE_REFERENCES = Object.freeze({
  pose: Object.freeze({
    id: 'trump-upright-reviewed-v1',
    contentSha256: '7d66134eb21a42ca54c2d2205c952204886cb59f69cb35349416359c36ccd2a7',
  }),
  rendering: Object.freeze({
    id: 'milei-side-reviewed-v1',
    contentSha256: '41dcb1e372fdfd36b7f53ba461198fdf26e645b637e3b4417a0833414a702559',
  }),
});
export const XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE = Object.freeze({
  id: 'trump-crouch-reviewed-v1',
  contentSha256: 'eec0779f6120b9f89fb5fc87d7c3e65e8bd285eb220d52f37466ccdc78069749',
});
export const XAI_CANONICAL_SINGLE_SOURCE_PROMPT_SHA256 =
  'c7be4746256d2e39b39dd61ba50d4abb887742ff69ce148a36f00672e4283acb';
export const XAI_CANONICAL_GLOBAL_SIDE_PROMPT_SHA256_BY_SLUG = Object.freeze({
  rosalia: 'eb0142fe810eda52e711a5e8acc58f06fa0370721be0e06cf7e45dcb612fdb78',
  'ibai-llanos': '47aeadbceef3c883a26c7de9f6d925de153239d8f7d28d0ae5ce96dad17c449b',
  'lamine-yamal': '27b1a65908a402f491e24b55ba1bccce97a07bc6a915356a16e65ff8c5a3be39',
});
// Updated only through the reviewed prompt snapshot tests below. These values
// intentionally differ by fighter because IMAGE 3 identity and roster wardrobe
// remain explicit hard gates.
export const XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_SHA256_BY_SLUG = Object.freeze({
  rosalia: 'e8b11ecca2a2a1fbb958c427804631ec7eed5f901ae00bd6117a5b7f87c1cb82',
  'ibai-llanos': '76e68a0c698326333e070bf5c3901570f994a24584fe3b65bad25b13a985becc',
  'lamine-yamal': '800a2b5a1c1a90749490497f5b06a92707b3a35ed4784627b22b186a952224cf',
});
export const XAI_CANONICAL_LAMINE_CROUCH_RETRY_PROMPT_SHA256 =
  'b626d61e7dd60f46b894ee1bdd26a270acd38f23e3fcfb82305692e45caaa3c0';
export const XAI_CANONICAL_LAMINE_CROUCH_RETRY_INPUT = Object.freeze({
  bundleR2Key: 'temp/arcade-xai-canonical-inputs-v1/lamine-yamal/lamine-yamal-crouch--6f17ae7ad19f6695.tar.gz',
  bundleSha256: '6f17ae7ad19f6695a673b54938b1f5709e1ead790a26f20a5566083c2f0da418',
  poseManifestSha256: 'cc7ae95fbab0e2b6843b19380b611f11cc84a6dc48025fdf678b8f6c912df053',
});
export const XAI_CANONICAL_BUNDLE_SOURCE_NAMES = Object.freeze(['side', 'upright', 'crouch']);
export const XAI_CANONICAL_BUNDLE_MODEL = Object.freeze({
  id: 'grok-imagine-image-2-edit',
  endpoint: 'xai/grok-imagine-image/v2.0/edit',
  provider: 'xai',
  backend: 'fal',
  catalogCostPerImage: 110000,
  auditedCostMicrocredits: 110000,
  auditedCostUsd: 0.11,
  maxCostPerOutputUsd: 0.12,
  singleSourceMaxCostUsd: 0.11,
  maxBundleCostUsd: 0.36,
  params: Object.freeze({
    num_images: 1,
    aspect_ratio: 'auto',
    resolution: '2k',
    output_format: 'png',
    quality: 'medium',
  }),
});
export const XAI_CANONICAL_BUNDLE_CLEANUP = Object.freeze({
  ffmpegVersion: '5.1.9-0+deb12u1',
  // Keep opaque source pixels byte-stable except for green-dominant pixels in
  // the 24-source-pixel foreground band connected to the exterior matte
  // (under three pixels after the 1776px -> 192px runtime scale). Partially
  // keyed antialiasing is decontaminated by reversing its composite against
  // the requested #00ff00 screen; transparent RGB is zeroed after selection.
  filter: [
    '[0:v]split=4[in_base][in_corrected][in_green][in_matte]',
    '[in_base]format=rgb24,split[base_rgb][black_source]',
    '[black_source]lutrgb=r=0:g=0:b=0[black]',
    "[in_corrected]chromakey=0x00FF00:0.20:0.08,format=rgba,geq=r='if(between(alpha(X,Y),1,254),clip(r(X,Y)*255/alpha(X,Y),0,255),r(X,Y))':g='if(between(alpha(X,Y),1,254),clip((g(X,Y)-(255-alpha(X,Y)))*255/alpha(X,Y),0,255),g(X,Y))':b='if(between(alpha(X,Y),1,254),clip(b(X,Y)*255/alpha(X,Y),0,255),b(X,Y))':a='alpha(X,Y)',format=rgb24,split[corrected_rgb][despill_source]",
    '[despill_source]despill=green:mix=1:expand=0.15,format=rgb24[despilled_rgb]',
    "[in_green]format=rgb24,geq=r='if(gt(g(X,Y)-max(r(X,Y),b(X,Y)),4)*lt(b(X,Y)-r(X,Y),12),255,0)':g='if(gt(g(X,Y)-max(r(X,Y),b(X,Y)),4)*lt(b(X,Y)-r(X,Y),12),255,0)':b='if(gt(g(X,Y)-max(r(X,Y),b(X,Y)),4)*lt(b(X,Y)-r(X,Y),12),255,0)',format=gray,split[green_for_partial][green_for_opaque]",
    '[in_matte]chromakey=0x00FF00:0.20:0.08,format=rgba,alphaextract,split=4[alpha_for_partial][alpha_for_visible][alpha_for_opaque][alpha]',
    "[alpha_for_partial]lut=y='if(between(val,1,254),255,0)',split[partial_for_select][partial_for_green]",
    '[partial_for_select]format=rgb24[partial]',
    '[partial_for_green][green_for_partial]blend=all_mode=multiply[partial_green]',
    "[alpha_for_opaque]lut=y='if(eq(val,255),255,0)',split[opaque][opaque_for_erode]",
    '[opaque_for_erode]erosion,erosion,erosion,erosion,erosion,erosion,erosion,erosion,erosion,erosion,erosion,erosion,erosion,erosion,erosion,erosion,erosion,erosion,erosion,erosion,erosion,erosion,erosion,erosion[opaque_eroded]',
    "[opaque][opaque_eroded]blend=all_mode=subtract,lut=y='if(gt(val,0),255,0)'[opaque_edge]",
    "[opaque_edge][green_for_opaque]blend=all_mode=multiply,lut=y='if(gt(val,0),255,0)'[opaque_green_edge]",
    "[partial_green][opaque_green_edge]blend=all_mode=lighten,lut=y='if(gt(val,0),255,0)',format=rgb24[green_cleanup]",
    '[base_rgb][corrected_rgb][partial]maskedmerge=planes=7,format=rgb24[partial_selected]',
    '[partial_selected][despilled_rgb][green_cleanup]maskedmerge=planes=7,format=rgb24[selected]',
    "[alpha_for_visible]lut=y='if(gt(val,0),255,0)',format=rgb24[visible]",
    '[black][selected][visible]maskedmerge=planes=7,format=rgb24[rgb]',
    '[rgb][alpha]alphamerge,format=rgba[out]',
  ].join(';'),
});
export const XAI_CANONICAL_BUNDLE_LEGACY_CLEANUP = Object.freeze({
  ffmpegVersion: '5.1.9-0+deb12u1',
  filter: 'chromakey=0x00FF00:0.20:0.08,format=rgba',
});
export const XAI_CANONICAL_BUNDLE_CLEANUP_FIXTURE = Object.freeze({
  path: 'scripts/fixtures/xai-canonical-chroma-gradient.ppm',
  width: 12,
  height: 10,
  inputSha256: 'c2555e9077026e4caa807106e7558fb5f0bb3b192b2a2f134fdb78ed1854b9ba',
  cleanSha256: '5ae66f5be6828740e460b914e4d95e572be4b9760e8d4e2e400f1a75cfa339a9',
  pixels: Object.freeze([
    Object.freeze({ label: 'opaque teal exterior edge', x: 3, y: 3, rgba: Object.freeze([0, 96, 96, 255]) }),
    Object.freeze({ label: 'opaque teal core', x: 4, y: 4, rgba: Object.freeze([0, 110, 110, 255]) }),
    Object.freeze({ label: 'decontaminated opaque green fringe', x: 4, y: 3, rgba: Object.freeze([80, 80, 49, 255]) }),
    Object.freeze({ label: 'decontaminated partial edge', x: 5, y: 2, rgba: Object.freeze([150, 39, 91, 135]) }),
    Object.freeze({ label: 'zeroed transparent screen', x: 0, y: 0, rgba: Object.freeze([0, 0, 0, 0]) }),
  ]),
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function nowIso() {
  return new Date().toISOString();
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value ?? {}).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} keys are not sealed.`);
  }
}

function requireString(value, label, pattern) {
  if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} is invalid.`);
  return value;
}

export function assertXaiCanonicalPromptFitsPixcliSchema(prompt) {
  requireString(prompt, 'PixCLI EditAdvanced prompt');
  const characters = prompt.length;
  const utf8Bytes = Buffer.byteLength(prompt, 'utf8');
  if (
    characters > XAI_CANONICAL_PIXCLI_PROMPT_MAX
    || utf8Bytes > XAI_CANONICAL_PIXCLI_PROMPT_MAX
  ) {
    throw new Error(
      `PixCLI EditAdvanced prompt exceeds max ${XAI_CANONICAL_PIXCLI_PROMPT_MAX} `
      + `(${characters} characters, ${utf8Bytes} UTF-8 bytes).`,
    );
  }
  return prompt;
}

function selectedCanonicalSourceNames(sourceName) {
  if (sourceName === undefined || sourceName === null || sourceName === '') {
    return XAI_CANONICAL_BUNDLE_SOURCE_NAMES;
  }
  if (!XAI_CANONICAL_BUNDLE_SOURCE_NAMES.includes(sourceName)) {
    throw new Error(`Unsupported canonical source: ${String(sourceName)}.`);
  }
  return Object.freeze([sourceName]);
}

const GLOBAL_SIDE_IDENTITY_CONTRACTS = Object.freeze({
  rosalia: Object.freeze({
    name: 'Rosalía',
    safeguard: 'Rosalía: preserve IMAGE 3 young-adult female face/anatomy, light-olive skin, very long near-black center-parted hair, slim athletic female build. Never masculinize face, jaw, neck, shoulders, torso, limbs, or proportions; no facial hair or male body.',
  }),
  'ibai-llanos': Object.freeze({
    name: 'Ibai Llanos',
    safeguard: 'Ibai: preserve IMAGE 3 broad heavyset young-adult male build, round face, receding dark-brown hair, dense reddish-brown beard/moustache. Absolutely no mic, microphone, headset, headphones, earbuds, boom arm, cable, streaming accessory, handheld prop.',
  }),
  'lamine-yamal': Object.freeze({
    name: 'Lamine Yamal',
    safeguard: 'Lamine: preserve IMAGE 3 very-young-adult male, medium-brown skin, narrow oval face, dense high curls/honey-blond tips, lean elite-athlete build. Absolutely no athletic/kinesiology tape, bandage, club/sponsor mark, flag, number, lettering, text, logo, badge, ball, prop.',
  }),
});

const LAMINE_CROUCH_RETRY_SAFEGUARD =
  'Lamine: preserve IMAGE 3 very-young-adult male, medium-brown skin, narrow oval face, lean elite-athlete build. Hair exactly as IMAGE 2 SIDE RAW and IMAGE 3 original: uncovered dense high curls/honey-blond tips, same hairline/shape/color/volume. Absolutely no headband, headwear, hair accessory, or other accessory, athletic/kinesiology tape, bandage, wrap, club/sponsor mark, flag, number, lettering, text, logo, badge, ball, or prop.';

export function resolveXaiCanonicalSingleSourcePromptProfile(slug, sourceName) {
  if (slug === 'elon-musk' && sourceName === 'crouch') {
    return XAI_CANONICAL_SINGLE_SOURCE_PROMPT_PROFILE;
  }
  if (sourceName === 'side' && XAI_CANONICAL_GLOBAL_SIDE_SLUGS.includes(slug)) {
    return XAI_CANONICAL_GLOBAL_SIDE_PROMPT_PROFILE;
  }
  if (sourceName === 'crouch' && XAI_CANONICAL_GLOBAL_SIDE_SLUGS.includes(slug)) {
    return XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE;
  }
  throw new Error(`Single-source canonical generation is not sealed for ${String(slug)} ${String(sourceName).toUpperCase()}.`);
}

export function resolveXaiCanonicalSingleSourceRequest(slug, sourceName, requestVersion = '') {
  if (requestVersion === '') {
    return Object.freeze({
      requestVersion: '',
      promptProfile: resolveXaiCanonicalSingleSourcePromptProfile(slug, sourceName),
      confirmation: XAI_CANONICAL_SINGLE_SOURCE_CONFIRMATION,
      bundleId: `arcade-xai-canonical-source-${slug}-${sourceName}-v1`,
      stateStem: `${slug}-${sourceName}`,
      publishMarkerVersion: 'v1',
    });
  }
  if (
    requestVersion === XAI_CANONICAL_LAMINE_CROUCH_RETRY_REQUEST_VERSION
    && slug === 'lamine-yamal'
    && sourceName === 'crouch'
  ) {
    return Object.freeze({
      requestVersion,
      promptProfile: XAI_CANONICAL_LAMINE_CROUCH_RETRY_PROMPT_PROFILE,
      confirmation: XAI_CANONICAL_LAMINE_CROUCH_RETRY_CONFIRMATION,
      bundleId: 'arcade-xai-canonical-source-lamine-yamal-crouch-v2',
      stateStem: 'lamine-yamal-crouch-v2',
      publishMarkerVersion: 'v2',
    });
  }
  throw new Error(
    `Canonical retry request version ${String(requestVersion)} is not sealed for ${String(slug)} ${String(sourceName).toUpperCase()}.`,
  );
}

export function resolveXaiCanonicalSingleSourceRequestByBundleId(slug, sourceName, bundleId) {
  const legacy = resolveXaiCanonicalSingleSourceRequest(slug, sourceName);
  if (bundleId === legacy.bundleId) return legacy;
  if (slug === 'lamine-yamal' && sourceName === 'crouch') {
    const retry = resolveXaiCanonicalSingleSourceRequest(
      slug,
      sourceName,
      XAI_CANONICAL_LAMINE_CROUCH_RETRY_REQUEST_VERSION,
    );
    if (bundleId === retry.bundleId) return retry;
  }
  throw new Error(`Canonical bundle identity is not sealed for ${String(slug)} ${String(sourceName).toUpperCase()}.`);
}

export function validateXaiCanonicalPromptProfileReferences(poseBundle, promptProfile, fighter = null) {
  if (promptProfile === XAI_CANONICAL_GLOBAL_SIDE_PROMPT_PROFILE) {
    const side = poseBundle?.sources?.side;
    if (!side || Object.keys(poseBundle.sources).length !== 1) {
      throw new Error('The global SIDE profile requires an exact single-side pose manifest.');
    }
    for (const role of ['pose', 'rendering']) {
      const expected = XAI_CANONICAL_GLOBAL_SIDE_REFERENCES[role];
      const actual = side[role];
      if (actual?.id !== expected.id || actual?.contentSha256 !== expected.contentSha256) {
        throw new Error(`The global SIDE ${role} reference is not the sealed ${expected.id} asset.`);
      }
    }
  } else if (
    promptProfile === XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE
    || promptProfile === XAI_CANONICAL_LAMINE_CROUCH_RETRY_PROMPT_PROFILE
  ) {
    const crouch = poseBundle?.sources?.crouch;
    if (!crouch || Object.keys(poseBundle.sources).length !== 1) {
      throw new Error('The global CROUCH profile requires an exact single-crouch pose manifest.');
    }
    if (
      crouch.pose?.id !== XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE.id
      || crouch.pose?.contentSha256 !== XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE.contentSha256
    ) {
      throw new Error('The global CROUCH pose is not the sealed reviewed Trump crouch asset.');
    }
    const expectedRenderingId = fighter?.slug ? `reviewed-${fighter.slug}-side-raw-v1` : null;
    const approval = crouch.rendering?.approvalRecord;
    if (
      !expectedRenderingId
      || crouch.rendering?.id !== expectedRenderingId
      || !/^[a-f0-9]{64}$/.test(crouch.rendering?.contentSha256 ?? '')
      || crouch.rendering.contentSha256 === crouch.pose.contentSha256
    ) {
      throw new Error('The global CROUCH rendering reference is not one exact reviewed SIDE raw asset.');
    }
    if (
      approval?.schemaVersion !== 1
      || approval.evidenceType !== 'reviewed_global_side_for_crouch_v1'
      || approval.status !== 'approved'
      || approval.decision !== 'APPROVE_REVIEWED_GLOBAL_SIDE_FOR_CROUCH_V1'
      || approval.fighter?.slug !== fighter.slug
      || approval.fighter?.name !== fighter.name
      || approval.fighter?.photoHash !== fighter.reference?.sourceSha256
      || approval.side?.bundleId !== `arcade-xai-canonical-source-${fighter.slug}-side-v1`
      || approval.side?.rawSha256 !== crouch.rendering.contentSha256
      || !/^[1-9][0-9]*$/.test(approval.sideBundleRunId ?? '')
      || !/^[a-f0-9]{64}$/.test(approval.reviewedDescriptorSha256 ?? '')
      || !Array.isArray(approval.blockingFindings)
      || approval.blockingFindings.length !== 0
    ) throw new Error('The global CROUCH rendering reference lacks exact unblocked SIDE review lineage.');
  }
  return poseBundle;
}

export function reviewedXaiCanonicalSingleSourcePromptSha256(slug, sourceName, promptProfile) {
  if (promptProfile === XAI_CANONICAL_SINGLE_SOURCE_PROMPT_PROFILE) {
    if (slug !== 'elon-musk' || sourceName !== 'crouch') {
      throw new Error('The Elon CROUCH prompt snapshot tuple is invalid.');
    }
    return XAI_CANONICAL_SINGLE_SOURCE_PROMPT_SHA256;
  }
  if (promptProfile === XAI_CANONICAL_GLOBAL_SIDE_PROMPT_PROFILE && sourceName === 'side') {
    return requireString(
      XAI_CANONICAL_GLOBAL_SIDE_PROMPT_SHA256_BY_SLUG[slug],
      'reviewed global SIDE prompt SHA-256',
      /^[a-f0-9]{64}$/,
    );
  }
  if (promptProfile === XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE && sourceName === 'crouch') {
    return requireString(
      XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_SHA256_BY_SLUG[slug],
      'reviewed global CROUCH prompt SHA-256',
      /^[a-f0-9]{64}$/,
    );
  }
  if (
    promptProfile === XAI_CANONICAL_LAMINE_CROUCH_RETRY_PROMPT_PROFILE
    && slug === 'lamine-yamal'
    && sourceName === 'crouch'
  ) return XAI_CANONICAL_LAMINE_CROUCH_RETRY_PROMPT_SHA256;
  throw new Error(`No reviewed single-source prompt snapshot for ${String(slug)} ${String(sourceName)}.`);
}

function canonicalBundlePolicy(sourceNames) {
  const singleSource = sourceNames.length === 1;
  const expectedPaidCalls = sourceNames.length;
  const maximumBundleCostUsd = singleSource
    ? XAI_CANONICAL_BUNDLE_MODEL.singleSourceMaxCostUsd
    : XAI_CANONICAL_BUNDLE_MODEL.maxBundleCostUsd;
  return {
    expectedPaidCalls,
    maximumPaidCalls: expectedPaidCalls,
    automaticRetries: 0,
    fallback: 'none',
    promptEnrichment: false,
    catalogCostPerOutputUsd: XAI_CANONICAL_BUNDLE_MODEL.auditedCostUsd,
    maximumCostPerOutputUsd: singleSource
      ? XAI_CANONICAL_BUNDLE_MODEL.singleSourceMaxCostUsd
      : XAI_CANONICAL_BUNDLE_MODEL.maxCostPerOutputUsd,
    maximumBundleCostUsd,
    outputVisibility: 'private_local',
    import: false,
    activation: false,
    humanReviewRequired: true,
  };
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.writing-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function acquireExclusiveBundleLocks(statePath, outputDirectory) {
  const nonce = randomUUID();
  const lockPaths = [...new Set([`${statePath}.lock`, `${outputDirectory}.lock`])].sort();
  const owned = [];
  try {
    for (const lockPath of lockPaths) {
      mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
      let descriptor;
      try {
        descriptor = openSync(lockPath, 'wx', 0o600);
      } catch (error) {
        if (error?.code === 'EEXIST') {
          throw new Error(`Canonical bundle lock exists and requires manual reconciliation: ${lockPath}.`);
        }
        throw error;
      }
      owned.push({ lockPath, descriptor, nonce });
      const record = {
        schemaVersion: 1,
        nonce,
        pid: process.pid,
        statePath,
        outputDirectory,
        acquiredAt: nowIso(),
      };
      writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`);
      fsyncSync(descriptor);
    }
  } catch (error) {
    releaseExclusiveBundleLocks(owned);
    throw error;
  }
  return owned;
}

function releaseExclusiveBundleLocks(owned) {
  let releaseError = null;
  for (const lock of [...owned].reverse()) {
    try {
      closeSync(lock.descriptor);
      const current = JSON.parse(readFileSync(lock.lockPath, 'utf8'));
      if (current.nonce !== lock.nonce) {
        throw new Error(`Canonical bundle lock ownership changed: ${lock.lockPath}.`);
      }
      unlinkSync(lock.lockPath);
    } catch (error) {
      releaseError ??= error;
    }
  }
  if (releaseError) throw releaseError;
}

function writeBytesAtomic(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.writing-${process.pid}`;
  writeFileSync(temporary, bytes, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function resolvePrivateInput(baseDirectory, path, label) {
  requireString(path, `${label}.path`);
  if (path.startsWith('/') || path.includes('\\')) throw new Error(`${label}.path must be relative.`);
  const resolved = resolve(baseDirectory, path);
  const prefix = `${resolve(baseDirectory)}${sep}`;
  if (!resolved.startsWith(prefix)) throw new Error(`${label}.path escapes the private manifest directory.`);
  return resolved;
}

export function inspectPng(bytes, label = 'PNG') {
  if (
    !Buffer.isBuffer(bytes)
    || bytes.byteLength < 24
    || bytes.byteLength > MAX_PNG_BYTES
    || !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
  ) {
    throw new Error(`${label} is not a bounded PNG.`);
  }
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error(`${label} lacks a PNG IHDR.`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 64 || height < 64 || width > 4096 || height > 4096) {
    throw new Error(`${label} dimensions are outside the sealed bounds.`);
  }
  return { width, height, sizeBytes: bytes.byteLength, contentSha256: sha256(bytes) };
}

function readApprovedReference(reference, baseDirectory, label) {
  exactKeys(reference, [
    'id', 'path', 'contentSha256', 'sizeBytes', 'width', 'height', 'approvalEvidence',
  ], label);
  requireString(reference.id, `${label}.id`, /^[a-z0-9][a-z0-9-]{2,95}$/);
  requireString(reference.contentSha256, `${label}.contentSha256`, /^[a-f0-9]{64}$/);
  requireInteger(reference.sizeBytes, `${label}.sizeBytes`, 24);
  requireInteger(reference.width, `${label}.width`, 64);
  requireInteger(reference.height, `${label}.height`, 64);
  exactKeys(reference.approvalEvidence, [
    'path', 'contentSha256', 'selector', 'expectedValue',
  ], `${label}.approvalEvidence`);
  requireString(reference.approvalEvidence.contentSha256, `${label}.approvalEvidence.contentSha256`, /^[a-f0-9]{64}$/);
  requireString(reference.approvalEvidence.selector, `${label}.approvalEvidence.selector`, /^[A-Za-z0-9_.-]+$/);
  const affirmativeDecision = reference.approvalEvidence.expectedValue === true
    || reference.approvalEvidence.expectedValue === 'approved'
    || (
      typeof reference.approvalEvidence.expectedValue === 'string'
      && /^[a-f0-9]{64}$/.test(reference.approvalEvidence.expectedValue)
    );
  if (!affirmativeDecision) throw new Error(`${label} approval evidence is not an affirmative sealed decision.`);

  const path = resolvePrivateInput(baseDirectory, reference.path, label);
  const evidencePath = resolvePrivateInput(
    baseDirectory,
    reference.approvalEvidence.path,
    `${label}.approvalEvidence`,
  );
  if (!existsSync(path) || !existsSync(evidencePath)) throw new Error(`${label} private artifact or approval evidence is missing.`);
  const bytes = readFileSync(path);
  const inspected = inspectPng(bytes, label);
  for (const key of ['contentSha256', 'sizeBytes', 'width', 'height']) {
    if (inspected[key] !== reference[key]) throw new Error(`${label} ${key} does not match its sealed descriptor.`);
  }
  const evidenceBytes = readFileSync(evidencePath);
  if (sha256(evidenceBytes) !== reference.approvalEvidence.contentSha256) {
    throw new Error(`${label} approval evidence hash mismatch.`);
  }
  let evidence;
  try {
    evidence = JSON.parse(evidenceBytes.toString('utf8'));
  } catch {
    throw new Error(`${label} approval evidence is not JSON.`);
  }
  let selected = evidence;
  for (const key of reference.approvalEvidence.selector.split('.')) {
    if (!selected || typeof selected !== 'object' || !Object.hasOwn(selected, key)) {
      throw new Error(`${label} approval evidence selector does not exist.`);
    }
    selected = selected[key];
  }
  if (canonicalJson(selected) !== canonicalJson(reference.approvalEvidence.expectedValue)) {
    throw new Error(`${label} approval evidence selector did not match.`);
  }
  return { ...reference, absolutePath: path, bytes, approvalRecord: evidence };
}

export function loadXaiCanonicalPoseManifest(
  path,
  expectedSha256,
  expectedSourceNames = XAI_CANONICAL_BUNDLE_SOURCE_NAMES,
) {
  requireString(path, 'pose manifest path');
  requireString(expectedSha256, 'pose manifest SHA-256', /^[a-f0-9]{64}$/);
  const bytes = readFileSync(path);
  if (sha256(bytes) !== expectedSha256) throw new Error('Pose manifest SHA-256 mismatch.');
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Pose manifest is not JSON.');
  }
  exactKeys(manifest, [
    'schemaVersion', 'manifestId', 'status', 'referenceOrder', 'sources',
  ], 'pose manifest');
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported pose manifest schema.');
  requireString(manifest.manifestId, 'pose manifest id', /^arcade-xai-canonical-pose-bundle-[a-z0-9-]+-v[0-9]+$/);
  if (manifest.status !== 'human_reviewed') throw new Error('Pose manifest is not human reviewed.');
  if (canonicalJson(manifest.referenceOrder) !== canonicalJson([
    'pose_composition_master',
    'canonical_rendering_master',
    'identity_photo',
  ])) {
    throw new Error('Pose manifest reference order changed.');
  }
  if (
    !Array.isArray(expectedSourceNames)
    || ![1, XAI_CANONICAL_BUNDLE_SOURCE_NAMES.length].includes(expectedSourceNames.length)
    || expectedSourceNames.some((sourceName) => !XAI_CANONICAL_BUNDLE_SOURCE_NAMES.includes(sourceName))
  ) throw new Error('Expected pose manifest sources are invalid.');
  exactKeys(manifest.sources, expectedSourceNames, 'pose manifest sources');
  const baseDirectory = dirname(resolve(path));
  const sources = {};
  for (const sourceName of expectedSourceNames) {
    const source = manifest.sources[sourceName];
    exactKeys(source, ['pose', 'rendering'], `pose manifest ${sourceName}`);
    const pose = readApprovedReference(source.pose, baseDirectory, `${sourceName} pose`);
    const rendering = readApprovedReference(source.rendering, baseDirectory, `${sourceName} rendering`);
    if (pose.contentSha256 === rendering.contentSha256) {
      throw new Error(`${sourceName} pose and rendering masters must be distinct reviewed assets.`);
    }
    sources[sourceName] = { pose, rendering };
  }
  return { manifest, manifestSha256: expectedSha256, sources };
}

function sourcePoseInstruction(sourceName, options = {}) {
  if (sourceName === 'side') {
    if (options.promptProfile === XAI_CANONICAL_GLOBAL_SIDE_PROMPT_PROFILE) {
      return 'a neutral full-body combat guard, strict lateral profile facing screen-right (not frontal, three-quarter, or screen-left; do not mirror); balanced, both complete feet planted on one shared ground line; both complete hands in compact defensive guard; static—no attack, lunge, jump, crouch, kneel, or motion; complete silhouette, generous overscan, no crop';
    }
    return 'a neutral full-body combat guard in a clear 3/4 side presentation facing right, with both feet fully visible and stable';
  }
  if (sourceName === 'upright') {
    return 'an upright neutral full-body ready stance in 3/4 view facing right, balanced and suitable as the standing canonical anchor';
  }
  if (sourceName === 'crouch') {
    if (
      options.promptProfile === XAI_CANONICAL_SINGLE_SOURCE_PROMPT_PROFILE
      || options.promptProfile === XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE
      || options.promptProfile === XAI_CANONICAL_LAMINE_CROUCH_RETRY_PROMPT_PROFILE
    ) {
      return 'a deep compact balanced crouching guard, strict lateral profile facing screen-right (not frontal, three-quarter, or screen-left; do not mirror); head/hips substantially lowered; both soles planted on one shared ground line; two distinct complete hands close to face/upper chest in closed defensive guard; static—no attack, lunge, jump, kneel, or motion; complete silhouette, generous overscan, no crop';
    }
    return 'a deep but anatomically balanced crouching guard in 3/4 view facing right, with both feet and the complete silhouette visible';
  }
  throw new Error(`Unsupported canonical source: ${String(sourceName)}.`);
}

function fighterRequirements(fighter, sourceName, options = {}) {
  const original = fighter.referencePrompt?.trim() ?? '';
  if (original.length < 180) throw new Error(`Roster prompt is incomplete for ${fighter.slug}.`);
  const replaced = original.replace(
    /Show the complete figure head-to-toe in [^,]+,\s*3\/4 view facing right,/i,
    `Show the complete figure head-to-toe in ${sourcePoseInstruction(sourceName, options)},`,
  );
  if (replaced === original) throw new Error(`Roster prompt pose contract is unsupported for ${fighter.slug}.`);
  return replaced;
}

function buildIdentityHardGatePrompt(
  fighter,
  sourceName,
  options,
  globalSideIdentityHardGate,
  globalCrouchIdentityHardGate,
  globalIdentity,
) {
  const lamineCrouchRetry = options.promptProfile === XAI_CANONICAL_LAMINE_CROUCH_RETRY_PROMPT_PROFILE;
  const referenceRoles = globalSideIdentityHardGate ? [
    'REFERENCE ROLES — HARD; NEVER BLEND:',
    `1) IMAGE 3 = REAL ${fighter.name.toUpperCase()}; IDENTITY/SEX/FACE/PHYSIQUE hard gate. Render ${fighter.name} exactly as IMAGE 3—no model memory, celebrity prior, web knowledge, generic approximation, substitute. Preserve exact face, hair, skin, age, distinctive features, sex, natural build; unrecognizable = invalid. Ignore its crop, camera, background, photo style.`,
    '2) IMAGE 1 = APPROVED TRUMP UPRIGHT POSE/COMPOSITION ONLY: strict screen-right combat-guard joints/direction/balance/full-body frame/distance/foot baseline/silhouette. TARGET/OUTPUT override perspective/yaw/frame/facing/crop/floor/shadow/background. Never copy Trump identity, face, hair, skin, sex, physique, age, wardrobe, colors, logos, accessories.',
    '3) IMAGE 2 = APPROVED MILEI RENDERING-LANGUAGE ONLY: grounded premium fighting-game rendering, materials, controlled studio light, crisp edges. Never copy Milei identity, face, hair, sex, physique, age, pose, perspective, wardrobe, colors, insignia, accessories, floor, shadow, background; it supplies no clothing/body instructions.',
  ] : globalCrouchIdentityHardGate ? [
    'REFERENCE ROLES — HARD; NEVER BLEND:',
    `1) IMAGE 3 = REAL ${fighter.name.toUpperCase()}; IDENTITY/SEX/FACE/PHYSIQUE hard gate. Render ${fighter.name} exactly—no model memory, celebrity prior, web knowledge, generic substitute. Preserve exact face, hair, skin, age, features, sex, natural build; unrecognizable = invalid. Ignore clothes/crop/camera/background/style.`,
    '2) IMAGE 1 = APPROVED TRUMP CROUCH STRUCTURE ONLY: deep compact joints, two-hand guard, both soles, balance, full-body frame/baseline. Rotate to strict screen-right lateral TARGET; TARGET/OUTPUT override yaw/perspective/facing/frame/crop/floor/shadow/background. Never copy Trump identity, body, wardrobe, colors, logos, accessories.',
    lamineCrouchRetry
      ? `3) IMAGE 2 = APPROVED ${fighter.name.toUpperCase()} SIDE RAW; RENDERING/WARDROBE/HAIR ONLY: light, edges, garments/colors and uncovered hair shape/color. No face/body authority or standing pose/perspective/frame/floor/shadow/background. IMAGE 3 controls identity/build; TARGET crouch; OUTPUT background.`
      : `3) IMAGE 2 = APPROVED ${fighter.name.toUpperCase()} SIDE RAW; RENDERING/WARDROBE ONLY: fighting-game render, materials, light, edges, exact garments/colors. Never identity/body authority; never copy standing pose/perspective/frame/floor/shadow/background. IMAGE 3 controls identity/build; TARGET crouch; OUTPUT background.`,
  ] : [
    'REFERENCE ROLES — HARD; NEVER BLEND:',
    '1) IMAGE 3 = REAL IDENTITY/PHYSIQUE; hard gate. Render Elon Musk exactly as shown, never model memory/generic substitute. Preserve face geometry, hair, skin, age, distinctive features, rounded-square face, broad natural build; never narrow, angularize, or slim. Never copy its clothing/suit/shirt/tie/colors/accessories (IMAGE 2 controls wardrobe), crop, camera, background, photo rendering.',
    '2) IMAGE 1 = CROUCH STRUCTURE only: joints, depth, two-hand guard. Rotate/recompose to strict screen-right lateral TARGET. TARGET/OUTPUT override yaw, perspective, facing, framing, silhouette, foot baseline, background. Never copy identity, face, hair, physique, clothing, colors, logos, accessories.',
    '3) IMAGE 2 = RENDERING/WARDROBE only: premium fighting-game rendering, material detail, controlled light, crisp edges, garments/colors/style. Never copy identity, face, hair, physique, background/green vignette/gradient/logos, or accessories conflicting with ROSTER. IMAGE 3 alone controls build; OUTPUT alone background.',
  ];
  const identityAndAnatomy = globalSideIdentityHardGate || globalCrouchIdentityHardGate
    ? `IMAGES 1/2 -> ${fighter.name} from IMAGE 3; never blend face, sex, physique, identity. Coherent adult anatomy: natural head/joints, two distinct complete hands/feet. ${globalIdentity.safeguard}`
    : 'Replace people in IMAGES 1/2 with Elon Musk from IMAGE 3; never blend faces/identities. Keep coherent adult anatomy, natural head/joints, two distinct complete hands and feet.';
  const rosterWardrobeGate = globalSideIdentityHardGate
    ? 'Wardrobe/garments/footwear/palette/design ONLY from ROSTER; never IMAGES 1/2, celebrity memory, teams, performances, events.'
    : globalCrouchIdentityHardGate
    ? 'Wardrobe/render only approved IMAGE 2 plus ROSTER; ROSTER wins. Never IMAGE 1/3 clothing, celebrity memory, teams, events.'
    : 'ROSTER may refine details but never weaken IMAGE 3 identity; IMAGE 2 remains wardrobe master.';
  const finalPriority = globalSideIdentityHardGate
    ? `1) ${fighter.name.toUpperCase()} IDENTITY/SEX/FACE/PHYSIQUE, IMAGE 3 hard gate; 2) strict screen-right pose, IMAGE 1 under TARGET/OUTPUT; 3) render only IMAGE 2; 4) wardrobe/details only ROSTER. Roles stay separate.`
    : globalCrouchIdentityHardGate
    ? `1) ${fighter.name.toUpperCase()} IDENTITY/SEX/FACE/PHYSIQUE, IMAGE 3 hard gate; 2) deep strict screen-right CROUCH from IMAGE 1 under TARGET/OUTPUT; 3) rendering/wardrobe from approved IMAGE 2 plus ROSTER. Roles stay separate.`
    : '1) IDENTITY/PHYSIQUE from IMAGE 3 — hard gate; 2) CROUCH joints from IMAGE 1 subject to TARGET/OUTPUT; 3) rendering/wardrobe from IMAGE 2. Roster may refine but never weaken identity; assigned roles never overwrite each other.';
  return [
    ...referenceRoles,
    '',
    'IDENTITY / ANATOMY:',
    identityAndAnatomy,
    '',
    'TARGET + ROSTER (override references):',
    `${sourceName.toUpperCase()} canonical. ${fighterRequirements(fighter, sourceName, options)}`,
    rosterWardrobeGate,
    '',
    'OUTPUT — HARD EVEN IF A REFERENCE CONFLICTS:',
    'Exactly one full-body character; generous green overscan around complete head/hands/body/both feet; nothing touches/crosses an edge. No sprite sheet/sequence/collage/comparison/contact sheet. Background pure bright green (#00FF00), flat/uniform; no shadow, floor, gradient, text, watermark, logo, badge, emblem, brand-like symbol, prop, border.',
    '',
    'FINAL PRIORITY:',
    finalPriority,
  ].join('\n');
}

export function buildXaiCanonicalBundlePrompt(fighter, sourceName, options = {}) {
  const elonIdentityHardGate = options.promptProfile === XAI_CANONICAL_SINGLE_SOURCE_PROMPT_PROFILE;
  const globalSideIdentityHardGate = options.promptProfile === XAI_CANONICAL_GLOBAL_SIDE_PROMPT_PROFILE;
  const lamineCrouchRetry = options.promptProfile === XAI_CANONICAL_LAMINE_CROUCH_RETRY_PROMPT_PROFILE;
  const globalCrouchIdentityHardGate =
    options.promptProfile === XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE || lamineCrouchRetry;
  const identityHardGate = elonIdentityHardGate || globalSideIdentityHardGate || globalCrouchIdentityHardGate;
  if (options.promptProfile !== undefined && !identityHardGate) {
    throw new Error(`Unsupported canonical prompt profile: ${String(options.promptProfile)}.`);
  }
  if (elonIdentityHardGate && (fighter.slug !== 'elon-musk' || sourceName !== 'crouch')) {
    throw new Error('The reviewed identity-first wardrobe profile is sealed only for Elon Musk CROUCH.');
  }
  const globalIdentity = GLOBAL_SIDE_IDENTITY_CONTRACTS[fighter.slug];
  if (globalSideIdentityHardGate && (
    sourceName !== 'side'
    || !XAI_CANONICAL_GLOBAL_SIDE_SLUGS.includes(fighter.slug)
    || globalIdentity?.name !== fighter.name
  )) {
    throw new Error('The global identity-first SIDE profile is sealed only for Rosalía, Ibai Llanos, and Lamine Yamal with their exact roster identities.');
  }
  if (globalCrouchIdentityHardGate && (
    sourceName !== 'crouch'
    || !XAI_CANONICAL_GLOBAL_SIDE_SLUGS.includes(fighter.slug)
    || globalIdentity?.name !== fighter.name
  )) {
    throw new Error('The global identity-first CROUCH profile is sealed only for Rosalía, Ibai Llanos, and Lamine Yamal with their exact roster identities.');
  }
  if (lamineCrouchRetry && fighter.slug !== 'lamine-yamal') {
    throw new Error('The v2 no-headwear CROUCH retry profile is sealed only for Lamine Yamal.');
  }
  if (identityHardGate) {
    return assertXaiCanonicalPromptFitsPixcliSchema(buildIdentityHardGatePrompt(
      fighter,
      sourceName,
      options,
      globalSideIdentityHardGate,
      globalCrouchIdentityHardGate,
      lamineCrouchRetry
        ? { ...globalIdentity, safeguard: LAMINE_CROUCH_RETRY_SAFEGUARD }
        : globalIdentity,
    ));
  }
  const referenceRoles = [
    'REFERENCE ROLES — KEEP ALL THREE STRICTLY SEPARATE:',
    'IMAGE 1 is the POSE AND COMPOSITION MASTER only. Match its body pose, facing direction, balance, full-body framing, camera distance, and silhouette placement. Never copy its identity, face, hair, physique, clothes, colors, logos, or accessories.',
    'IMAGE 2 is the CANONICAL RENDERING MASTER only. Match its grounded premium fighting-game rendering language, natural adult proportions, material detail, controlled lighting, crisp edge treatment, and green-screen presentation. Never copy its identity, face, hair, clothes, colors, logos, or accessories.',
    'IMAGE 3 is the REAL IDENTITY AND PHYSIQUE ANCHOR only. Preserve this person\'s facial geometry, hair, skin tone, apparent age, distinguishing features, and natural body build. Never copy the portrait crop, camera, background, or photographic rendering.',
  ];
  const finalPriority = '1) Pose and composition from IMAGE 1. 2) Rendering language only from IMAGE 2. 3) Identity and physique from IMAGE 3. 4) Wardrobe and character details from the written roster requirements. Never let one reference overwrite another reference\'s assigned role.';
  return [
    ...referenceRoles,
    '',
    'TARGET SOURCE:',
    `Produce exactly one ${sourceName.toUpperCase()} canonical source: ${sourcePoseInstruction(sourceName, options)}.`,
    '',
    'IDENTITY, ANATOMY, AND CONSISTENCY:',
    'Replace every person in IMAGE 1 and IMAGE 2 with the person from IMAGE 3. Never blend faces or identities. Keep normal adult anatomy, a natural head scale, complete hands and feet, and coherent joints. The result must be immediately recognizable as IMAGE 3 while using only the assigned pose and rendering roles from the other references.',
    '',
    'ROSTER REQUIREMENTS:',
    fighterRequirements(fighter, sourceName, options),
    '',
    'OUTPUT CONTRACT:',
    'Return exactly one full-body character image, not a sprite sheet, sequence, collage, comparison, or contact sheet. Background must be pure bright green (#00FF00), flat and uniform, with no shadow, floor, gradient, text, watermark, logo, badge, emblem, brand-like symbol, prop, or border.',
    '',
    'FINAL PRIORITY ORDER:',
    finalPriority,
  ].join('\n');
}

export function buildXaiCanonicalBundlePayload({
  fighter,
  sourceName,
  poseAssetHash,
  renderingAssetHash,
  identityAssetHash,
  promptProfile,
}) {
  for (const [label, hash] of [
    ['pose', poseAssetHash],
    ['rendering', renderingAssetHash],
    ['identity', identityAssetHash],
  ]) {
    requireString(hash, `${label} PixCLI asset hash`, /^[a-f0-9]{32}$/);
  }
  if (new Set([poseAssetHash, renderingAssetHash, identityAssetHash]).size !== 3) {
    throw new Error(`${sourceName} must use three distinct PixCLI reference assets.`);
  }
  const markerVersion = promptProfile === XAI_CANONICAL_LAMINE_CROUCH_RETRY_PROMPT_PROFILE
    ? 'v2'
    : 'v1';
  const marker = `ip-canonical-${markerVersion}-${fighter.slug}-${sourceName}`;
  if (marker.length > 60) throw new Error(`PixCLI marker exceeds 60 characters: ${marker}.`);
  const prompt = assertXaiCanonicalPromptFitsPixcliSchema(
    buildXaiCanonicalBundlePrompt(fighter, sourceName, { promptProfile }),
  );
  return {
    prompt,
    model: XAI_CANONICAL_BUNDLE_MODEL.id,
    image: [poseAssetHash, renderingAssetHash, identityAssetHash],
    params: { ...XAI_CANONICAL_BUNDLE_MODEL.params },
    enrich_prompt: false,
    search: false,
    output_format: 'url',
    publish: false,
    publish_name: marker,
  };
}

export async function preflightXaiCanonicalBundleModel(options = {}) {
  const apiKey = options.apiKey ?? '';
  if (!apiKey) throw new Error('PIXCLI_API_KEY is required.');
  const apiBase = (options.apiBase ?? 'https://pixcli.hilo.cx').replace(/\/$/, '');
  const response = await (options.fetchImpl ?? fetch)(`${apiBase}/api/v1/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'insert-player-xai-canonical-bundle/1.0',
    },
    signal: AbortSignal.timeout(options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`PixCLI model preflight returned non-JSON HTTP ${response.status}.`);
  }
  if (!response.ok) throw new Error(`PixCLI model preflight failed with HTTP ${response.status}.`);
  const models = Array.isArray(body) ? body : body?.models;
  if (!Array.isArray(models)) throw new Error('PixCLI model preflight returned an unsupported catalog.');
  const matches = models.filter((entry) => entry?.id === XAI_CANONICAL_BUNDLE_MODEL.id);
  if (matches.length !== 1) throw new Error('Pinned PixCLI model is missing or ambiguous.');
  const model = matches[0];
  if (
    model.provider !== XAI_CANONICAL_BUNDLE_MODEL.provider
    || model.backend !== XAI_CANONICAL_BUNDLE_MODEL.backend
    || model.cost_per_image !== XAI_CANONICAL_BUNDLE_MODEL.catalogCostPerImage
    || model.advanced_mode !== true
    || !Array.isArray(model.capabilities)
    || !model.capabilities.includes('edit')
    || !model.capabilities.includes('image-to-image')
  ) {
    throw new Error('Pinned PixCLI model, capabilities, backend, or audited $0.11 price changed.');
  }
  return { model, catalogSha256: sha256(text) };
}

function defaultCommand(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    throw new Error(`${basename(binary)} failed: ${(result.error?.message ?? result.stderr ?? '').trim().slice(-1000)}`);
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function defaultBinaryCommand(binary, args) {
  const result = spawnSync(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${basename(binary)} failed: ${(result.error?.message ?? result.stderr?.toString('utf8') ?? '').trim().slice(-1000)}`);
  }
  return { stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0) };
}

export function verifyCanonicalCleanupToolchain(options = {}) {
  const runCommand = options.runCommand ?? defaultCommand;
  const ffmpegBinary = options.ffmpegBinary ?? 'ffmpeg';
  const result = runCommand(ffmpegBinary, ['-version']);
  const firstLine = result.stdout.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!firstLine.startsWith(`ffmpeg version ${XAI_CANONICAL_BUNDLE_CLEANUP.ffmpegVersion} `)) {
    throw new Error('ffmpeg does not match the sealed canonical-cleanup toolchain.');
  }
  return XAI_CANONICAL_BUNDLE_CLEANUP.ffmpegVersion;
}

function canonicalCleanupCommandArgs(rawPath, temporary) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-threads', '1', '-filter_threads', '1', '-i', rawPath,
    '-filter_complex', XAI_CANONICAL_BUNDLE_CLEANUP.filter,
    '-map', '[out]', '-an', '-sn', '-dn',
    '-frames:v', '1', '-compression_level', '9', temporary,
  ];
}

function runCanonicalCleanup(rawPath, cleanPath, options = {}) {
  const temporary = `${cleanPath}.writing-${process.pid}.png`;
  (options.runCommand ?? defaultCommand)(
    options.ffmpegBinary ?? 'ffmpeg',
    canonicalCleanupCommandArgs(rawPath, temporary),
  );
  if (!existsSync(temporary)) throw new Error('ffmpeg did not produce the canonical clean PNG.');
  const bytes = readFileSync(temporary);
  inspectPng(bytes, 'canonical clean output');
  chmodSync(temporary, 0o600);
  renameSync(temporary, cleanPath);
  chmodSync(cleanPath, 0o600);
  return { ...inspectPng(bytes, 'canonical clean output'), path: cleanPath };
}

export function verifyCanonicalCleanupFixture(options = {}) {
  const fixturePath = resolve(options.fixturePath ?? join(root, XAI_CANONICAL_BUNDLE_CLEANUP_FIXTURE.path));
  const outputPath = options.outputPath;
  if (!isAbsolute(outputPath ?? '')) throw new Error('Cleanup fixture verification requires an absolute output path.');
  if (existsSync(outputPath)) throw new Error('Cleanup fixture verification output already exists.');
  const fixtureBytes = readFileSync(fixturePath);
  if (sha256(fixtureBytes) !== XAI_CANONICAL_BUNDLE_CLEANUP_FIXTURE.inputSha256) {
    throw new Error('Canonical chroma-gradient fixture changed.');
  }
  const ffmpegVersion = verifyCanonicalCleanupToolchain(options);
  const temporary = `${outputPath}.writing-${process.pid}.png`;
  (options.runCommand ?? defaultCommand)(
    options.ffmpegBinary ?? 'ffmpeg',
    canonicalCleanupCommandArgs(fixturePath, temporary),
  );
  if (!existsSync(temporary)) throw new Error('ffmpeg did not produce the key/despill fixture PNG.');
  const cleanBytes = readFileSync(temporary);
  if (
    cleanBytes.byteLength < 24
    || !cleanBytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
    || cleanBytes.toString('ascii', 12, 16) !== 'IHDR'
    || cleanBytes.readUInt32BE(16) !== XAI_CANONICAL_BUNDLE_CLEANUP_FIXTURE.width
    || cleanBytes.readUInt32BE(20) !== XAI_CANONICAL_BUNDLE_CLEANUP_FIXTURE.height
    || sha256(cleanBytes) !== XAI_CANONICAL_BUNDLE_CLEANUP_FIXTURE.cleanSha256
  ) {
    throw new Error('Pinned canonical key/despill output changed.');
  }
  const decoded = (options.runBinaryCommand ?? defaultBinaryCommand)(
    options.ffmpegBinary ?? 'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
      '-i', temporary, '-map', '0:v:0', '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1',
    ],
  ).stdout;
  if (
    !Buffer.isBuffer(decoded)
    || decoded.byteLength !== (
      XAI_CANONICAL_BUNDLE_CLEANUP_FIXTURE.width
      * XAI_CANONICAL_BUNDLE_CLEANUP_FIXTURE.height
      * 4
    )
  ) {
    throw new Error('Pinned canonical key/despill fixture did not decode as exact RGBA bytes.');
  }
  for (const assertion of XAI_CANONICAL_BUNDLE_CLEANUP_FIXTURE.pixels) {
    const offset = (
      (assertion.y * XAI_CANONICAL_BUNDLE_CLEANUP_FIXTURE.width) + assertion.x
    ) * 4;
    if (!decoded.subarray(offset, offset + 4).equals(Buffer.from(assertion.rgba))) {
      throw new Error(`Pinned cleanup lost the ${assertion.label} invariant.`);
    }
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, outputPath);
  chmodSync(outputPath, 0o600);
  return {
    ffmpegVersion,
    fixturePath,
    path: outputPath,
    width: XAI_CANONICAL_BUNDLE_CLEANUP_FIXTURE.width,
    height: XAI_CANONICAL_BUNDLE_CLEANUP_FIXTURE.height,
    sizeBytes: cleanBytes.byteLength,
    contentSha256: XAI_CANONICAL_BUNDLE_CLEANUP_FIXTURE.cleanSha256,
  };
}

function createContactSheet(sourceArtifacts, sourceNames, outputPath, options = {}) {
  const temporary = `${outputPath}.writing-${process.pid}.png`;
  const inputArgs = [];
  for (const name of sourceNames) {
    inputArgs.push('-i', sourceArtifacts[name].raw.absolutePath, '-i', sourceArtifacts[name].clean.absolutePath);
  }
  const filters = [];
  for (let index = 0; index < sourceNames.length * 2; index += 1) {
    filters.push(`[${index}:v]scale=384:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=384:512:(ow-iw)/2:(oh-ih)/2:color=0x202226,format=rgba[t${index}]`);
  }
  if (sourceNames.length === 1) {
    filters.push('[t0][t1]xstack=inputs=2:layout=0_0|384_0:fill=0x202226[review]');
  } else {
    filters.push('[t0][t2][t4][t1][t3][t5]xstack=inputs=6:layout=0_0|384_0|768_0|0_512|384_512|768_512:fill=0x202226[review]');
  }
  (options.runCommand ?? defaultCommand)(options.ffmpegBinary ?? 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-filter_threads', '1',
    ...inputArgs,
    '-filter_complex', filters.join(';'), '-map', '[review]', '-frames:v', '1', '-compression_level', '9', temporary,
  ]);
  if (!existsSync(temporary)) throw new Error('ffmpeg did not produce the contact sheet.');
  const bytes = readFileSync(temporary);
  const inspected = inspectPng(bytes, 'canonical contact sheet');
  const expectedWidth = sourceNames.length === 1 ? 768 : 1152;
  const expectedHeight = sourceNames.length === 1 ? 512 : 1024;
  if (inspected.width !== expectedWidth || inspected.height !== expectedHeight) {
    throw new Error('Canonical contact sheet dimensions changed.');
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, outputPath);
  chmodSync(outputPath, 0o600);
  return { ...inspected, path: outputPath };
}

function stateResumeAction(slot) {
  if (!slot) return 'submit';
  if (slot.status === 'submitted' || slot.status === 'processing') return 'poll';
  if (slot.status === 'provider_completed') return 'clean';
  if (slot.status === 'completed') return 'verify';
  if (slot.status === 'submitting' || slot.status === 'submission_outcome_unknown') return 'block';
  if (slot.status === 'failed' || slot.status === 'submission_rejected') return 'terminal';
  throw new Error(`Unknown canonical source state: ${String(slot.status)}.`);
}

function readState(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function verifyStoredArtifact(artifact, outputDirectory, label) {
  const absolutePath = resolve(outputDirectory, artifact?.path ?? '');
  if (!absolutePath.startsWith(`${resolve(outputDirectory)}${sep}`) || !existsSync(absolutePath)) {
    throw new Error(`${label} local artifact is missing.`);
  }
  const inspected = inspectPng(readFileSync(absolutePath), label);
  for (const key of ['contentSha256', 'sizeBytes', 'width', 'height']) {
    if (artifact[key] !== inspected[key]) throw new Error(`${label} local artifact hash or shape changed.`);
  }
  return { ...artifact, absolutePath };
}

async function parseResponseJson(response, label) {
  const text = await response.text();
  try {
    return { body: text ? JSON.parse(text) : {}, text };
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status} (${sha256(text)}).`);
  }
}

function auditKind(asset) {
  const kind = asset?.metadata?.artifact_kind;
  if (kind === 'provider_request' || kind === 'provider_response') return kind;
  if (String(asset?.mime_type ?? '').startsWith('image/')) return 'image';
  return null;
}

async function readBoundedResponseBytes(response, maximumBytes, label) {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > maximumBytes) {
    throw new Error(`${label} has an invalid declared size.`);
  }
  if (!response.body) throw new Error(`${label} response body is missing.`);
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeds the byte limit.`);
    }
    chunks.push(Buffer.from(value));
  }
  if (declaredLength > 0 && total !== declaredLength) {
    throw new Error(`${label} size does not match Content-Length.`);
  }
  return Buffer.concat(chunks, total);
}

async function downloadAuditAsset(asset, path, headers, fetchImpl, options = {}) {
  requireString(asset?.hash, 'PixCLI audit asset hash', /^[a-f0-9]{32}$/);
  const expectedUrl = `${options.apiBase}/api/v1/assets/${asset.hash}`;
  if (asset?.url !== expectedUrl) throw new Error('PixCLI audit asset URL is not the exact authenticated asset route.');
  const declaredContentSha256 = asset?.metadata?.content_sha256;
  if (options.requireContentSha256 !== false) {
    requireString(declaredContentSha256, 'PixCLI audit content SHA-256', /^[a-f0-9]{64}$/);
  } else if (
    declaredContentSha256 !== undefined
    && declaredContentSha256 !== null
    && !/^[a-f0-9]{64}$/.test(declaredContentSha256)
  ) {
    throw new Error('PixCLI audit content SHA-256 is invalid.');
  }
  const response = await fetchImpl(asset.url, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`PixCLI audit artifact download failed with HTTP ${response.status}.`);
  const expectedMimeType = options.expectedMimeType ?? asset.mime_type;
  const responseMimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? '';
  if (responseMimeType !== expectedMimeType) {
    throw new Error(`PixCLI audit artifact MIME mismatch for ${basename(path)}.`);
  }
  const bytes = await readBoundedResponseBytes(
    response,
    options.maximumBytes ?? MAX_AUDIT_JSON_BYTES,
    `PixCLI audit artifact ${basename(path)}`,
  );
  const actual = sha256(bytes);
  if (declaredContentSha256 && declaredContentSha256 !== actual) {
    throw new Error(`PixCLI audit artifact hash mismatch for ${basename(path)}.`);
  }
  if (asset.mime_type === 'application/json') JSON.parse(bytes.toString('utf8'));
  writeBytesAtomic(path, bytes);
  return {
    contentSha256: actual,
    sizeBytes: bytes.byteLength,
    mimeType: asset.mime_type,
    pixcliAssetHash: asset.hash,
    providerRequestId: asset?.metadata?.provider_request_id ?? null,
  };
}

function verifyNormalizedPixcliInput(input, payload, apiBase, sourceName) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${sourceName} PixCLI normalized input is invalid.`);
  }
  const serverDerivedKeys = ['image_url', 'image_urls', 'enriched_prompt'];
  exactKeys(input, [...Object.keys(payload), ...serverDerivedKeys], `${sourceName} PixCLI normalized input`);

  const submittedProjection = { ...input };
  for (const key of serverDerivedKeys) delete submittedProjection[key];
  if (sha256(canonicalJson(submittedProjection)) !== sha256(canonicalJson(payload))) {
    throw new Error(`${sourceName} PixCLI input does not match the sealed request.`);
  }

  const expectedImageUrls = payload.image.map((hash) => `${apiBase}/api/v1/assets/${hash}`);
  if (
    input.enriched_prompt !== payload.prompt
    || input.image_url !== expectedImageUrls[0]
    || canonicalJson(input.image_urls) !== canonicalJson(expectedImageUrls)
  ) {
    throw new Error(`${sourceName} PixCLI normalized prompt or reference URLs changed.`);
  }
  return expectedImageUrls;
}

function verifyProviderRequestAudit(value, payload, imageUrls, sourceName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${sourceName} PixCLI provider request audit is invalid.`);
  }
  exactKeys(
    value,
    ['model', 'input', 'retry_policy', 'fallback_policy'],
    `${sourceName} PixCLI provider request audit`,
  );
  const expectedInput = {
    ...payload.params,
    prompt: payload.prompt,
    image_urls: imageUrls,
  };
  if (
    value.model !== XAI_CANONICAL_BUNDLE_MODEL.endpoint
    || value.retry_policy !== 'none'
    || value.fallback_policy !== 'none'
    || canonicalJson(value.input) !== canonicalJson(expectedInput)
  ) {
    throw new Error(`${sourceName} PixCLI provider request does not match the sealed provider contract.`);
  }
}

function verifyProviderResponseAudit(value, imageAsset, sourceName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${sourceName} PixCLI provider response audit is invalid.`);
  }
  exactKeys(value, ['images', 'revised_prompt'], `${sourceName} PixCLI provider response audit`);
  if (value.revised_prompt !== null || !Array.isArray(value.images) || value.images.length !== 1) {
    throw new Error(`${sourceName} PixCLI provider response is missing the sole unmodified output.`);
  }
  const [image] = value.images;
  exactKeys(
    image,
    ['url', 'content_type', 'file_name', 'file_size', 'width', 'height'],
    `${sourceName} PixCLI provider response image`,
  );
  let sourceUrl;
  try {
    sourceUrl = new URL(image.url);
  } catch {
    throw new Error(`${sourceName} PixCLI provider response image URL is invalid.`);
  }
  if (
    sourceUrl.protocol !== 'https:'
    || sourceUrl.hostname !== 'v3b.fal.media'
    || sourceUrl.search !== ''
    || sourceUrl.hash !== ''
    || image.url !== imageAsset?.metadata?.source_url
    || image.content_type !== 'image/png'
    || image.file_name !== basename(sourceUrl.pathname)
    || !image.file_name.endsWith('.png')
    || (image.file_size !== null && image.file_size !== imageAsset.size_bytes)
    || image.width !== imageAsset.width
    || image.height !== imageAsset.height
  ) {
    throw new Error(`${sourceName} PixCLI provider response image does not match the stored output.`);
  }
}

async function archiveCompletedSource(options, slot, job, payload) {
  if (job.status !== 'completed') throw new Error(`${slot.sourceName} did not complete without fallback.`);
  if (
    !Number.isSafeInteger(job.cost)
    || job.cost !== XAI_CANONICAL_BUNDLE_MODEL.auditedCostMicrocredits
  ) {
    throw new Error(`${slot.sourceName} provider cost changed from the audited $0.11 (110000 microcredits).`);
  }
  const response = await options.fetchImpl(
    `${options.apiBase}/api/v1/jobs/${encodeURIComponent(slot.pixcliJobId)}/canva`,
    { headers: options.headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  const { body: canva } = await parseResponseJson(response, 'PixCLI Canva audit');
  if (!response.ok) throw new Error(`PixCLI Canva audit failed with HTTP ${response.status}.`);
  const normalizedImageUrls = verifyNormalizedPixcliInput(
    canva.input,
    payload,
    options.apiBase,
    slot.sourceName,
  );
  if (sha256(canonicalJson(payload)) !== slot.requestSha256) throw new Error(`${slot.sourceName} request hash changed.`);
  const providerRuns = Array.isArray(canva.provider_runs) ? canva.provider_runs : [];
  if (
    canva.job?.status !== 'completed'
    || canva.job?.job_id !== slot.pixcliJobId
    || !Number.isSafeInteger(canva.job?.cost)
    || canva.job.cost !== XAI_CANONICAL_BUNDLE_MODEL.auditedCostMicrocredits
  ) {
    throw new Error(`${slot.sourceName} PixCLI audited job status, id, or $0.11 (110000-microcredit) cost changed.`);
  }
  if (
    providerRuns.length !== 1
    || providerRuns[0]?.modelId !== XAI_CANONICAL_BUNDLE_MODEL.id
    || providerRuns[0]?.provider !== XAI_CANONICAL_BUNDLE_MODEL.backend
    || typeof providerRuns[0]?.requestId !== 'string'
    || !providerRuns[0].requestId
  ) {
    throw new Error(`${slot.sourceName} PixCLI provider run is missing or ambiguous.`);
  }
  const assets = Array.isArray(canva.assets) ? canva.assets : [];
  const grouped = Object.groupBy(assets, auditKind);
  for (const kind of ['provider_request', 'provider_response', 'image']) {
    if ((grouped[kind] ?? []).length !== 1) throw new Error(`${slot.sourceName} ${kind} output is missing or ambiguous.`);
  }
  if (
    grouped.provider_request[0].mime_type !== 'application/json'
    || grouped.provider_response[0].mime_type !== 'application/json'
    || grouped.provider_request[0]?.metadata?.model !== XAI_CANONICAL_BUNDLE_MODEL.id
    || grouped.provider_response[0]?.metadata?.model !== XAI_CANONICAL_BUNDLE_MODEL.id
    || grouped.provider_response[0]?.metadata?.provider_request_id !== providerRuns[0].requestId
    || grouped.image[0]?.metadata?.model !== XAI_CANONICAL_BUNDLE_MODEL.id
    || grouped.image[0]?.metadata?.prompt !== payload.prompt
  ) {
    throw new Error(`${slot.sourceName} PixCLI audit assets do not match the sealed job and provider run.`);
  }
  const auditDirectory = join(options.outputDirectory, 'audit', slot.sourceName);
  mkdirSync(auditDirectory, { recursive: true, mode: 0o700 });
  const request = await downloadAuditAsset(
    grouped.provider_request[0],
    join(auditDirectory, 'provider_request.json'),
    options.headers,
    options.fetchImpl,
    { apiBase: options.apiBase, expectedMimeType: 'application/json', maximumBytes: MAX_AUDIT_JSON_BYTES },
  );
  verifyProviderRequestAudit(
    JSON.parse(readFileSync(join(auditDirectory, 'provider_request.json'), 'utf8')),
    payload,
    normalizedImageUrls,
    slot.sourceName,
  );
  const providerResponse = await downloadAuditAsset(
    grouped.provider_response[0],
    join(auditDirectory, 'provider_response.json'),
    options.headers,
    options.fetchImpl,
    { apiBase: options.apiBase, expectedMimeType: 'application/json', maximumBytes: MAX_AUDIT_JSON_BYTES },
  );
  verifyProviderResponseAudit(
    JSON.parse(readFileSync(join(auditDirectory, 'provider_response.json'), 'utf8')),
    grouped.image[0],
    slot.sourceName,
  );
  const rawPath = join(options.outputDirectory, 'sources', `${slot.sourceName}_raw.png`);
  const rawDownload = await downloadAuditAsset(
    grouped.image[0],
    rawPath,
    options.headers,
    options.fetchImpl,
    {
      apiBase: options.apiBase,
      expectedMimeType: 'image/png',
      maximumBytes: MAX_PNG_BYTES,
      requireContentSha256: false,
    },
  );
  const rawInspected = inspectPng(readFileSync(rawPath), `${slot.sourceName} raw output`);
  if (
    grouped.image[0].mime_type !== 'image/png'
    || grouped.image[0].size_bytes !== rawDownload.sizeBytes
    || grouped.image[0].width !== rawInspected.width
    || grouped.image[0].height !== rawInspected.height
  ) throw new Error(`${slot.sourceName} output bytes or PNG shape do not match the PixCLI record.`);
  return {
    raw: {
      ...rawDownload,
      ...rawInspected,
      providerRequestId: providerRuns[0].requestId,
      path: relative(options.outputDirectory, rawPath),
    },
    audit: {
      providerRequest: { ...request, path: relative(options.outputDirectory, join(auditDirectory, 'provider_request.json')) },
      providerResponse: { ...providerResponse, path: relative(options.outputDirectory, join(auditDirectory, 'provider_response.json')) },
      providerRun: providerRuns[0],
      inputSha256: sha256(canonicalJson(payload)),
      costMicrocredits: job.cost,
      costUsd: job.cost / 1_000_000,
    },
  };
}

function referenceUploadKey(reference) {
  return `reference:${reference.contentSha256}`;
}

async function ensureUploadedReference(options, reference, state, saveState) {
  const key = referenceUploadKey(reference);
  const previous = state.uploads[key];
  if (previous) {
    if (
      previous.status !== 'uploaded'
      || previous.contentSha256 !== reference.contentSha256
      || !/^[a-f0-9]{32}$/.test(previous.pixcliAssetHash ?? '')
    ) {
      throw new Error(`Reference upload requires manual reconciliation: ${reference.id}.`);
    }
    return previous;
  }
  const fighter = { slug: reference.id, reference: { sourceSha256: reference.contentSha256 } };
  return uploadBakeoffSource({
    apiBase: options.apiBase,
    apiKey: options.apiKey,
    fighter,
    sourceBytes: reference.bytes,
    sourceSha256: reference.contentSha256,
    fetchImpl: options.fetchImpl,
    save: (upload) => {
      state.uploads[key] = { ...upload, id: reference.id, contentSha256: reference.contentSha256 };
      saveState();
    },
  });
}

function buildBundleMatrix(fighter, poseBundle, sourceNames, promptProfile) {
  return sourceNames.map((sourceName) => {
    const source = poseBundle.sources[sourceName];
    const prompt = buildXaiCanonicalBundlePrompt(fighter, sourceName, { promptProfile });
    const promptSha256 = sha256(prompt);
    const reviewedPromptSha256 = promptProfile
      ? reviewedXaiCanonicalSingleSourcePromptSha256(fighter.slug, sourceName, promptProfile)
      : undefined;
    if (promptProfile && promptSha256 !== reviewedPromptSha256) {
      throw new Error(`The exact reviewed single-source prompt snapshot changed for ${fighter.slug}.`);
    }
    return {
      sourceName,
      fighterSlug: fighter.slug,
      originalSha256: fighter.reference.sourceSha256,
      poseId: source.pose.id,
      poseSha256: source.pose.contentSha256,
      renderingId: source.rendering.id,
      renderingSha256: source.rendering.contentSha256,
      promptSha256,
      ...(promptProfile ? { promptProfile } : {}),
      modelId: XAI_CANONICAL_BUNDLE_MODEL.id,
      params: XAI_CANONICAL_BUNDLE_MODEL.params,
    };
  });
}

function buildInitialState({ fighter, poseBundle, matrixSha256, sourceNames, requestIdentity }) {
  const singleSource = sourceNames.length === 1;
  return {
    schemaVersion: 1,
    bundleId: singleSource
      ? requestIdentity.bundleId
      : `arcade-xai-canonical-bundle-${fighter.slug}-v1`,
    fighterSlug: fighter.slug,
    fighterName: fighter.name,
    originalSha256: fighter.reference.sourceSha256,
    poseManifestId: poseBundle.manifest.manifestId,
    poseManifestSha256: poseBundle.manifestSha256,
    matrixSha256,
    status: 'running',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...(singleSource ? { sourceNames: [...sourceNames] } : {}),
    policy: canonicalBundlePolicy(sourceNames),
    uploads: {},
    slots: {},
  };
}

function buildDescriptor(state, matrix, artifacts, sourceNames, contactSheet, outputDirectory) {
  const portableArtifact = (artifact) => {
    const { absolutePath: _absolutePath, ...portable } = artifact;
    return portable;
  };
  const descriptor = {
    schemaVersion: 1,
    descriptorType: 'arcade_xai_canonical_bundle_review',
    bundleId: state.bundleId,
    status: 'awaiting_human_review',
    baseCommit: XAI_CANONICAL_BUNDLE_BASE_COMMIT,
    fighter: {
      slug: state.fighterSlug,
      name: state.fighterName,
      originalSha256: state.originalSha256,
    },
    poseManifest: {
      id: state.poseManifestId,
      contentSha256: state.poseManifestSha256,
    },
    ...(sourceNames.length === 1 ? { sourceNames: [...sourceNames] } : {}),
    provider: {
      modelId: XAI_CANONICAL_BUNDLE_MODEL.id,
      endpoint: XAI_CANONICAL_BUNDLE_MODEL.endpoint,
      provider: XAI_CANONICAL_BUNDLE_MODEL.provider,
      backend: XAI_CANONICAL_BUNDLE_MODEL.backend,
      auditedCostPerOutputUsd: XAI_CANONICAL_BUNDLE_MODEL.auditedCostUsd,
      maximumCostPerOutputUsd: state.policy.maximumCostPerOutputUsd,
      maximumBundleCostUsd: state.policy.maximumBundleCostUsd,
      paidCalls: sourceNames.length,
      actualCostUsd: Number(Object.values(state.slots).reduce((sum, slot) => sum + slot.audit.costUsd, 0).toFixed(2)),
    },
    cleanup: {
      ffmpegVersion: XAI_CANONICAL_BUNDLE_CLEANUP.ffmpegVersion,
      filter: XAI_CANONICAL_BUNDLE_CLEANUP.filter,
    },
    policy: state.policy,
    sources: Object.fromEntries(sourceNames.map((sourceName) => {
      const slot = state.slots[sourceName];
      const sealed = matrix.find((entry) => entry.sourceName === sourceName);
      return [sourceName, {
        references: {
          pose: { id: sealed.poseId, contentSha256: sealed.poseSha256 },
          rendering: { id: sealed.renderingId, contentSha256: sealed.renderingSha256 },
          identity: { contentSha256: state.originalSha256 },
        },
        promptSha256: slot.promptSha256,
        requestSha256: slot.requestSha256,
        pixcliJobId: slot.pixcliJobId,
        providerRequestId: slot.audit.providerRun.requestId,
        raw: portableArtifact(artifacts[sourceName].raw),
        clean: portableArtifact(artifacts[sourceName].clean),
      }];
    })),
    contactSheet: {
      path: relative(outputDirectory, contactSheet.path),
      contentSha256: contactSheet.contentSha256,
      sizeBytes: contactSheet.sizeBytes,
      width: contactSheet.width,
      height: contactSheet.height,
      layout: sourceNames.length === 1
        ? [`${sourceNames[0]}_raw`, `${sourceNames[0]}_clean`]
        : ['side_raw', 'upright_raw', 'crouch_raw', 'side_clean', 'upright_clean', 'crouch_clean'],
    },
  };
  return { ...descriptor, descriptorSha256: sha256(canonicalJson(descriptor)) };
}

export async function runXaiCanonicalBundle(options = {}) {
  const sourceNames = selectedCanonicalSourceNames(options.sourceName);
  const singleSource = sourceNames.length === 1;
  const slug = requireString(options.slug, 'explicit roster slug', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  if (!singleSource && options.requestVersion) {
    throw new Error('A canonical retry request version is valid only for one sealed source.');
  }
  const requestIdentity = singleSource
    ? resolveXaiCanonicalSingleSourceRequest(slug, sourceNames[0], options.requestVersion ?? '')
    : null;
  const requiredConfirmation = requestIdentity?.confirmation ?? XAI_CANONICAL_BUNDLE_CONFIRMATION;
  if (options.confirmation !== requiredConfirmation) {
    throw new Error(`Paid execution requires confirmation ${requiredConfirmation}.`);
  }
  if (options.privateConfirmation !== XAI_CANONICAL_BUNDLE_PRIVATE_CONFIRMATION) {
    throw new Error(`Private-only execution requires confirmation ${XAI_CANONICAL_BUNDLE_PRIVATE_CONFIRMATION}.`);
  }
  const requiredMaxCostUsd = singleSource
    ? XAI_CANONICAL_BUNDLE_MODEL.singleSourceMaxCostUsd
    : XAI_CANONICAL_BUNDLE_MODEL.maxBundleCostUsd;
  if (Number(options.maxCostUsd) !== requiredMaxCostUsd) {
    throw new Error(`Explicit --max-cost-usd=${requiredMaxCostUsd.toFixed(2)} is required.`);
  }
  const apiKey = options.apiKey ?? '';
  if (!apiKey) throw new Error('PIXCLI_API_KEY is required.');
  const apiBase = (options.apiBase ?? 'https://pixcli.hilo.cx').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  validateManifest(manifest);
  const matches = manifest.fighters.filter((entry) => entry.slug === slug);
  if (matches.length !== 1) throw new Error(`Roster slug is missing or ambiguous: ${slug}.`);
  const fighter = matches[0];
  const poseBundle = loadXaiCanonicalPoseManifest(
    options.poseManifestPath,
    options.poseManifestSha256,
    sourceNames,
  );
  const promptProfile = requestIdentity?.promptProfile;
  validateXaiCanonicalPromptProfileReferences(poseBundle, promptProfile, fighter);
  const sourcePath = join(options.sourceDir ?? DEFAULT_SOURCE_DIR, `${slug}.png`);
  const original = verifyBakeoffSource(fighter, sourcePath);
  for (const sourceName of sourceNames) {
    const referenceHashes = [
      poseBundle.sources[sourceName].pose.contentSha256,
      poseBundle.sources[sourceName].rendering.contentSha256,
      original.sourceSha256,
    ];
    if (new Set(referenceHashes).size !== 3) throw new Error(`${sourceName} references are not three distinct assets.`);
  }
  const matrix = buildBundleMatrix(fighter, poseBundle, sourceNames, promptProfile);
  if (singleSource) {
    const expectedPromptSha256 = requireString(
      options.promptSha256,
      'explicit single-source prompt SHA-256',
      /^[a-f0-9]{64}$/,
    );
    if (matrix[0].promptSha256 !== expectedPromptSha256) {
      throw new Error('Single-source prompt SHA-256 does not match the reviewed prompt snapshot.');
    }
  }
  const matrixSha256 = sha256(canonicalJson(matrix));
  const stateStem = requestIdentity?.stateStem ?? slug;
  const statePath = resolve(options.statePath ?? join(DEFAULT_STATE_ROOT, `${stateStem}.json`));
  const outputDirectory = resolve(options.outputDirectory ?? join(DEFAULT_OUTPUT_ROOT, stateStem));
  const locks = acquireExclusiveBundleLocks(statePath, outputDirectory);
  try {
    mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(join(outputDirectory, 'sources'), { recursive: true, mode: 0o700 });
    let state = readState(statePath) ?? buildInitialState({
      fighter,
      poseBundle,
      matrixSha256,
      sourceNames,
      requestIdentity,
    });
  const expected = buildInitialState({
    fighter,
    poseBundle,
    matrixSha256,
    sourceNames,
    requestIdentity,
  });
  for (const key of [
    'schemaVersion', 'bundleId', 'fighterSlug', 'originalSha256', 'poseManifestId',
    'poseManifestSha256', 'matrixSha256',
  ]) {
    if (state[key] !== expected[key]) throw new Error(`Existing canonical bundle state mismatch: ${key}.`);
  }
  if (canonicalJson(state.policy) !== canonicalJson(expected.policy)) {
    throw new Error('Existing canonical bundle state policy changed.');
  }
  if (canonicalJson(state.sourceNames) !== canonicalJson(expected.sourceNames)) {
    throw new Error('Existing canonical bundle state source selection changed.');
  }
  const unknownSlots = Object.keys(state.slots ?? {}).filter((name) => !sourceNames.includes(name));
  if (unknownSlots.length > 0) throw new Error('Existing canonical bundle state contains an unknown paid-call slot.');
  const saveState = () => {
    state.updatedAt = nowIso();
    writeJsonAtomic(statePath, state);
  };
  const saveSlot = (slot) => {
    state.slots[slot.sourceName] = slot;
    saveState();
  };
  saveState();

  const ffmpegVersion = verifyCanonicalCleanupToolchain(options);
  let preflight = null;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': 'insert-player-xai-canonical-bundle/1.0',
  };
  const identityReference = {
    id: `identity-${fighter.slug}`,
    contentSha256: original.sourceSha256,
    bytes: original.bytes,
  };

  for (const sealed of matrix) {
    const sourceName = sealed.sourceName;
    const references = poseBundle.sources[sourceName];
    const previous = state.slots[sourceName] ?? null;
    if (previous) {
      for (const key of [
        'sourceName', 'fighterSlug', 'originalSha256', 'poseSha256', 'renderingSha256',
        'promptSha256', 'promptProfile', 'modelId',
      ]) {
        if (previous[key] !== sealed[key]) throw new Error(`${sourceName} state invariant mismatch: ${key}.`);
      }
    }
    let action = stateResumeAction(previous);
    if (action === 'block') throw new Error(`${sourceName} has an ambiguous POST; automatic reconciliation is forbidden.`);
    if (action === 'terminal') throw new Error(`${sourceName} is terminal and the bundle cannot continue.`);
    if (action === 'submit') {
      preflight ??= await preflightXaiCanonicalBundleModel({ apiBase, apiKey, fetchImpl });
      state.lastCatalogPreflight = {
        modelId: XAI_CANONICAL_BUNDLE_MODEL.id,
        catalogSha256: preflight.catalogSha256,
        checkedAt: nowIso(),
      };
      saveState();
      const [poseUpload, renderingUpload, identityUpload] = await Promise.all([
        ensureUploadedReference({ apiBase, apiKey, fetchImpl }, references.pose, state, saveState),
        ensureUploadedReference({ apiBase, apiKey, fetchImpl }, references.rendering, state, saveState),
        ensureUploadedReference({ apiBase, apiKey, fetchImpl }, identityReference, state, saveState),
      ]);
      const payload = buildXaiCanonicalBundlePayload({
        fighter,
        sourceName,
        promptProfile: sealed.promptProfile,
        poseAssetHash: poseUpload.pixcliAssetHash,
        renderingAssetHash: renderingUpload.pixcliAssetHash,
        identityAssetHash: identityUpload.pixcliAssetHash,
      });
      const invariants = {
        ...sealed,
        slotKey: `${state.bundleId}:${sourceName}`,
        slug: fighter.slug,
        fighterName: fighter.name,
        sourceSha256: original.sourceSha256,
        providerEndpoint: XAI_CANONICAL_BUNDLE_MODEL.endpoint,
        requestSha256: sha256(canonicalJson(payload)),
      };
      const submitted = await submitBakeoffSlot({
        apiBase,
        apiKey,
        payload,
        slot: null,
        invariants,
        save: saveSlot,
        fetchImpl,
      });
      if (submitted.action === 'rejected') throw new Error(`${sourceName} PixCLI submission was rejected.`);
      action = 'poll';
    }
    let slot = state.slots[sourceName];
    const payload = (() => {
      const poseUpload = state.uploads[referenceUploadKey(references.pose)];
      const renderingUpload = state.uploads[referenceUploadKey(references.rendering)];
      const identityUpload = state.uploads[referenceUploadKey(identityReference)];
      if (![poseUpload, renderingUpload, identityUpload].every((entry) => entry?.status === 'uploaded')) {
        throw new Error(`${sourceName} upload state is incomplete.`);
      }
      return buildXaiCanonicalBundlePayload({
        fighter,
        sourceName,
        promptProfile: sealed.promptProfile,
        poseAssetHash: poseUpload.pixcliAssetHash,
        renderingAssetHash: renderingUpload.pixcliAssetHash,
        identityAssetHash: identityUpload.pixcliAssetHash,
      });
    })();
    if (slot.requestSha256 !== sha256(canonicalJson(payload))) throw new Error(`${sourceName} request hash changed.`);
    if (action === 'poll') {
      const job = await pollJob({
        apiBase,
        headers,
        saveSlot,
        fetchImpl,
        sleepImpl: options.sleepImpl,
        pollIntervalMs: options.pollIntervalMs,
        jobTimeoutMs: options.jobTimeoutMs,
      }, slot);
      if (job.status !== 'completed') {
        saveSlot({ ...slot, status: 'failed', providerStatus: job.status, providerError: job.error ?? null });
        throw new Error(`${sourceName} provider job did not complete cleanly.`);
      }
      const archived = await archiveCompletedSource({
        apiBase,
        headers,
        outputDirectory,
        fetchImpl,
      }, slot, job, payload);
      slot = { ...slot, ...archived, status: 'provider_completed', completedAt: nowIso() };
      saveSlot(slot);
      action = 'clean';
    }
    if (action === 'clean') {
      const raw = verifyStoredArtifact(slot.raw, outputDirectory, `${sourceName} raw`);
      const cleanPath = join(outputDirectory, 'sources', `${sourceName}.png`);
      const cleaned = runCanonicalCleanup(raw.absolutePath, cleanPath, options);
      slot = {
        ...slot,
        clean: { ...cleaned, path: relative(outputDirectory, cleanPath) },
        cleanupFfmpegVersion: ffmpegVersion,
        cleanupFilter: XAI_CANONICAL_BUNDLE_CLEANUP.filter,
        status: 'completed',
        updatedAt: nowIso(),
      };
      saveSlot(slot);
      action = 'verify';
    }
    if (action === 'verify') {
      verifyStoredArtifact(slot.raw, outputDirectory, `${sourceName} raw`);
      verifyStoredArtifact(slot.clean, outputDirectory, `${sourceName} clean`);
      if (
        slot.cleanupFfmpegVersion !== ffmpegVersion
        || slot.cleanupFilter !== XAI_CANONICAL_BUNDLE_CLEANUP.filter
      ) {
        throw new Error(`${sourceName} cleanup contract changed; use the sealed offline re-clean path.`);
      }
    }
  }

  const artifacts = Object.fromEntries(sourceNames.map((sourceName) => {
    const slot = state.slots[sourceName];
    return [sourceName, {
      raw: verifyStoredArtifact(slot.raw, outputDirectory, `${sourceName} raw`),
      clean: verifyStoredArtifact(slot.clean, outputDirectory, `${sourceName} clean`),
    }];
  }));
  const contactSheet = createContactSheet(
    artifacts,
    sourceNames,
    join(outputDirectory, 'contact-sheet.png'),
    options,
  );
  if (state.contactSheetSha256 && state.contactSheetSha256 !== contactSheet.contentSha256) {
    throw new Error('Canonical contact sheet changed on deterministic resume.');
  }
  const descriptor = buildDescriptor(state, matrix, artifacts, sourceNames, contactSheet, outputDirectory);
  writeJsonAtomic(join(outputDirectory, 'review-descriptor.json'), descriptor);
  state.status = 'awaiting_human_review';
  state.descriptorSha256 = descriptor.descriptorSha256;
  state.contactSheetSha256 = contactSheet.contentSha256;
  saveState();
  writeJsonAtomic(join(outputDirectory, 'generation-state.json'), state);
    return { state, descriptor, outputDirectory, statePath };
  } finally {
    releaseExclusiveBundleLocks(locks);
  }
}

function readSealedJson(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing.`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function exactBundleArtifactPath(bundleDirectory, artifact, expectedPath, label) {
  if (artifact?.path !== expectedPath) throw new Error(`${label} path is not sealed.`);
  const absolutePath = resolve(bundleDirectory, expectedPath);
  if (!absolutePath.startsWith(`${resolve(bundleDirectory)}${sep}`)) {
    throw new Error(`${label} escapes the private bundle.`);
  }
  return absolutePath;
}

function verifyOfflinePngArtifact(bundleDirectory, artifact, expectedPath, label, raw, extraKeys = []) {
  exactKeys(
    artifact,
    raw
      ? ['contentSha256', 'sizeBytes', 'mimeType', 'pixcliAssetHash', 'providerRequestId', 'width', 'height', 'path']
      : ['contentSha256', 'sizeBytes', 'width', 'height', 'path', ...extraKeys],
    label,
  );
  requireString(artifact.contentSha256, `${label} SHA-256`, /^[a-f0-9]{64}$/);
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 24) {
    throw new Error(`${label} size is invalid.`);
  }
  if (!Number.isSafeInteger(artifact.width) || !Number.isSafeInteger(artifact.height)) {
    throw new Error(`${label} dimensions are invalid.`);
  }
  if (raw) {
    if (artifact.mimeType !== 'image/png') throw new Error(`${label} MIME type is not PNG.`);
    requireString(artifact.pixcliAssetHash, `${label} PixCLI hash`, /^[a-f0-9]{32}$/);
    if (artifact.providerRequestId !== null && artifact.providerRequestId !== undefined) {
      requireString(artifact.providerRequestId, `${label} provider request id`);
    }
  }
  const absolutePath = exactBundleArtifactPath(bundleDirectory, artifact, expectedPath, label);
  if (!existsSync(absolutePath)) throw new Error(`${label} PNG is missing.`);
  const inspected = inspectPng(readFileSync(absolutePath), label);
  for (const key of ['contentSha256', 'sizeBytes', 'width', 'height']) {
    if (artifact[key] !== inspected[key]) throw new Error(`${label} ${key} was tampered.`);
  }
  return { ...artifact, absolutePath };
}

function verifyOfflineAuditArtifact(bundleDirectory, artifact, expectedPath, label) {
  exactKeys(
    artifact,
    ['contentSha256', 'sizeBytes', 'mimeType', 'pixcliAssetHash', 'providerRequestId', 'path'],
    label,
  );
  requireString(artifact.contentSha256, `${label} SHA-256`, /^[a-f0-9]{64}$/);
  requireString(artifact.pixcliAssetHash, `${label} PixCLI hash`, /^[a-f0-9]{32}$/);
  if (artifact.mimeType !== 'application/json') throw new Error(`${label} MIME type is not JSON.`);
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 2 || artifact.sizeBytes > MAX_AUDIT_JSON_BYTES) {
    throw new Error(`${label} size is invalid.`);
  }
  if (artifact.providerRequestId !== null && artifact.providerRequestId !== undefined) {
    requireString(artifact.providerRequestId, `${label} provider request id`);
  }
  const absolutePath = exactBundleArtifactPath(bundleDirectory, artifact, expectedPath, label);
  if (!existsSync(absolutePath)) throw new Error(`${label} is missing.`);
  const bytes = readFileSync(absolutePath);
  if (bytes.byteLength !== artifact.sizeBytes || sha256(bytes) !== artifact.contentSha256) {
    throw new Error(`${label} bytes were tampered.`);
  }
  try {
    JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  return { ...artifact, absolutePath };
}

function selectedDescriptorSourceNames(descriptor) {
  const sourceNames = descriptor?.sourceNames === undefined
    ? [...XAI_CANONICAL_BUNDLE_SOURCE_NAMES]
    : descriptor.sourceNames;
  if (
    !Array.isArray(sourceNames)
    || ![1, XAI_CANONICAL_BUNDLE_SOURCE_NAMES.length].includes(sourceNames.length)
    || sourceNames.some((sourceName) => !XAI_CANONICAL_BUNDLE_SOURCE_NAMES.includes(sourceName))
    || new Set(sourceNames).size !== sourceNames.length
    || (
      sourceNames.length === XAI_CANONICAL_BUNDLE_SOURCE_NAMES.length
      && canonicalJson(sourceNames) !== canonicalJson(XAI_CANONICAL_BUNDLE_SOURCE_NAMES)
    )
  ) {
    throw new Error('Offline re-clean source selection is invalid.');
  }
  return sourceNames;
}

function isRecordedCleanupVersion(value) {
  return value === XAI_CANONICAL_BUNDLE_CLEANUP.ffmpegVersion
    || (typeof value === 'string'
      && value.startsWith(`ffmpeg version ${XAI_CANONICAL_BUNDLE_CLEANUP.ffmpegVersion} `));
}

function verifyOfflineRecleanInput(bundleDirectory, reviewedDescriptorSha256) {
  requireString(reviewedDescriptorSha256, 'explicit reviewed descriptor SHA-256', /^[a-f0-9]{64}$/);
  const descriptor = readSealedJson(join(bundleDirectory, 'review-descriptor.json'), 'review descriptor');
  const sourceNames = selectedDescriptorSourceNames(descriptor);
  exactKeys(descriptor, [
    'schemaVersion', 'descriptorType', 'bundleId', 'status', 'baseCommit', 'fighter',
    'poseManifest', ...(sourceNames.length === 1 ? ['sourceNames'] : []),
    'provider', 'cleanup', 'policy', 'sources', 'contactSheet', 'descriptorSha256',
  ], 'review descriptor');
  const { descriptorSha256, ...unsignedDescriptor } = descriptor;
  if (
    descriptor.schemaVersion !== 1
    || descriptor.descriptorType !== 'arcade_xai_canonical_bundle_review'
    || descriptor.status !== 'awaiting_human_review'
    || descriptor.baseCommit !== XAI_CANONICAL_BUNDLE_BASE_COMMIT
    || descriptorSha256 !== reviewedDescriptorSha256
    || descriptorSha256 !== sha256(canonicalJson(unsignedDescriptor))
  ) {
    throw new Error('Offline re-clean requires the exact sealed awaiting-review descriptor.');
  }
  exactKeys(descriptor.cleanup, ['ffmpegVersion', 'filter'], 'review descriptor cleanup');
  const recordedCleanup = canonicalJson(descriptor.cleanup);
  if (![XAI_CANONICAL_BUNDLE_LEGACY_CLEANUP, XAI_CANONICAL_BUNDLE_CLEANUP]
    .some((cleanup) => canonicalJson(cleanup) === recordedCleanup)) {
    throw new Error('Offline re-clean does not recognize the recorded cleanup contract.');
  }
  if (
    descriptor.provider?.modelId !== XAI_CANONICAL_BUNDLE_MODEL.id
    || descriptor.provider?.endpoint !== XAI_CANONICAL_BUNDLE_MODEL.endpoint
    || descriptor.provider?.provider !== XAI_CANONICAL_BUNDLE_MODEL.provider
    || descriptor.provider?.backend !== XAI_CANONICAL_BUNDLE_MODEL.backend
    || descriptor.provider?.paidCalls !== sourceNames.length
    || descriptor.provider?.actualCostUsd !== Number((sourceNames.length * 0.11).toFixed(2))
    || canonicalJson(descriptor.policy) !== canonicalJson(canonicalBundlePolicy(sourceNames))
  ) {
    throw new Error('Offline re-clean provider or zero-generation policy is not sealed.');
  }

  const state = readSealedJson(join(bundleDirectory, 'generation-state.json'), 'generation state');
  exactKeys(state, [
    'schemaVersion', 'bundleId', 'fighterSlug', 'fighterName', 'originalSha256', 'poseManifestId',
    'poseManifestSha256', 'matrixSha256', 'status', 'createdAt', 'updatedAt', 'policy', 'uploads',
    ...(sourceNames.length === 1 ? ['sourceNames'] : []),
    'slots', 'lastCatalogPreflight', 'descriptorSha256', 'contactSheetSha256',
  ], 'generation state');
  if (
    state.schemaVersion !== 1
    || state.status !== 'awaiting_human_review'
    || state.bundleId !== descriptor.bundleId
    || state.fighterSlug !== descriptor.fighter?.slug
    || state.fighterName !== descriptor.fighter?.name
    || state.originalSha256 !== descriptor.fighter?.originalSha256
    || state.poseManifestId !== descriptor.poseManifest?.id
    || state.poseManifestSha256 !== descriptor.poseManifest?.contentSha256
    || state.descriptorSha256 !== descriptorSha256
    || state.contactSheetSha256 !== descriptor.contactSheet?.contentSha256
    || canonicalJson(state.policy) !== canonicalJson(descriptor.policy)
    || canonicalJson(state.sourceNames) !== canonicalJson(descriptor.sourceNames)
  ) {
    throw new Error('Offline re-clean generation state does not match the reviewed descriptor.');
  }
  exactKeys(descriptor.sources, sourceNames, 'review descriptor sources');
  exactKeys(state.slots, sourceNames, 'generation state slots');

  const sources = {};
  for (const sourceName of sourceNames) {
    const source = descriptor.sources[sourceName];
    const slot = state.slots[sourceName];
    exactKeys(source, [
      'references', 'promptSha256', 'requestSha256', 'pixcliJobId', 'providerRequestId', 'raw', 'clean',
    ], `${sourceName} review source`);
    const providerRequestId = requireString(
      source.providerRequestId,
      `${sourceName} reviewed provider request id`,
    );
    const raw = verifyOfflinePngArtifact(
      bundleDirectory,
      source.raw,
      `sources/${sourceName}_raw.png`,
      `${sourceName} raw`,
      true,
    );
    const clean = verifyOfflinePngArtifact(
      bundleDirectory,
      source.clean,
      `sources/${sourceName}.png`,
      `${sourceName} clean`,
      false,
    );
    if (
      slot?.status !== 'completed'
      || slot.sourceName !== sourceName
      || slot.fighterSlug !== descriptor.fighter.slug
      || slot.originalSha256 !== descriptor.fighter.originalSha256
      || slot.promptSha256 !== source.promptSha256
      || slot.requestSha256 !== source.requestSha256
      || slot.pixcliJobId !== source.pixcliJobId
      || canonicalJson(slot.raw) !== canonicalJson(source.raw)
      || canonicalJson(slot.clean) !== canonicalJson(source.clean)
      || slot.audit?.providerRun?.requestId !== providerRequestId
      || slot.audit?.providerRun?.provider !== XAI_CANONICAL_BUNDLE_MODEL.backend
      || slot.audit?.providerRun?.modelId !== XAI_CANONICAL_BUNDLE_MODEL.id
      || slot.audit?.inputSha256 !== source.requestSha256
      || slot.audit?.costMicrocredits !== XAI_CANONICAL_BUNDLE_MODEL.auditedCostMicrocredits
      || slot.audit?.costUsd !== XAI_CANONICAL_BUNDLE_MODEL.auditedCostUsd
      || !isRecordedCleanupVersion(slot.cleanupFfmpegVersion)
      || (
        descriptor.cleanup.filter === XAI_CANONICAL_BUNDLE_CLEANUP.filter
        && slot.cleanupFilter !== XAI_CANONICAL_BUNDLE_CLEANUP.filter
      )
      || (raw.providerRequestId !== null && raw.providerRequestId !== providerRequestId)
    ) {
      throw new Error(`${sourceName} completed source is not sealed to the reviewed raw/audit lineage.`);
    }
    const providerRequest = verifyOfflineAuditArtifact(
      bundleDirectory,
      slot.audit.providerRequest,
      `audit/${sourceName}/provider_request.json`,
      `${sourceName} provider request audit`,
    );
    const providerResponse = verifyOfflineAuditArtifact(
      bundleDirectory,
      slot.audit.providerResponse,
      `audit/${sourceName}/provider_response.json`,
      `${sourceName} provider response audit`,
    );
    if (
      providerResponse.providerRequestId !== providerRequestId
      || (providerRequest.providerRequestId !== null && providerRequest.providerRequestId !== providerRequestId)
    ) {
      throw new Error(`${sourceName} JSON audit lineage does not match the reviewed provider run.`);
    }
    sources[sourceName] = { source, slot, raw, clean, providerRequest, providerResponse };
  }

  exactKeys(
    descriptor.contactSheet,
    ['path', 'contentSha256', 'sizeBytes', 'width', 'height', 'layout'],
    'contact sheet',
  );
  const contact = verifyOfflinePngArtifact(
    bundleDirectory,
    descriptor.contactSheet,
    'contact-sheet.png',
    'contact sheet',
    false,
    ['layout'],
  );
  const expectedLayout = sourceNames.length === 1
    ? [`${sourceNames[0]}_raw`, `${sourceNames[0]}_clean`]
    : ['side_raw', 'upright_raw', 'crouch_raw', 'side_clean', 'upright_clean', 'crouch_clean'];
  const expectedContactSize = sourceNames.length === 1
    ? { width: 768, height: 512 }
    : { width: 1152, height: 1024 };
  if (
    canonicalJson(contact.layout) !== canonicalJson(expectedLayout)
    || contact.width !== expectedContactSize.width
    || contact.height !== expectedContactSize.height
  ) {
    throw new Error('Offline re-clean contact-sheet contract changed.');
  }
  return { descriptor, state, sourceNames, sources };
}

function copyPrivateArtifact(sourcePath, destinationPath) {
  mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
  copyFileSync(sourcePath, destinationPath);
  chmodSync(destinationPath, 0o600);
}

function portablePngArtifact(artifact, path) {
  return {
    width: artifact.width,
    height: artifact.height,
    sizeBytes: artifact.sizeBytes,
    contentSha256: artifact.contentSha256,
    path,
  };
}

function isNestedPath(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function recleanXaiCanonicalBundle(options = {}) {
  if (options.confirmation !== XAI_CANONICAL_BUNDLE_RECLEAN_CONFIRMATION) {
    throw new Error(`Offline re-clean requires confirmation ${XAI_CANONICAL_BUNDLE_RECLEAN_CONFIRMATION}.`);
  }
  if (!isAbsolute(options.bundleDirectory ?? '') || !isAbsolute(options.outputDirectory ?? '')) {
    throw new Error('Offline re-clean requires explicit absolute input and output directories.');
  }
  const bundleDirectory = realpathSync(options.bundleDirectory);
  const outputDirectory = resolve(options.outputDirectory);
  if (
    isNestedPath(bundleDirectory, outputDirectory)
    || isNestedPath(outputDirectory, bundleDirectory)
  ) {
    throw new Error('Offline re-clean output must be a distinct non-overlapping directory.');
  }
  if (existsSync(outputDirectory)) throw new Error('Offline re-clean output already exists.');
  const locks = acquireExclusiveBundleLocks(`${outputDirectory}.offline-reclean`, outputDirectory);
  try {
    const reviewed = verifyOfflineRecleanInput(
      bundleDirectory,
      options.reviewedDescriptorSha256,
    );
    const cleanupFfmpegVersion = verifyCanonicalCleanupToolchain(options);
    const stagingDirectory = `${outputDirectory}.writing-${randomUUID()}`;
    if (existsSync(stagingDirectory)) throw new Error('Offline re-clean staging directory already exists.');
    mkdirSync(stagingDirectory, { recursive: false, mode: 0o700 });

    const artifacts = {};
    const nextSources = {};
    const nextSlots = {};
    for (const sourceName of reviewed.sourceNames) {
      const entry = reviewed.sources[sourceName];
      const rawPath = join(stagingDirectory, 'sources', `${sourceName}_raw.png`);
      copyPrivateArtifact(entry.raw.absolutePath, rawPath);
      copyPrivateArtifact(
        entry.providerRequest.absolutePath,
        join(stagingDirectory, 'audit', sourceName, 'provider_request.json'),
      );
      copyPrivateArtifact(
        entry.providerResponse.absolutePath,
        join(stagingDirectory, 'audit', sourceName, 'provider_response.json'),
      );
      const cleanPath = join(stagingDirectory, 'sources', `${sourceName}.png`);
      const clean = runCanonicalCleanup(rawPath, cleanPath, options);
      const providerRequestId = entry.source.providerRequestId;
      const raw = {
        ...entry.source.raw,
        providerRequestId,
      };
      const portableClean = portablePngArtifact(clean, `sources/${sourceName}.png`);
      nextSources[sourceName] = {
        ...entry.source,
        providerRequestId,
        raw,
        clean: portableClean,
      };
      nextSlots[sourceName] = {
        ...entry.slot,
        raw,
        clean: portableClean,
        cleanupFfmpegVersion,
        cleanupFilter: XAI_CANONICAL_BUNDLE_CLEANUP.filter,
        updatedAt: nowIso(),
      };
      artifacts[sourceName] = {
        raw: { ...raw, absolutePath: rawPath },
        clean: { ...portableClean, absolutePath: cleanPath },
      };
    }

    const contactSheet = createContactSheet(
      artifacts,
      reviewed.sourceNames,
      join(stagingDirectory, 'contact-sheet.png'),
      options,
    );
    const { descriptorSha256: _oldDescriptorSha256, ...oldUnsignedDescriptor } = reviewed.descriptor;
    const unsignedDescriptor = {
      ...oldUnsignedDescriptor,
      cleanup: { ...XAI_CANONICAL_BUNDLE_CLEANUP },
      sources: nextSources,
      contactSheet: {
        ...reviewed.descriptor.contactSheet,
        contentSha256: contactSheet.contentSha256,
        sizeBytes: contactSheet.sizeBytes,
        width: contactSheet.width,
        height: contactSheet.height,
      },
    };
    const descriptor = {
      ...unsignedDescriptor,
      descriptorSha256: sha256(canonicalJson(unsignedDescriptor)),
    };
    const state = {
      ...reviewed.state,
      status: 'awaiting_human_review',
      slots: nextSlots,
      descriptorSha256: descriptor.descriptorSha256,
      contactSheetSha256: contactSheet.contentSha256,
      updatedAt: nowIso(),
    };
    writeJsonAtomic(join(stagingDirectory, 'review-descriptor.json'), descriptor);
    writeJsonAtomic(join(stagingDirectory, 'generation-state.json'), state);
    verifyOfflineRecleanInput(stagingDirectory, descriptor.descriptorSha256);
    renameSync(stagingDirectory, outputDirectory);
    chmodSync(outputDirectory, 0o700);
    return { bundleDirectory, outputDirectory, descriptor, state, sourceNames: reviewed.sourceNames };
  } finally {
    releaseExclusiveBundleLocks(locks);
  }
}

function parseArg(rawArgs, name, fallback = '') {
  return rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

export function parseXaiCanonicalBundleCliArgs(rawArgs, environment = process.env) {
  if (!rawArgs.includes('--execute')) throw new Error('Paid execution requires --execute.');
  const slug = parseArg(rawArgs, '--slug');
  const sourceName = parseArg(rawArgs, '--source');
  const requestVersion = parseArg(rawArgs, '--request-version');
  const stateStem = sourceName
    ? resolveXaiCanonicalSingleSourceRequest(slug, sourceName, requestVersion).stateStem
    : slug;
  return {
    confirmation: parseArg(rawArgs, '--confirm'),
    privateConfirmation: parseArg(rawArgs, '--confirm-private'),
    maxCostUsd: parseArg(rawArgs, '--max-cost-usd'),
    slug,
    sourceName,
    requestVersion,
    promptSha256: parseArg(rawArgs, '--prompt-sha256'),
    apiKey: environment.PIXCLI_API_KEY,
    apiBase: environment.PIXCLI_BASE_URL,
    manifestPath: parseArg(rawArgs, '--manifest', DEFAULT_MANIFEST_PATH),
    sourceDir: parseArg(rawArgs, '--source-dir', DEFAULT_SOURCE_DIR),
    poseManifestPath: parseArg(rawArgs, '--pose-manifest'),
    poseManifestSha256: parseArg(rawArgs, '--pose-manifest-sha256'),
    statePath: parseArg(rawArgs, '--state', join(DEFAULT_STATE_ROOT, `${stateStem}.json`)),
    outputDirectory: parseArg(rawArgs, '--output-dir', join(DEFAULT_OUTPUT_ROOT, stateStem)),
  };
}

async function main() {
  const result = await runXaiCanonicalBundle(parseXaiCanonicalBundleCliArgs(process.argv.slice(2)));
  console.log(`Canonical bundle ${result.state.bundleId} is awaiting human review.`);
  console.log(`Review descriptor: ${join(result.outputDirectory, 'review-descriptor.json')}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
