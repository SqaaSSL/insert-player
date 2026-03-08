import { defineConfig, type Plugin, loadEnv } from 'vite';
import type { IncomingMessage, ServerResponse } from 'http';

function apiProxyPlugin(): Plugin {
  let ludoKey = '';
  let freepikKey = '';
  let geminiKey = '';

  async function proxyRequest(
    req: IncomingMessage,
    res: ServerResponse,
    targetUrl: string,
    extraHeaders: Record<string, string>,
  ) {
    const body = await collectBody(req);
    const method = req.method ?? 'POST';

    console.log(`[proxy] ${method} ${targetUrl} (body: ${body.length} bytes)`);

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

      const respBody = Buffer.from(await upstream.arrayBuffer());
      console.log(`[proxy] ${method} ${targetUrl} → ${upstream.status} (${respBody.length} bytes)`);

      if (upstream.status >= 400) {
        const preview = respBody.toString('utf-8').slice(0, 300);
        console.error(`[proxy] Error response body: ${preview}`);
      }

      res.writeHead(upstream.status);
      res.end(respBody);
    } catch (err: any) {
      console.error(`[proxy] ${method} ${targetUrl} FAILED:`, err.message);
      res.writeHead(502);
      res.end(`Proxy error: ${err.message}`);
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
      console.log(`[proxy] Temp image uploaded: ${publicUrl}`);

      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ url: publicUrl }));
    } catch (err: any) {
      console.error(`[proxy] Temp upload error:`, err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  return {
    name: 'api-proxy',
    configureServer(server) {
      const env = loadEnv('', process.cwd(), '');
      ludoKey = env.LUDO_API_KEY || env.VITE_LUDO_API_KEY || '';
      freepikKey = env.FREEPIK_API_KEY || env.VITE_FREEPIK_API_KEY || '';
      geminiKey = env.GEMINI_API_KEY || '';

      const mask = (k: string) => k ? `${k.slice(0, 4)}...${k.slice(-4)} (${k.length} chars)` : 'NOT SET';
      console.log(`[proxy] LUDO_API_KEY: ${mask(ludoKey)}`);
      console.log(`[proxy] FREEPIK_API_KEY: ${mask(freepikKey)}`);
      console.log(`[proxy] GEMINI_API_KEY: ${mask(geminiKey)}`);

      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';

        if (url.startsWith('/proxy/upload-temp')) {
          handleTempUpload(req, res);
          return;
        }

        if (url.startsWith('/proxy/image')) {
          const imgUrl = new URL(url, 'http://localhost').searchParams.get('url');
          if (!imgUrl) {
            res.writeHead(400);
            res.end('Missing ?url= parameter');
            return;
          }
          fetch(imgUrl)
            .then(async (upstream) => {
              if (!upstream.ok) {
                res.writeHead(upstream.status);
                res.end(`Upstream error: ${upstream.status}`);
                return;
              }
              const ct = upstream.headers.get('content-type');
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
          proxyRequest(req, res, `https://api.ludo.ai${apiPath}`, {
            Authorization: `ApiKey ${ludoKey}`,
          });
          return;
        }

        if (url.startsWith('/proxy/freepik')) {
          const apiPath = url.replace(/^\/proxy\/freepik/, '');
          proxyRequest(req, res, `https://api.freepik.com${apiPath}`, {
            'x-freepik-api-key': freepikKey,
          });
          return;
        }

        if (url.startsWith('/proxy/gemini')) {
          const apiPath = url.replace(/^\/proxy\/gemini/, '');
          const separator = apiPath.includes('?') ? '&' : '?';
          proxyRequest(req, res, `https://generativelanguage.googleapis.com${apiPath}${separator}key=${geminiKey}`, {});
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [apiProxyPlugin()],
});
