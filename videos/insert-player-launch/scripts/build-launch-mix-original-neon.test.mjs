import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '..');
const mixPath = resolve(
  projectRoot,
  'assets/generated/launch-mix-original-neon-gameplay-v3.wav',
);
const approvedIntroPath = resolve(
  projectRoot,
  'assets/generated/launch-mix-google-v2-neon-reference.wav',
);

function readPcm16Wav(filePath) {
  const file = readFileSync(filePath);
  expect(file.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(file.subarray(8, 12).toString('ascii')).toBe('WAVE');

  let format;
  let pcm;
  for (let offset = 12; offset + 8 <= file.length; ) {
    const chunkId = file.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = file.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === 'fmt ') {
      format = {
        audioFormat: file.readUInt16LE(chunkStart),
        channels: file.readUInt16LE(chunkStart + 2),
        sampleRate: file.readUInt32LE(chunkStart + 4),
        bitsPerSample: file.readUInt16LE(chunkStart + 14),
      };
    }
    if (chunkId === 'data') {
      pcm = file.subarray(chunkStart, chunkStart + chunkSize);
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  expect(format).toBeDefined();
  expect(pcm).toBeDefined();
  expect(format).toMatchObject({
    audioFormat: 1,
    channels: 2,
    sampleRate: 48_000,
    bitsPerSample: 16,
  });
  return { ...format, pcm };
}

function meanVolumeDb(wav, startSeconds, durationSeconds) {
  const frameBytes = wav.channels * 2;
  const startFrame = Math.round(startSeconds * wav.sampleRate);
  const frameCount = Math.round(durationSeconds * wav.sampleRate);
  let sumSquares = 0;
  let sampleCount = 0;

  for (
    let offset = startFrame * frameBytes;
    offset < (startFrame + frameCount) * frameBytes;
    offset += 2
  ) {
    const normalized = wav.pcm.readInt16LE(offset) / 32_768;
    sumSquares += normalized * normalized;
    sampleCount += 1;
  }

  const rms = Math.sqrt(sumSquares / sampleCount);
  return 20 * Math.log10(Math.max(rms, Number.EPSILON));
}

describe('original Neon Arena launch mix', () => {
  it('preserves the approved opening sample-for-sample', () => {
    const mix = readPcm16Wav(mixPath);
    const intro = readPcm16Wav(approvedIntroPath);
    const introBytes = Math.round(4.65 * mix.sampleRate) * mix.channels * 2;

    expect(mix.pcm.subarray(0, introBytes)).toEqual(intro.pcm.subarray(0, introBytes));
  });

  it('keeps Neon Arena audible throughout gameplay and the closing lockup', () => {
    const mix = readPcm16Wav(mixPath);
    const windows = [5.15, 7.25, 9.25, 10.2, 11.25];

    for (const startSeconds of windows) {
      expect(meanVolumeDb(mix, startSeconds, 0.4)).toBeGreaterThan(-50);
    }
  });
});
