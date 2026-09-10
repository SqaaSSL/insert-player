import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CAPTURE_ROUTE = '/__dev/gameplay-capture/rush';
export const MAX_GAMEPLAY_CAPTURE_BYTES = 32 * 1024 * 1024;
let lastTimestamp = 0;

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

function isSameOriginLoopback(req) {
  const remote = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  try {
    const host = new URL(`http://${req.headers.host}`);
    const origin = new URL(req.headers.origin);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)
      && origin.protocol === 'http:' && origin.origin === host.origin
      && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
  } catch { return false; }
}

function collectClip(req) {
  return new Promise((resolveBody, reject) => {
    let chunks = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => fail(408, 'Local capture transfer timed out.'), 25_000);
    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks = [];
      reject(Object.assign(new Error(message), { status }));
      req.resume();
    };
    req.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_GAMEPLAY_CAPTURE_BYTES) { fail(413, 'Clip exceeds the 32 MB limit.'); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveBody(Buffer.concat(chunks, bytes));
    });
    req.on('error', () => fail(400, 'Local capture transfer failed.'));
    req.on('aborted', () => fail(400, 'Local capture transfer was cancelled.'));
  });
}

/** Fixed-purpose dev middleware; no client-selected directory or filename. */
export function createDevGameplayCaptureMiddleware(root) {
  return (req, res, next) => {
    if (req.url?.split('?', 1)[0] !== CAPTURE_ROUTE) { next(); return; }
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST required.' }); return; }
    if (!isSameOriginLoopback(req)) { sendJson(res, 403, { error: 'Same-origin localhost capture only.' }); req.resume(); return; }
    const mime = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    const extension = mime === 'video/mp4' ? 'mp4' : mime === 'video/webm' ? 'webm' : null;
    if (!extension) { sendJson(res, 415, { error: 'Only MP4 or WebM game clips are accepted.' }); req.resume(); return; }
    if (Number(req.headers['content-length']) > MAX_GAMEPLAY_CAPTURE_BYTES) {
      sendJson(res, 413, { error: 'Clip exceeds the 32 MB limit.' }); req.resume(); return;
    }
    void (async () => {
      const bytes = await collectClip(req);
      const validContainer = bytes.length >= 12 && (extension === 'mp4'
        ? bytes.toString('ascii', 4, 8) === 'ftyp'
        : bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])));
      if (!validContainer) { sendJson(res, 415, { error: 'Clip container does not match its video type.' }); return; }
      const directory = resolve(root, '.local', 'captures');
      await mkdir(directory, { recursive: true });
      const timestamp = Math.max(Date.now(), lastTimestamp + 1);
      lastTimestamp = timestamp;
      const filename = `rush-preview-${timestamp}.${extension}`;
      const path = resolve(directory, filename);
      await writeFile(path, bytes, { flag: 'wx' });
      sendJson(res, 201, { path, filename, bytes: bytes.length });
    })().catch(error => {
      if (!res.writableEnded && !res.destroyed) sendJson(res, error.status ?? 500, {
        error: error.status ? error.message : 'Could not save the local clip.',
      });
    });
  };
}

export function devGameplayCapturePlugin() {
  return {
    name: 'dev-gameplay-capture',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(createDevGameplayCaptureMiddleware(server.config.root));
    },
  };
}
