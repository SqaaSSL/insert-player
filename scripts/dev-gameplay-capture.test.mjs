import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createDevGameplayCaptureMiddleware, devGameplayCapturePlugin, MAX_GAMEPLAY_CAPTURE_BYTES } from './dev-gameplay-capture.mjs';

const roots = [];
const mp4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81]);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'asf-dev-clip-'));
  roots.push(root);
  const middleware = createDevGameplayCaptureMiddleware(root);
  const invoke = (overrides = {}) => new Promise(resolve => {
    const request = Readable.from(overrides.chunks ?? [overrides.body ?? mp4]);
    Object.assign(request, {
      url: '/__dev/gameplay-capture/rush', method: overrides.method ?? 'POST',
      socket: { remoteAddress: overrides.remote ?? '127.0.0.1' },
      headers: {
        host: '127.0.0.1:4184', origin: 'http://127.0.0.1:4184',
        'sec-fetch-site': 'same-origin', 'content-type': 'video/mp4', ...overrides.headers,
      },
    });
    const response = {
      writableEnded: false, destroyed: false, status: 0,
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { this.writableEnded = true; resolve({ status: this.status, headers: this.headers, body: JSON.parse(body) }); },
    };
    middleware(request, response, () => resolve({ status: 404 }));
  });
  return { root, invoke };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('local DEV gameplay capture endpoint', () => {
  it('writes MP4/WebM to server-generated filenames inside the fixed capture directory', async () => {
    const { root, invoke } = await fixture();
    for (const [type, bytes] of [['mp4', mp4], ['webm', webm]]) {
      const response = await invoke({ body: bytes, headers: {
        'content-type': `video/${type}`, 'x-filename': '../../outside.mp4',
      } });
      expect(response.status).toBe(201);
      expect(response.headers['Cache-Control']).toBe('no-store');
      expect(response.body.filename).toMatch(new RegExp(`^rush-preview-\\d+\\.${type}$`));
      expect(response.body.path).toBe(join(root, '.local', 'captures', response.body.filename));
      expect(await readFile(response.body.path)).toEqual(bytes);
    }
    expect(await readdir(root)).toEqual(['.local']);
    expect(await readdir(join(root, '.local', 'captures'))).toHaveLength(2);
  });

  it('rejects foreign/missing origins, non-loopback clients and unsupported methods', async () => {
    const { root, invoke } = await fixture();
    for (const overrides of [
      { headers: { origin: 'https://external.example' } },
      { headers: { origin: undefined } },
      { headers: { host: 'external.example', origin: 'http://external.example' } },
      { headers: { 'sec-fetch-site': 'cross-site' } },
      { remote: '192.168.1.40' },
    ]) expect((await invoke(overrides)).status).toBe(403);
    expect((await invoke({ method: 'PUT' })).status).toBe(405);
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects non-video bodies or a mismatched container signature', async () => {
    const { root, invoke } = await fixture();
    expect((await invoke({ headers: { 'content-type': 'application/octet-stream' } })).status).toBe(415);
    expect((await invoke({ body: Buffer.from('not a media clip') })).status).toBe(415);
    expect((await invoke({ body: mp4, headers: { 'content-type': 'video/webm' } })).status).toBe(415);
    expect(await readdir(root)).toEqual([]);
  });

  it('bounds both declared and chunked bodies to32MB without writing partial files', async () => {
    const { root, invoke } = await fixture();
    expect((await invoke({ headers: { 'content-length': String(MAX_GAMEPLAY_CAPTURE_BYTES + 1) } })).status).toBe(413);
    expect((await invoke({ chunks: [mp4, Buffer.alloc(MAX_GAMEPLAY_CAPTURE_BYTES)] })).status).toBe(413);
    expect(await readdir(root)).toEqual([]);
  });

  it('registers only a Vite development server hook, with no production/preview handler', () => {
    const plugin = devGameplayCapturePlugin();
    expect(plugin.apply).toBe('serve');
    expect(typeof plugin.configureServer).toBe('function');
    expect(plugin.configurePreviewServer).toBeUndefined();
    expect(plugin.generateBundle).toBeUndefined();
  });
});
