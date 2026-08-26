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
  '.artifacts/arcade-side-xai-trump-profile-canary/arcade-side-xai-trump-profile-v4/donald-trump--grok-imagine-image-2-edit--image.png',
);
const DEFAULT_CANONICAL_UPLOAD_STATE_PATH = join(
  root,
  '.arcade-xai-trump-profile-v4-video-v2-canonical-upload-state.json',
);
const DEFAULT_OUTPUT_DIR = join(
  root,
  '.artifacts/arcade-high-kick-xai-video-trump-v2-canary',
);
const DEFAULT_STATE_PATH = join(
  root,
  '.arcade-high-kick-xai-video-trump-v2-canary-state.json',
);

export const XAI_TRUMP_HIGH_KICK_VIDEO_EXPERIMENT_ID =
  'arcade-high-kick-xai-video-trump-v2';
export const XAI_TRUMP_HIGH_KICK_VIDEO_CONFIRMATION =
  'ARCADE_HIGH_KICK_XAI_VIDEO_TRUMP_V2';
export const XAI_TRUMP_HIGH_KICK_VIDEO_PUBLISH_NAME =
  'ip-trump-high-kick-xai-video-v2';
export const XAI_TRUMP_HIGH_KICK_VIDEO_CANONICAL = Object.freeze({
  id: 'xai-trump-side-profile-v4',
  slug: 'canonical-trump-xai-side-profile-v4',
  contentSha256: 'fb0ab93907e853cf7cfe00378d10a612d3271a2d98f6f04ad15fda9acacd85bd',
});
export const XAI_TRUMP_HIGH_KICK_VIDEO_SAMPLE_FPS = 24;
export const XAI_TRUMP_HIGH_KICK_VIDEO_UNIQUE_FRAMES = 12;
export const XAI_TRUMP_HIGH_KICK_VIDEO_PLAYBACK = Object.freeze(
  buildPingPongPlayback(XAI_TRUMP_HIGH_KICK_VIDEO_UNIQUE_FRAMES),
);
export const XAI_TRUMP_HIGH_KICK_VIDEO_PATHS = Object.freeze({
  canonical: DEFAULT_CANONICAL_PATH,
  canonicalUploadState: DEFAULT_CANONICAL_UPLOAD_STATE_PATH,
  outputDir: DEFAULT_OUTPUT_DIR,
  state: DEFAULT_STATE_PATH,
});

