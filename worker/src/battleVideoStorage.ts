import { createHash } from 'node:crypto';
/** Bounded multipart upload avoids buffering an entire movie or trusting a client Content-Length. */
export async function storeBattleVideo(bucket: R2Bucket, key: string, body: ReadableStream<Uint8Array>, type: string, maxBytes: number): Promise<{ size: number; sha256: string }> {
  const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: type, cacheControl: 'private, no-store' } });
  const reader = body.getReader(), hash = createHash('sha256');
  const partBytes = 5 * 1024 * 1024, parts: R2UploadedPart[] = [], header: number[] = [];
  let buffer = new Uint8Array(partBytes), filled = 0, total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.length; if (total > maxBytes) throw new Error('video_too_large');
      hash.update(value); for (const byte of value.subarray(0, Math.max(0, 16 - header.length))) header.push(byte);
      let offset = 0;
      while (offset < value.length) {
        const count = Math.min(value.length - offset, partBytes - filled); buffer.set(value.subarray(offset, offset + count), filled); filled += count; offset += count;
        if (filled === partBytes) { parts.push(await upload.uploadPart(parts.length + 1, buffer)); buffer = new Uint8Array(partBytes); filled = 0; }
      }
    }
    if (total < 16 || (type === 'video/mp4' ? String.fromCharCode(...header.slice(4, 8)) !== 'ftyp' : header.slice(0, 4).join(',') !== '26,69,223,163')) throw new Error('invalid_video');
    if (filled > 0) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, filled)));
    await upload.complete(parts);
    return { size: total, sha256: hash.digest('hex') };
  } catch (error) { await reader.cancel().catch(() => undefined); await upload.abort().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
}
