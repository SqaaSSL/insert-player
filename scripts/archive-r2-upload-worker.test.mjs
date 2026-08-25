import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import worker from './archive-r2-upload-worker.mjs';

const TOKEN = 'a'.repeat(64);
const KEY = 'arcade-experiments/v1/test/manifest/hash.json';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

class MemoryR2Bucket {
  objects = new Map();

  async head(key) {
    const object = this.objects.get(key);
    return object ? this.metadata(object) : null;
  }

  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      ...this.metadata(object),
      arrayBuffer: async () => object.bytes.buffer.slice(
        object.bytes.byteOffset,
        object.bytes.byteOffset + object.bytes.byteLength,
      ),
      writeHttpMetadata: (headers) => headers.set('Content-Type', object.contentType),
    };
  }

  async put(key, value, options) {
    if (options?.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    const bytes = Buffer.from(value);
    const object = {
      bytes,
      contentType: options.httpMetadata.contentType,
      customMetadata: options.customMetadata,
    };
    this.objects.set(key, object);
    return this.metadata(object);
  }

  metadata(object) {
    return {
      size: object.bytes.byteLength,
      customMetadata: object.customMetadata,
    };
  }
}

function archiveRequest(method, bytes, overrides = {}) {
  const body = method === 'PUT' ? bytes : undefined;
  return new Request('https://archive.example/archive-object', {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Length': String(bytes.byteLength),
      'Content-Type': 'application/json',
      'X-Archive-Content-Sha256': sha256(bytes),
      'X-Archive-Object-Key': KEY,
      'X-Archive-Size': String(bytes.byteLength),
      ...overrides,
    },
    body,
  });
}

describe('isolated Arcade archive R2 uploader', () => {
  it('stores once, reuses exact bytes, and returns the verified object', async () => {
    const bucket = new MemoryR2Bucket();
    const env = { ARCHIVE_BUCKET: bucket, ARCHIVE_UPLOAD_TOKEN: TOKEN };
    const bytes = Buffer.from('{"sealed":true}\n');

    const stored = await worker.fetch(archiveRequest('PUT', bytes), env);
    expect(stored.status).toBe(201);
    expect((await stored.json()).action).toBe('stored');

    const reused = await worker.fetch(archiveRequest('PUT', bytes), env);
    expect(reused.status).toBe(200);
    expect((await reused.json()).action).toBe('reused');

    const downloaded = await worker.fetch(archiveRequest('GET', bytes), env);
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
    expect(downloaded.headers.get('X-Archive-Content-Sha256')).toBe(sha256(bytes));
  });

  it('rejects unauthorized, out-of-prefix, changed, and oversized writes', async () => {
    const bucket = new MemoryR2Bucket();
    const env = { ARCHIVE_BUCKET: bucket, ARCHIVE_UPLOAD_TOKEN: TOKEN };
    const bytes = Buffer.from('{"sealed":true}\n');

    expect((await worker.fetch(archiveRequest('PUT', bytes, { Authorization: 'Bearer wrong' }), env)).status).toBe(401);
    expect((await worker.fetch(archiveRequest('PUT', bytes, {
      'X-Archive-Object-Key': 'users/private.json',
    }), env)).status).toBe(400);
    expect((await worker.fetch(archiveRequest('PUT', bytes, {
      'X-Archive-Content-Sha256': 'b'.repeat(64),
    }), env)).status).toBe(422);
    expect((await worker.fetch(archiveRequest('PUT', bytes, {
      'X-Archive-Size': String(33 * 1024 * 1024),
    }), env)).status).toBe(400);
    expect(bucket.objects.size).toBe(0);
  });

  it('never overwrites an immutable key with different bytes', async () => {
    const bucket = new MemoryR2Bucket();
    const env = { ARCHIVE_BUCKET: bucket, ARCHIVE_UPLOAD_TOKEN: TOKEN };
    const original = Buffer.from('{"version":1}\n');
    const changed = Buffer.from('{"version":2}\n');
    expect((await worker.fetch(archiveRequest('PUT', original), env)).status).toBe(201);
    expect((await worker.fetch(archiveRequest('PUT', changed), env)).status).toBe(409);
    expect(bucket.objects.get(KEY).bytes).toEqual(original);
  });
});
