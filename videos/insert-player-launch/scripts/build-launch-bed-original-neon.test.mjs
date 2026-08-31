import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '..');
const bedPath = resolve(
  projectRoot,
  'assets/generated/launch-bed-original-neon-v10.wav',
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
    if (chunkId === 'data') pcm = file.subarray(chunkStart, chunkStart + chunkSize);
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  expect(format).toMatchObject({
    audioFormat: 1,
    channels: 2,
    sampleRate: 48_000,
    bitsPerSample: 16,
  });
  expect(pcm).toBeDefined();
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

  return 20 * Math.log10(Math.max(Math.sqrt(sumSquares / sampleCount), Number.EPSILON));
}

describe('voiceover-ready Neon Arena launch bed', () => {
  it('is stereo PCM at 48 kHz for exactly the launch timeline', () => {
    const bed = readPcm16Wav(bedPath);
    const duration = bed.pcm.byteLength / (bed.sampleRate * bed.channels * 2);
    expect(duration).toBeCloseTo(20.05, 4);
  });

  it('stays audible under the transformation, gameplay, and closing lockup', () => {
    const bed = readPcm16Wav(bedPath);
    for (const startSeconds of [0.5, 5.15, 7.25, 9.25, 11.8, 15.2, 17.4, 18.2, 19, 19.5]) {
      expect(meanVolumeDb(bed, startSeconds, 0.4)).toBeGreaterThan(-50);
    }
  });
});
