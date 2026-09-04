import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPingPongPlayback,
  buildXaiHighKickVideoPayload,
  buildXaiHighKickVideoPlan,
  runXaiHighKickVideoCanary,
} from './arcade-high-kick-xai-video-canary.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CANONICAL_PATH = join(
  root,
  '.artifacts/arcade-high-kick-xai-video-elon-v1/inputs/elon-musk-side-right-overscan-8bit.png',
);
const DEFAULT_CANONICAL_UPLOAD_STATE_PATH = join(
  root,
  '.arcade-xai-elon-video-canonical-upload-state.json',
);
const DEFAULT_OUTPUT_DIR = join(root, '.artifacts/arcade-high-kick-xai-video-elon-canary');
const DEFAULT_STATE_PATH = join(root, '.arcade-high-kick-xai-video-elon-canary-state.json');

export const XAI_ELON_HIGH_KICK_VIDEO_EXPERIMENT_ID = 'arcade-high-kick-xai-video-elon-v1';
export const XAI_ELON_HIGH_KICK_VIDEO_CONFIRMATION = 'ARCADE_HIGH_KICK_XAI_VIDEO_ELON_V1';
export const XAI_ELON_HIGH_KICK_VIDEO_CANONICAL = Object.freeze({
  id: 'elon-musk-side-right-overscan-v1',
  slug: 'canonical-elon-musk-side-right-overscan-v1',
  contentSha256: 'f8ee4034fab30358ecb898411b39a5cb9777993c75f43bd0bf4e80e281b6e469',
});
export const XAI_ELON_HIGH_KICK_VIDEO_SAMPLE_FPS = 24;
export const XAI_ELON_HIGH_KICK_VIDEO_UNIQUE_FRAMES = 12;
export const XAI_ELON_HIGH_KICK_VIDEO_PLAYBACK = Object.freeze(
  buildPingPongPlayback(XAI_ELON_HIGH_KICK_VIDEO_UNIQUE_FRAMES),
);

