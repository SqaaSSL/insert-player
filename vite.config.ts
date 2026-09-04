import { type Plugin, loadEnv } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';
import type { IncomingMessage, ServerResponse } from 'http';

function apiProxyPlugin(): Plugin {
  type ProxyProvider = 'ludo' | 'freepik' | 'gemini' | 'runway' | 'fal';

  let ludoKey = '';
  let freepikKey = '';
  let geminiKey = '';
  let runwayKey = '';
  let falKey = '';
  let googleMapsServerKey = '';

  function sanitizeProxyUrlForLog(rawUrl: string): string {
    try {
      const url = new URL(rawUrl);
      for (const key of ['key', 'api_key', 'apikey', 'token', 'access_token']) {
        if (url.searchParams.has(key)) url.searchParams.set(key, '<redacted>');
      }
      return url.toString();
    } catch {
      return rawUrl.replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s]+/gi, '$1<redacted>');
    }
  }

  async function proxyRequest(
    req: IncomingMessage,
    res: ServerResponse,
    provider: ProxyProvider,
    targetUrl: string,
    extraHeaders: Record<string, string>,
  ) {
    const body = await collectBody(req);
    const method = req.method ?? 'POST';
    const safeTargetUrl = sanitizeProxyUrlForLog(targetUrl);

    if (provider === 'gemini') {
      const redactedUrl = new URL(safeTargetUrl);
      if (redactedUrl.searchParams.get('key') !== '<redacted>') {
        throw new Error('Gemini proxy URL credential redaction failed');
      }
    }

    console.log(`[proxy:${provider}] ${method} request (${body.length} bytes)`);

    const upstreamHeaders: Record<string, string> = {
      ...extraHeaders,
    };
    if (req.headers['content-type']) {
      upstreamHeaders['Content-Type'] = req.headers['content-type'];
    }

    try {
      const upstream = await fetch(targetUrl, {
        method,
        headers: upstreamHeaders,
        body: body.length > 0 ? body : undefined,
      });

      const ct = upstream.headers.get('content-type');
      if (ct) res.setHeader('Content-Type', ct);
      const retryAfter = upstream.headers.get('retry-after');
      if (retryAfter) res.setHeader('Retry-After', retryAfter);

      const respBody = Buffer.from(await upstream.arrayBuffer());
      console.log(`[proxy:${provider}] ${method} -> ${upstream.status} (${respBody.length} bytes)`);

      if (upstream.status >= 400) {
        console.error(`[proxy:${provider}] upstream error response (${respBody.length} bytes)`);
      }

      res.writeHead(upstream.status);
      res.end(respBody);
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      console.error(`[proxy:${provider}] ${method} failed (${errorName})`);
      res.writeHead(502);
      res.end('Proxy request failed');
    }
  }

  function collectBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function handleTempUpload(req: IncomingMessage, res: ServerResponse) {
    try {
      const body = await collectBody(req);
      const { image } = JSON.parse(body.toString());
      if (!image) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing image field' }));
        return;
      }

      const imgBuffer = Buffer.from(image, 'base64');
      console.log(`[proxy] Uploading temp image (${(imgBuffer.length / 1024).toFixed(0)} KB) to litterbox.catbox.moe...`);

      const formData = new FormData();
      formData.append('reqtype', 'fileupload');
      formData.append('time', '24h');
      formData.append('fileToUpload', new Blob([imgBuffer], { type: 'image/png' }), 'fighter.png');

      const upstream = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
        method: 'POST',
        body: formData,
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        console.error(`[proxy] Litterbox upload failed (${upstream.status}):`, errText.slice(0, 200));
        res.writeHead(upstream.status);
        res.end(JSON.stringify({ error: `Upload failed: ${upstream.status}` }));
        return;
      }

      const publicUrl = (await upstream.text()).trim();
      console.log('[proxy] Temp image uploaded');

      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ url: publicUrl }));
    } catch (err: any) {
      console.error(`[proxy] Temp upload error:`, err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  async function handleStreetViewCapture(req: IncomingMessage, res: ServerResponse) {
    const sendJson = (status: number, error: string) => {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(status);
      res.end(JSON.stringify({ error }));
    };
    if (req.method !== 'POST') {
      sendJson(405, 'Method not allowed');
      return;
    }
    if (!googleMapsServerKey) {
      sendJson(503, 'Street View capture is not configured.');
      return;
    }

    let body: Record<string, unknown>;
    try {
      const raw = await collectBody(req);
      if (raw.length > 8 * 1024) {
        sendJson(413, 'Request body is too large');
        return;
      }
      body = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      sendJson(400, 'Invalid Street View capture request.');
      return;
    }

    const panoId = typeof body.panoId === 'string' ? body.panoId.trim() : '';
    const numberInRange = (value: unknown, min: number, max: number) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= min && parsed <= max;
    };
    if (
      !/^[A-Za-z0-9_-]{1,256}$/.test(panoId) ||
      !numberInRange(body.latitude, -90, 90) ||
      !numberInRange(body.longitude, -180, 180) ||
      !numberInRange(body.heading, 0, 360) ||
      !numberInRange(body.pitch, -90, 90) ||
      !numberInRange(body.fov, 10, 120)
    ) {
      sendJson(400, 'Invalid Street View capture parameters.');
      return;
    }

    const upstreamUrl = new URL('https://maps.googleapis.com/maps/api/streetview');
    upstreamUrl.searchParams.set('size', '640x360');
    upstreamUrl.searchParams.set('scale', '2');
    upstreamUrl.searchParams.set('pano', panoId);
    upstreamUrl.searchParams.set('heading', String(Number(body.heading)));
    upstreamUrl.searchParams.set('pitch', String(Number(body.pitch)));
    upstreamUrl.searchParams.set('fov', String(Number(body.fov)));
    upstreamUrl.searchParams.set('return_error_code', 'true');
    upstreamUrl.searchParams.set('key', googleMapsServerKey);

    try {
      let upstream = await fetch(upstreamUrl, { redirect: 'follow' });
      if (upstream.status === 404) {
        const locationUrl = new URL(upstreamUrl);
        locationUrl.searchParams.delete('pano');
        locationUrl.searchParams.set('location', `${Number(body.latitude)},${Number(body.longitude)}`);
        locationUrl.searchParams.set('radius', '25');
        upstream = await fetch(locationUrl, { redirect: 'follow' });
      }
      if (!upstream.ok) {
        sendJson(
          upstream.status === 404 ? 404 : upstream.status === 429 ? 429 : 502,
          upstream.status === 404
            ? 'This panorama is no longer available. Choose another blue Street View line.'
            : upstream.status === 429
              ? 'Street View capture quota has been reached. Try again later.'
              : 'Google could not capture this Street View image.',
        );
        return;
      }
      const contentType = upstream.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType) || bytes.length === 0 || bytes.length > 5 * 1024 * 1024) {
        sendJson(502, 'Google returned an invalid Street View capture.');
        return;
      }
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.writeHead(200);
      res.end(bytes);
    } catch {
      sendJson(502, 'Street View is temporarily unavailable.');
    }
  }

  return {
    name: 'api-proxy',
    configureServer(server) {
      const env = loadEnv('', process.cwd(), '');
      ludoKey = env.LUDO_API_KEY || '';
      freepikKey = env.FREEPIK_API_KEY || '';
      geminiKey = env.GEMINI_API_KEY || '';
      runwayKey = env.RUNWAY_API_KEY || '';
      falKey = env.FAL_API_KEY || '';
      googleMapsServerKey = env.GOOGLE_MAPS_SERVER_KEY || '';

      const configured = (key: string) => key ? 'configured' : 'missing';
      console.log(`[proxy] LUDO_API_KEY: ${configured(ludoKey)}`);
      console.log(`[proxy] FREEPIK_API_KEY: ${configured(freepikKey)}`);
      console.log(`[proxy] GEMINI_API_KEY: ${configured(geminiKey)}`);
      console.log(`[proxy] RUNWAY_API_KEY: ${configured(runwayKey)}`);
      console.log(`[proxy] FAL_API_KEY: ${configured(falKey)}`);

      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        const pathname = new URL(url, 'http://localhost').pathname;

        if (pathname === '/api/maps/street-view/capture') {
          void handleStreetViewCapture(req, res);
          return;
        }

        if (url.startsWith('/proxy/upload-temp')) {
          handleTempUpload(req, res);
          return;
        }

        if (url.startsWith('/proxy/image') || url.startsWith('/proxy/media')) {
          const isMediaProxy = url.startsWith('/proxy/media');
          const targetUrl = new URL(url, 'http://localhost').searchParams.get('url');
          if (!targetUrl) {
            res.writeHead(400);
            res.end('Missing ?url= parameter');
            return;
          }
          fetch(targetUrl)
            .then(async (upstream) => {
              if (!upstream.ok) {
                res.writeHead(upstream.status);
                res.end(`Upstream error: ${upstream.status}`);
                return;
              }
              const ct = upstream.headers.get('content-type');
              const normalizedType = ct?.toLowerCase() ?? '';
              if (normalizedType && !normalizedType.startsWith('image/') && !(isMediaProxy && normalizedType.startsWith('video/'))) {
                res.writeHead(415);
                res.end(isMediaProxy ? 'Upstream did not return supported media' : 'Upstream did not return an image');
                return;
              }
              if (ct) res.setHeader('Content-Type', ct);
              res.setHeader('Cache-Control', 'public, max-age=86400');
              res.writeHead(200);
              res.end(Buffer.from(await upstream.arrayBuffer()));
            })
            .catch((err: any) => {
              res.writeHead(502);
              res.end(`Proxy fetch failed: ${err.message}`);
            });
          return;
        }

        if (url.startsWith('/proxy/ludo')) {
          const apiPath = url.replace(/^\/proxy\/ludo/, '/api');
          proxyRequest(req, res, 'ludo', `https://api.ludo.ai${apiPath}`, {
            Authorization: `ApiKey ${ludoKey}`,
          });
          return;
        }

        if (url.startsWith('/proxy/freepik')) {
          const apiPath = url.replace(/^\/proxy\/freepik/, '');
          proxyRequest(req, res, 'freepik', `https://api.freepik.com${apiPath}`, {
            'x-freepik-api-key': freepikKey,
          });
          return;
        }

        if (url.startsWith('/proxy/gemini')) {
          const apiPath = url.replace(/^\/proxy\/gemini/, '');
          const separator = apiPath.includes('?') ? '&' : '?';
          proxyRequest(req, res, 'gemini', `https://generativelanguage.googleapis.com${apiPath}${separator}key=${geminiKey}`, {});
          return;
        }

        if (url.startsWith('/proxy/runway')) {
          const apiPath = url.replace(/^\/proxy\/runway/, '');
          proxyRequest(req, res, 'runway', `https://api.dev.runwayml.com${apiPath}`, {
            Authorization: `Bearer ${runwayKey}`,
            'X-Runway-Version': '2024-11-06',
          });
          return;
        }

        if (url.startsWith('/proxy/fal')) {
          const apiPath = url.replace(/^\/proxy\/fal/, '');
          proxyRequest(req, res, 'fal', `https://queue.fal.run${apiPath}`, {
            Authorization: `Key ${falKey}`,
          });
          return;
        }

        next();
      });
    },
  };
}

function prelaunchEntryPlugin(mode: string): Plugin {
  return {
    name: 'prelaunch-entry',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return mode === 'prelaunch'
          ? html.replace('/src/main.tsx', '/src/prelaunch.tsx')
          : html;
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  envDir: mode === 'prelaunch' ? false : undefined,
  plugins: [prelaunchEntryPlugin(mode), tailwindcss(), apiProxyPlugin()],
  server: {
    proxy: {
      '/dev-api': {
        target: 'https://api.insertplayer.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/dev-api/, ''),
      },
    },
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      '.local/**',
      'processor/src/benchmark/**/*.test.ts',
      'processor/src/videoSpriteCompiler.test.ts',
      'processor/src/videoSpriteCompilerCore.test.ts',
      'processor/src/videoSpriteFfmpeg.integration.test.ts',
    ],
  },
}));
