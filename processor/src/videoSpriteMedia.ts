import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  VIDEO_SPRITE_FRAME_HEIGHT,
  VIDEO_SPRITE_FRAME_WIDTH,
  VIDEO_SPRITE_RAW_FRAME_HEIGHT,
  VIDEO_SPRITE_RAW_FRAME_WIDTH,
  VIDEO_SPRITE_SAMPLE_FPS,
  VideoSpriteCompileError,
} from './videoSpriteContract.ts';

const COMMAND_OUTPUT_LIMIT = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 45_000;
const MAX_DECODED_FRAMES = 144;
const ALLOWED_VIDEO_CODECS = new Set(['h264', 'hevc', 'mpeg4', 'vp9', 'av1']);

export const VIDEO_SPRITE_NORMALIZE_FILTER = [
  'chromakey=0x00FF00:0.20:0.08',
  'format=rgba',
  `scale=${VIDEO_SPRITE_FRAME_WIDTH}:${VIDEO_SPRITE_FRAME_HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos`,
  `pad=${VIDEO_SPRITE_FRAME_WIDTH}:${VIDEO_SPRITE_FRAME_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
].join(',');

export interface VideoSpriteProbe {
  codecName: string;
  pixelFormat: string | null;
  width: number;
  height: number;
  sourceFps: number;
  durationMs: number;
  declaredFrameCount: number | null;
  sizeBytes: number;
}

export interface VideoSpriteMediaToolchain {
  ffmpegVersion: string;
  ffprobeVersion: string;
  sampleFps: number;
  normalizeFilter: string;
}

export interface VideoSpriteExtractedMedia {
  probe: VideoSpriteProbe;
  toolchain: VideoSpriteMediaToolchain;
  canonicalPng: Buffer;
  videoFramePngs: Buffer[];
  extractArchival(selectedVideoIndices: number[]): Promise<{
    canonicalPng: Buffer;
    selectedVideoFramePngs: Buffer[];
  }>;
}

export interface VideoSpriteMediaAdapter {
  extract(videoBytes: Buffer, canonicalBytes: Buffer): Promise<VideoSpriteExtractedMedia>;
}

export interface MediaCommandResult {
  stdout: string;
  stderr: string;
}

export type MediaCommandRunner = (binary: string, args: string[]) => Promise<MediaCommandResult>;

function commandError(binary: string, detail: string, unavailable = false): VideoSpriteCompileError {
  return new VideoSpriteCompileError(
    unavailable ? 'media_tool_unavailable' : 'media_command_failed',
    `${basename(binary)} ${detail}`,
    unavailable ? 503 : 422,
  );
}

export const runMediaCommand: MediaCommandRunner = (binary, args) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let settled = false;
  const finish = (error?: Error, result?: MediaCommandResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) reject(error);
    else resolve(result ?? { stdout: '', stderr: '' });
  };
  const collect = (target: Buffer[], chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    outputBytes += bytes.byteLength;
    if (outputBytes > COMMAND_OUTPUT_LIMIT) {
      child.kill('SIGKILL');
      finish(commandError(binary, 'exceeded the diagnostic output limit.'));
      return;
    }
    target.push(bytes);
  };
  child.stdout.on('data', (chunk) => collect(stdout, chunk));
  child.stderr.on('data', (chunk) => collect(stderr, chunk));
  child.once('error', (error: NodeJS.ErrnoException) => {
    finish(commandError(binary, error.code === 'ENOENT' ? 'is unavailable.' : `failed to start: ${error.message}`, error.code === 'ENOENT'));
  });
  child.once('close', (code) => {
    const result = {
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    };
    if (code !== 0) {
      finish(commandError(binary, `failed (${code ?? 'signal'}): ${result.stderr.trim().slice(-1200)}`));
      return;
    }
    finish(undefined, result);
  });
  const timeout = setTimeout(() => {
    child.kill('SIGKILL');
    finish(commandError(binary, `timed out after ${COMMAND_TIMEOUT_MS}ms.`));
  }, COMMAND_TIMEOUT_MS);
});

function parseRate(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const [numeratorRaw, denominatorRaw = '1'] = value.split('/');
  const numerator = Number(numeratorRaw);
  const denominator = Number(denominatorRaw);
  return denominator > 0 ? numerator / denominator : Number.NaN;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseVideoSpriteProbe(value: unknown, expectedSizeBytes: number): VideoSpriteProbe {
  if (!value || typeof value !== 'object') {
    throw new VideoSpriteCompileError('invalid_video_probe', 'ffprobe returned an invalid document.');
  }
  const document = value as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const stream = document.streams?.[0];
  const width = positiveInteger(stream?.width);
  const height = positiveInteger(stream?.height);
  const codecName = typeof stream?.codec_name === 'string' ? stream.codec_name : '';
  const durationSeconds = Number(document.format?.duration);
  const sourceFps = parseRate(stream?.avg_frame_rate ?? stream?.r_frame_rate);
  const declaredFrameCount = positiveInteger(stream?.nb_frames);
  const reportedSize = positiveInteger(document.format?.size);
  if (!width || !height || !ALLOWED_VIDEO_CODECS.has(codecName)) {
    throw new VideoSpriteCompileError('unsupported_video', 'Video must contain one supported software-decodable video stream.');
  }
  if (width < 64 || height < 64 || width > 4096 || height > 4096) {
    throw new VideoSpriteCompileError('unsupported_video_dimensions', 'Video dimensions must be between 64 and 4096 pixels.');
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0.2 || durationSeconds > 8) {
    throw new VideoSpriteCompileError('unsupported_video_duration', 'Video duration must be between 0.2 and 8 seconds.');
  }
  if (!Number.isFinite(sourceFps) || sourceFps <= 0 || sourceFps > 120) {
    throw new VideoSpriteCompileError('unsupported_video_fps', 'Video frame rate must be in (0, 120].');
  }
  if (Math.ceil(durationSeconds * VIDEO_SPRITE_SAMPLE_FPS) > MAX_DECODED_FRAMES) {
    throw new VideoSpriteCompileError('too_many_decoded_frames', 'Video exceeds the bounded decoded-frame budget.');
  }
  if (reportedSize !== null && Math.abs(reportedSize - expectedSizeBytes) > 16) {
    throw new VideoSpriteCompileError('video_size_mismatch', 'ffprobe size does not match the submitted video bytes.');
  }
  return {
    codecName,
    pixelFormat: typeof stream?.pix_fmt === 'string' ? stream.pix_fmt : null,
    width,
    height,
    sourceFps: Number(sourceFps.toFixed(6)),
    durationMs: Math.round(durationSeconds * 1000),
    declaredFrameCount,
    sizeBytes: expectedSizeBytes,
  };
}

async function mediaVersion(run: MediaCommandRunner, binary: string): Promise<string> {
  const result = await run(binary, ['-version']);
  const firstLine = result.stdout.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) throw commandError(binary, 'returned no version.');
  return firstLine.slice(0, 240);
}

function requireApprovedMediaVersion(binary: 'ffmpeg' | 'ffprobe', actual: string): void {
  const approved = process.env.VIDEO_SPRITE_APPROVED_FFMPEG_VERSION?.trim();
  if (!approved) return;
  if (!actual.startsWith(`${binary} version ${approved} `)) {
    throw new VideoSpriteCompileError(
      'unapproved_media_toolchain',
      `${binary} does not match the processing-version-5 approved toolchain.`,
      503,
    );
  }
}

function normalizedStillArgs(input: string, output: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-threads', '1', '-filter_threads', '1', '-i', input,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', VIDEO_SPRITE_NORMALIZE_FILTER,
    '-frames:v', '1', '-compression_level', '9', output,
  ];
}

const VIDEO_SPRITE_ARCHIVAL_FILTER = [
  'chromakey=0x00FF00:0.20:0.08',
  'format=rgba',
  `scale=${VIDEO_SPRITE_RAW_FRAME_WIDTH}:${VIDEO_SPRITE_RAW_FRAME_HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos`,
  `pad=${VIDEO_SPRITE_RAW_FRAME_WIDTH}:${VIDEO_SPRITE_RAW_FRAME_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
].join(',');

function archivalStillArgs(input: string, output: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-threads', '1', '-filter_threads', '1', '-i', input,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', VIDEO_SPRITE_ARCHIVAL_FILTER,
    '-frames:v', '1', '-compression_level', '9', output,
  ];
}

function selectedFrameFilter(indices: number[]): string {
  const expression = indices.map((index) => `eq(n\\,${index})`).join('+');
  return `fps=${VIDEO_SPRITE_SAMPLE_FPS},select=${expression},${VIDEO_SPRITE_ARCHIVAL_FILTER}`;
}

export function createFfmpegVideoSpriteMediaAdapter(options: {
  ffmpegBinary?: string;
  ffprobeBinary?: string;
  runCommand?: MediaCommandRunner;
} = {}): VideoSpriteMediaAdapter {
  const ffmpegBinary = options.ffmpegBinary ?? 'ffmpeg';
  const ffprobeBinary = options.ffprobeBinary ?? 'ffprobe';
  const run = options.runCommand ?? runMediaCommand;
  return {
    async extract(videoBytes, canonicalBytes) {
      const workDir = await mkdtemp(join(tmpdir(), 'insert-player-video-sprite-'));
      try {
        const videoPath = join(workDir, 'input.mp4');
        const canonicalInputPath = join(workDir, 'canonical-input');
        const canonicalOutputPath = join(workDir, 'canonical.png');
        const rawDir = join(workDir, 'frames');
        await mkdir(rawDir, { mode: 0o700 });
        await Promise.all([
          writeFile(videoPath, videoBytes, { mode: 0o600 }),
          writeFile(canonicalInputPath, canonicalBytes, { mode: 0o600 }),
        ]);
        const [ffmpegVersion, ffprobeVersion, probeResult] = await Promise.all([
          mediaVersion(run, ffmpegBinary),
          mediaVersion(run, ffprobeBinary),
          run(ffprobeBinary, [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate,nb_frames:format=duration,size',
            '-of', 'json', videoPath,
          ]),
        ]);
        requireApprovedMediaVersion('ffmpeg', ffmpegVersion);
        requireApprovedMediaVersion('ffprobe', ffprobeVersion);
        let probeDocument: unknown;
        try {
          probeDocument = JSON.parse(probeResult.stdout);
        } catch {
          throw new VideoSpriteCompileError('invalid_video_probe', 'ffprobe did not return valid JSON.');
        }
        const probe = parseVideoSpriteProbe(probeDocument, videoBytes.byteLength);
        await run(ffmpegBinary, normalizedStillArgs(canonicalInputPath, canonicalOutputPath));
        await run(ffmpegBinary, [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          '-threads', '1', '-filter_threads', '1', '-i', videoPath,
          '-map', '0:v:0', '-an', '-sn', '-dn',
          '-vf', `fps=${VIDEO_SPRITE_SAMPLE_FPS},${VIDEO_SPRITE_NORMALIZE_FILTER}`,
          '-frames:v', String(MAX_DECODED_FRAMES),
          '-fps_mode', 'vfr', '-compression_level', '9',
          join(rawDir, 'frame-%04d.png'),
        ]);
        const frameNames = (await readdir(rawDir))
          .filter((name) => /^frame-\d{4}\.png$/.test(name))
          .sort();
        if (frameNames.length === 0 || frameNames.length > MAX_DECODED_FRAMES) {
          throw new VideoSpriteCompileError('invalid_decoded_frame_count', 'FFmpeg produced an invalid frame count.');
        }
        const [canonicalPng, ...videoFramePngs] = await Promise.all([
          readFile(canonicalOutputPath),
          ...frameNames.map((name) => readFile(join(rawDir, name))),
        ]);
        return {
          probe,
          toolchain: {
            ffmpegVersion,
            ffprobeVersion,
            sampleFps: VIDEO_SPRITE_SAMPLE_FPS,
            normalizeFilter: VIDEO_SPRITE_NORMALIZE_FILTER,
          },
          canonicalPng,
          videoFramePngs,
          async extractArchival(selectedVideoIndices) {
            if (
              selectedVideoIndices.length === 0 ||
              selectedVideoIndices.some((index, position) => (
                !Number.isSafeInteger(index) || index < 0 || index >= frameNames.length ||
                (position > 0 && index <= selectedVideoIndices[position - 1])
              ))
            ) {
              throw new VideoSpriteCompileError(
                'invalid_archival_selection',
                'Archival frame indices must be strictly increasing decoded-frame indices.',
              );
            }
            const archivalDir = await mkdtemp(join(tmpdir(), 'insert-player-video-sprite-raw-'));
            try {
              const archivalVideoPath = join(archivalDir, 'input.mp4');
              const archivalCanonicalInputPath = join(archivalDir, 'canonical-input');
              const archivalCanonicalOutputPath = join(archivalDir, 'canonical.png');
              const selectedDir = join(archivalDir, 'selected');
              await mkdir(selectedDir, { mode: 0o700 });
              await Promise.all([
                writeFile(archivalVideoPath, videoBytes, { mode: 0o600 }),
                writeFile(archivalCanonicalInputPath, canonicalBytes, { mode: 0o600 }),
              ]);
              await run(ffmpegBinary, archivalStillArgs(
                archivalCanonicalInputPath,
                archivalCanonicalOutputPath,
              ));
              await run(ffmpegBinary, [
                '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                '-threads', '1', '-filter_threads', '1', '-i', archivalVideoPath,
                '-map', '0:v:0', '-an', '-sn', '-dn',
                '-vf', selectedFrameFilter(selectedVideoIndices),
                '-frames:v', String(selectedVideoIndices.length),
                '-fps_mode', 'vfr', '-compression_level', '9',
                join(selectedDir, 'frame-%04d.png'),
              ]);
              const selectedNames = (await readdir(selectedDir))
                .filter((name) => /^frame-\d{4}\.png$/.test(name))
                .sort();
              if (selectedNames.length !== selectedVideoIndices.length) {
                throw new VideoSpriteCompileError(
                  'archival_frame_count_mismatch',
                  'FFmpeg did not reproduce every selected frame at archival resolution.',
                );
              }
              const [archivalCanonicalPng, ...selectedVideoFramePngs] = await Promise.all([
                readFile(archivalCanonicalOutputPath),
                ...selectedNames.map((name) => readFile(join(selectedDir, name))),
              ]);
              return { canonicalPng: archivalCanonicalPng, selectedVideoFramePngs };
            } finally {
              await rm(archivalDir, { recursive: true, force: true });
            }
          },
        };
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  };
}