function parseArg(rawArgs, name, fallback = '') {
  return rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

export function buildXaiTrumpHighKickVideoPrompt() {
  return [
    'Create one continuous two-second fighting-game animation from IMAGE 1, the approved Donald Trump identity, costume, scale, composition, and rendering master.',
    'This clip is frame material for a HIGH_KICK sprite, not a cinematic shot.',
    'SCREEN-SPACE DIRECTION — HARD CONSTRAINT: the entire attack must read LEFT-TO-RIGHT across the image and the kicking foot must extend toward the RIGHT EDGE OF THE IMAGE.',
    'Preserve the currently accepted right-facing head-and-body orientation from IMAGE 1 exactly as supplied. Keep his face, nose, chest, hips, knees, and feet aimed toward the right edge in that same accepted relationship. Do not correct, square, reinterpret, or reverse this orientation.',
    'NO YAW — HARD CONSTRAINT: neither the head nor the torso may yaw toward the camera, away from the camera, or toward screen-left at any point.',
    'Keep the fighter registered at the exact same lower-left position and the exact same small full-body scale as IMAGE 1, preserving the generous empty green attack space above and to his right. Never recenter, enlarge, shrink, or translate him.',
    'NO ROOT DRIFT — HARD CONSTRAINT: keep the support foot planted on one fixed floor point and keep the character root registered to the same game-space origin throughout; the body may articulate for balance but may not slide, hop, rise across the frame, or drift horizontally or vertically.',
    'Start in the exact supplied ready stance, then progress monotonically through wind-up, a compact knee chamber, and extension of one high kick into the empty right half of the image.',
    'Reach the strongest fully extended high-kick impact near 1.7 seconds and hold that peak pose through the final frame. Do not retract the kick or return to idle.',
    'Both hands remain in the same compact fighting guard throughout, with no pointing, punching, waving, reaching, arm flourish, or dropped guard.',
    'Preserve the exact same recognizable Donald Trump face, age, swept blond hair, navy suit, white shirt, red tie, black shoes, solid natural body build, proportions, fabric texture, material finish, lighting, and camera perspective from IMAGE 1.',
    'Exactly one connected adult fighter throughout. Do not introduce or duplicate limbs, hands, feet, heads, people, props, trails, afterimages, or detached anatomy. Preserve natural occlusions.',
    'FIXED CAMERA — HARD CONSTRAINT: lock the camera and framing for the entire clip, with the complete body always visible and the original margins unchanged. No crop, zoom, pan, tilt, roll, reframe, cut, shake, parallax, perspective change, or camera drift.',
    'Perfectly flat uniform pure #00FF00 background throughout, with no floor, shadow, gradient, grid, text, scenery, particles, motion blur, or camera effects.',
  ].join(' ');
}

export function buildXaiTrumpHighKickVideoPlan() {
  return buildXaiHighKickVideoPlan({
    experimentId: XAI_TRUMP_HIGH_KICK_VIDEO_EXPERIMENT_ID,
    fighter: 'donald-trump',
    action: 'high_kick',
    canonical: XAI_TRUMP_HIGH_KICK_VIDEO_CANONICAL,
    prompt: buildXaiTrumpHighKickVideoPrompt(),
    sampleFps: XAI_TRUMP_HIGH_KICK_VIDEO_SAMPLE_FPS,
    uniqueFrames: XAI_TRUMP_HIGH_KICK_VIDEO_UNIQUE_FRAMES,
    playback: XAI_TRUMP_HIGH_KICK_VIDEO_PLAYBACK,
  });
}

export function buildXaiTrumpHighKickVideoPayload(assetHash) {
  return buildXaiHighKickVideoPayload(assetHash, {
    prompt: buildXaiTrumpHighKickVideoPrompt(),
    publishName: XAI_TRUMP_HIGH_KICK_VIDEO_PUBLISH_NAME,
  });
}

export async function runXaiTrumpHighKickVideoCanary(options = {}) {
  return runXaiHighKickVideoCanary({
    ...options,
    experimentId: XAI_TRUMP_HIGH_KICK_VIDEO_EXPERIMENT_ID,
    fighter: 'donald-trump',
    action: 'high_kick',
    canonical: XAI_TRUMP_HIGH_KICK_VIDEO_CANONICAL,
    canonicalPath: options.canonicalPath ?? DEFAULT_CANONICAL_PATH,
    canonicalUploadStatePath:
      options.canonicalUploadStatePath ?? DEFAULT_CANONICAL_UPLOAD_STATE_PATH,
    statePath: options.statePath ?? DEFAULT_STATE_PATH,
    outputDir: options.outputDir ?? DEFAULT_OUTPUT_DIR,
    artifactStem: 'donald-trump--high-kick-v2',
    publishName: XAI_TRUMP_HIGH_KICK_VIDEO_PUBLISH_NAME,
    prompt: buildXaiTrumpHighKickVideoPrompt(),
    sampleFps: XAI_TRUMP_HIGH_KICK_VIDEO_SAMPLE_FPS,
    uniqueFrames: XAI_TRUMP_HIGH_KICK_VIDEO_UNIQUE_FRAMES,
    playback: XAI_TRUMP_HIGH_KICK_VIDEO_PLAYBACK,
  });
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (!rawArgs.includes('--execute')) {
    console.log(JSON.stringify(buildXaiTrumpHighKickVideoPlan(), null, 2));
    return;
  }
  const confirmation = parseArg(rawArgs, '--confirm');
  if (confirmation !== XAI_TRUMP_HIGH_KICK_VIDEO_CONFIRMATION) {
    throw new Error(
      `Paid execution requires --confirm=${XAI_TRUMP_HIGH_KICK_VIDEO_CONFIRMATION}.`,
    );
  }
  const state = await runXaiTrumpHighKickVideoCanary({
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
  console.log(`XAI TRUMP HIGH_KICK video canary terminal: ${state.status}.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
