import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Same RIFF chunk walk as the existing original-Neon audio tests.
export function readPcm16(filePath) {
  const file = readFileSync(filePath);
  assert.equal(file.toString('ascii', 0, 4), 'RIFF');
  assert.equal(file.toString('ascii', 8, 12), 'WAVE');
  let format;
  let pcm;
  for (let offset = 12; offset + 8 <= file.length;) {
    const id = file.toString('ascii', offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const start = offset + 8;
    assert(start + size <= file.length, 'Truncated WAV chunk');
    if (id === 'fmt ') {
      assert(size >= 16);
      format = [file.readUInt16LE(start), file.readUInt16LE(start + 2),
        file.readUInt32LE(start + 4), file.readUInt16LE(start + 14)];
    }
    if (id === 'data') {
      assert.equal(pcm, undefined, 'Expected one PCM data chunk');
      pcm = file.subarray(start, start + size);
    }
    offset = start + size + size % 2;
  }
  assert.deepEqual(format, [1, 2, 48000, 16]);
  assert(pcm && pcm.length > 0 && pcm.length % 4 === 0);
  return pcm;
}
