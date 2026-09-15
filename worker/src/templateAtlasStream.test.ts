import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workflows', () => ({ NonRetryableError: class extends Error {} }));
import { templateAtlasCompileBody } from './templateAtlasStream';

const fields = { rendererVersion: 'rookie-two-atlas-v1', animationNames: ['ko'], generationToken: 'test-only' };
function fixture(size: number) { return Uint8Array.from({ length: size }, (_, i) => (i * 37 + 19) % 256); }
function bucket(bytes: Uint8Array, chunk = 65537, declared = bytes.length) {
  const cancelled = vi.fn();
  return { cancelled, get: vi.fn(async (_key: string) => {
    let offset = 0;
    return { size: declared, body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, offset + chunk)); offset = Math.min(offset + chunk, bytes.length);
      }, cancel: cancelled,
    }) };
  }) };
}

describe('bounded Template Atlas JSON stream', () => {
  it.each([24, 25, 26, 24575, 24576, 24577, 262147])('preserves exact base64 across chunk boundaries (%i bytes)', async size => {
    const bytes = fixture(size), storage = bucket(bytes, 7);
    const body = templateAtlasCompileBody(storage as unknown as R2Bucket, fields,
      [{ planId: 'plan-"one', rawKey: 'raw', sizeBytes: size }]);
    expect(await new Response(body).text()).toBe(JSON.stringify({ ...fields,
      atlases: [{ planId: 'plan-"one', rawBase64: Buffer.from(bytes).toString('base64') }] }));
  });

  it('opens one source at a time and bounds every encoded chunk to 32 KiB', async () => {
    const bytes = fixture(1024 * 1024 + 2), storage = bucket(bytes, bytes.length);
    const reader = templateAtlasCompileBody(storage as unknown as R2Bucket, fields,
      [{ planId: 'one', rawKey: 'first' }, { planId: 'two', rawKey: 'second' }]).getReader();
    let maxChunk = 0;
    expect(storage.get).not.toHaveBeenCalled();
    while (true) { const { done, value } = await reader.read(); if (done) break; maxChunk = Math.max(maxChunk, value.length); }
    expect(maxChunk).toBeLessThanOrEqual(32768);
    expect(storage.get.mock.calls.map(call => call[0])).toEqual(['first', 'second']);
  });

  it.each([
    { declared: 23, actual: 24 },
    { declared: 32 * 1024 * 1024 + 1, actual: 24 },
    { declared: 24, actual: 25 },
    { declared: 25, actual: 24 },
  ])('rejects invalid, overlong and truncated RAWs (%j)', async ({ declared, actual }) => {
    const storage = bucket(fixture(actual), 7, declared);
    await expect(new Response(templateAtlasCompileBody(storage as unknown as R2Bucket, fields,
      [{ planId: 'one', rawKey: 'raw' }])).text()).rejects.toThrow();
  });

  it('rejects missing objects, mutated sizes and invalid input counts', async () => {
    for (const storage of [{ get: async () => null }, bucket(fixture(24))]) {
      await expect(new Response(templateAtlasCompileBody(storage as unknown as R2Bucket, fields,
        [{ planId: 'one', rawKey: 'raw', sizeBytes: 25 }])).text()).rejects.toThrow();
    }
    const storage = bucket(fixture(24)) as unknown as R2Bucket;
    expect(() => templateAtlasCompileBody(storage, fields, [])).toThrow();
    expect(() => templateAtlasCompileBody(storage, fields, Array(3).fill({ planId: 'one', rawKey: 'raw' }))).toThrow();
    expect(() => templateAtlasCompileBody(storage, { atlases: [] }, [{ planId: 'one', rawKey: 'raw' }])).toThrow();
  });

  it('cancels the R2 reader without opening the second source', async () => {
    const storage = bucket(fixture(100000), 13);
    const reader = templateAtlasCompileBody(storage as unknown as R2Bucket, fields,
      [{ planId: 'one', rawKey: 'first' }, { planId: 'two', rawKey: 'second' }]).getReader();
    await reader.read(); await reader.read(); await reader.read(); await reader.cancel('test cancellation');
    expect(storage.cancelled).toHaveBeenCalledOnce(); expect(storage.get).toHaveBeenCalledOnce();
  });

  it('supports an otherwise empty JSON envelope', async () => {
    const bytes = fixture(24), storage = bucket(bytes);
    expect(await new Response(templateAtlasCompileBody(storage as unknown as R2Bucket, {},
      [{ planId: 'one', rawKey: 'raw' }])).json()).toEqual({ atlases: [{ planId: 'one', rawBase64: Buffer.from(bytes).toString('base64') }] });
  });

  it('rejects a known oversized RPC before opening either preserved RAW', () => {
    const storage = bucket(fixture(24));
    expect(() => templateAtlasCompileBody(storage as unknown as R2Bucket, fields,
      [{ planId: 'one', rawKey: 'first', sizeBytes: 24 * 1024 * 1024 },
        { planId: 'two', rawKey: 'second', sizeBytes: 24 * 1024 * 1024 }]))
      .toThrow('Template atlas request exceeds the processor limit');
    expect(storage.get).not.toHaveBeenCalled();
  });

  it.each([12, 20])('streams two %i MiB R2 objects through a real workerd Request with exact JSON hash', async mib => {
    const size = mib * 1024 * 1024;
    const modulePath = fileURLToPath(new URL('./templateAtlasStream.ts', import.meta.url).href);
    const script = await build({ stdin: { contents: `
      import { templateAtlasCompileBody } from ${JSON.stringify(modulePath)};
      export default { async fetch(request, env) {
        const body = templateAtlasCompileBody(env.RAWS, ${JSON.stringify(fields)},
          [{planId:'one',rawKey:'one',sizeBytes:${size}},{planId:'two',rawKey:'two',sizeBytes:${size}}]);
        return env.SINK.fetch(new Request('https://sink.invalid/compile', {method:'POST',body}));
      } };`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm',
      platform: 'neutral', external: ['cloudflare:workflows'] });
    const raw = Buffer.from(fixture(size)), expected = createHash('sha256');
    expected.update(JSON.stringify({ ...fields, atlases: [
      { planId: 'one', rawBase64: raw.toString('base64') }, { planId: 'two', rawBase64: raw.toString('base64') },
    ] }));
    let total = 0, largest = 0;
    const mf = new Miniflare({ workers: [{ config: { type: 'worker', name: 'stream-audit',
      compatibilityDate: '2026-08-22',
      manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: script.outputFiles[0].text } } },
      env: { RAWS: { type: 'r2', name: 'atlas-stream-test' }, SINK: { type: 'fetcher', handler: async (request: Request) => {
        const hash = createHash('sha256'), reader = request.body!.getReader();
        while (true) { const { done, value } = await reader.read(); if (done) break;
          total += value.length; largest = Math.max(largest, value.length); hash.update(value); }
        return Response.json({ hash: hash.digest('hex'), total });
      } } } } }] });
    try {
      const storage = await mf.getR2Bucket('RAWS');
      await storage.put('one', raw); await storage.put('two', raw);
      const response = await mf.dispatchFetch('https://worker.invalid/');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ hash: expected.digest('hex'), total });
      expect(total).toBeGreaterThan(32 * 1024 * 1024);
      // Transport can coalesce chunks; its sink never buffers a complete body.
      expect(largest).toBeLessThan(1024 * 1024);
    } finally { await mf.dispose(); }
  }, 60000);
});