function parseArg(rawArgs, name, fallback = '') {
  return rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

export function buildXaiElonHighKickVideoPrompt() {
  return [
    'Create one continuous two-second fighting-game animation from IMAGE 1, the approved character, identity, costume, scale, and composition master.',
    'This clip is frame material for a HIGH_KICK sprite, not a cinematic shot.',
    'SCREEN-SPACE DIRECTION — HARD CONSTRAINT: the entire attack must read LEFT-TO-RIGHT across the image.',
    'Preserve the exact right-facing three-quarter side orientation in IMAGE 1: his face, nose, chest, hips, knees, and feet stay aimed toward the RIGHT EDGE OF THE IMAGE, his back stays toward the left edge, and his body never turns toward the camera or reverses toward screen-left.',
    'Keep the fighter anchored at the same lower-left position and at the exact same small full-body scale as IMAGE 1, preserving the large empty green strike space above and to his right. Never recenter or enlarge him.',
    'Start in the exact supplied ready stance, then progress monotonically through wind-up, a compact knee chamber, and extension of one high kick into the empty right half of the image.',
    'The kicking foot must travel left-to-right, reach a fully extended high-kick impact near 1.7 seconds, and hold that strongest impact pose through the final frame. Do not retract the kick or return to idle.',
    'Keep the support foot planted on one floor line and keep the torso balance physically plausible. Both hands remain in a compact guard with no pointing, punching, waving, or arm flourish.',
    'Preserve the exact same recognizable face, age, brown swept hair, grey futuristic jacket with blue piping, black trousers, black boots, body proportions, fabric texture, material finish, lighting, and camera perspective from IMAGE 1.',
    'Exactly one connected adult fighter throughout. Do not introduce or duplicate limbs, hands, feet, heads, people, props, trails, afterimages, or detached anatomy. Preserve natural occlusions.',
    'Fixed locked camera, complete body always visible with wide margin, no crop, no zoom, no pan, no cut, no camera shake, and no change of scale or perspective.',
    'Perfectly flat uniform pure #00FF00 background throughout, with no floor, shadow, grid, text, scenery, particles, motion blur, or camera effects.',
  ].join(' ');
}

export function buildXaiElonHighKickVideoPlan() {
  return buildXaiHighKickVideoPlan({
    experimentId: XAI_ELON_HIGH_KICK_VIDEO_EXPERIMENT_ID,
    fighter: 'elon-musk',
    action: 'high_kick',
    canonical: XAI_ELON_HIGH_KICK_VIDEO_CANONICAL,
    prompt: buildXaiElonHighKickVideoPrompt(),
    sampleFps: XAI_ELON_HIGH_KICK_VIDEO_SAMPLE_FPS,
    uniqueFrames: XAI_ELON_HIGH_KICK_VIDEO_UNIQUE_FRAMES,
    playback: XAI_ELON_HIGH_KICK_VIDEO_PLAYBACK,
  });
}

export function buildXaiElonHighKickVideoPayload(assetHash) {
  return buildXaiHighKickVideoPayload(assetHash, {
    prompt: buildXaiElonHighKickVideoPrompt(),
    publishName: 'ip-elon-musk-high-kick-xai-video-v1',
  });
}

export async function runXaiElonHighKickVideoCanary(options = {}) {
  return runXaiHighKickVideoCanary({
    ...options,
    experimentId: XAI_ELON_HIGH_KICK_VIDEO_EXPERIMENT_ID,
    fighter: 'elon-musk',
    action: 'high_kick',
    canonical: XAI_ELON_HIGH_KICK_VIDEO_CANONICAL,
    canonicalPath: options.canonicalPath ?? DEFAULT_CANONICAL_PATH,
    canonicalUploadStatePath:
      options.canonicalUploadStatePath ?? DEFAULT_CANONICAL_UPLOAD_STATE_PATH,
    statePath: options.statePath ?? DEFAULT_STATE_PATH,
    outputDir: options.outputDir ?? DEFAULT_OUTPUT_DIR,
    artifactStem: 'elon-musk--high-kick',
    publishName: 'ip-elon-musk-high-kick-xai-video-v1',
    prompt: buildXaiElonHighKickVideoPrompt(),
    sampleFps: XAI_ELON_HIGH_KICK_VIDEO_SAMPLE_FPS,
    uniqueFrames: XAI_ELON_HIGH_KICK_VIDEO_UNIQUE_FRAMES,
    playback: XAI_ELON_HIGH_KICK_VIDEO_PLAYBACK,
  });
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (!rawArgs.includes('--execute')) {
    console.log(JSON.stringify(buildXaiElonHighKickVideoPlan(), null, 2));
    return;
  }
  const confirmation = parseArg(rawArgs, '--confirm');
  if (confirmation !== XAI_ELON_HIGH_KICK_VIDEO_CONFIRMATION) {
    throw new Error(
      `Paid execution requires --confirm=${XAI_ELON_HIGH_KICK_VIDEO_CONFIRMATION}.`,
    );
  }
  const state = await runXaiElonHighKickVideoCanary({
    apiKey: process.env.PIXCLI_API_KEY,
    apiBase: process.env.PIXCLI_BASE_URL,
    canonicalPath: parseArg(rawArgs, '--canonical', DEFAULT_CANONICAL_PATH),
    canonicalUploadStatePath: parseArg(
      rawArgs,
      '--canonical-upload-state',
      DEFAULT_CANONICAL_UPLOAD_STATE_PATH,
    ),
    statePath: parseArg(rawArgs, '--state', DEFAULT_STATE_PATH),
    outputDir: parseArg(rawArgs, '--output-dir', DEFAULT_OUTPUT_DIR),
    ffmpegBin: parseArg(rawArgs, '--ffmpeg', 'ffmpeg'),
    ffprobeBin: parseArg(rawArgs, '--ffprobe', 'ffprobe'),
  });
  console.log(`XAI ELON HIGH_KICK video canary terminal: ${state.status}.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
