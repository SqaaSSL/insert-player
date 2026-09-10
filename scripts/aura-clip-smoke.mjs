import { fileURLToPath } from 'node:url';

const CLIP_ID = /^[A-Za-z0-9_-]{32}$/;
const JPEG_PREFIX = 'data:image/jpeg;base64,';

function assert(condition, message) {
  if (!condition) throw new Error(`Aura clip smoke: ${message}`);
}

export function assertAuraClipSmokeEnvironment({ target, githubActions, githubRef, githubSha }) {
  if (target !== 'production') return null;
  assert(githubActions === 'true' && githubRef === 'refs/heads/main' && /^[a-f0-9]{40}$/.test(githubSha ?? ''),
    'production publication must run in GitHub Actions from main.');
  return githubSha;
}

/** Compile the same source and raw rules fingerprint as this exact release. */
export async function createAuraClipSmokeChallenge() {
  const { createServer } = await import('vite');
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false, optimizeDeps: { noDiscovery: true, entries: [] },
    server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const { createAuraChallengeRoutine, createAuraChallenge, encodeAuraChallenge } = await server.ssrLoadModule('/src/game/aura/AuraChallenge.ts');
    const routine = createAuraChallengeRoutine(42, 'lowkey', 'neon-arena-155', 'aura-plaza-v3');
    assert(routine, 'the release has no compatible smoke routine.');
    return encodeAuraChallenge(createAuraChallenge(routine, 'Insert Player QA', 1200, 0));
  } finally { await server.close(); }
}

/** Generate a tiny, real browser recording with explicitly synthetic branding.
 * No account, user photo, network media or live battle is ever captured. */
export async function createAuraClipSmokeMedia() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  let captureTimeout;
  try {
    const page = await browser.newPage();
    const capture = await Promise.race([page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 180; canvas.height = 320;
      const context = canvas.getContext('2d');
      if (!context || !MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) throw new Error('QA recording is unsupported.');
      const paint = (progress) => {
        context.fillStyle = '#050507'; context.fillRect(0, 0, 180, 320);
        context.fillStyle = '#ffce3a'; context.textAlign = 'center'; context.font = 'bold 17px sans-serif';
        context.fillText('INSERT PLAYER', 90, 75);
        context.fillStyle = '#fff4d6'; context.font = 'bold 15px sans-serif'; context.fillText('AURA · QA TEST', 90, 150);
        context.font = '12px sans-serif'; context.fillText('Synthetic release check', 90, 180);
        context.fillStyle = '#ff2a2a'; context.fillRect(20, 240, 140 * progress, 8);
      };
      paint(0.1);
      const poster = canvas.toDataURL('image/jpeg', 0.75);
      const stream = canvas.captureStream(12);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 120_000 });
      const chunks = [];
      const recording = new Promise((resolve, reject) => {
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onerror = () => reject(new Error('QA recording failed.'));
        recorder.onstop = async () => {
          const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
          let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
          resolve(btoa(binary));
        };
      });
      recorder.start();
      let frame = 0;
      const timer = setInterval(() => paint(++frame / 12), 100);
      try { await new Promise(resolve => setTimeout(resolve, 1200)); recorder.stop(); return { videoBase64: await recording, poster }; }
      finally { clearInterval(timer); stream.getTracks().forEach(track => track.stop()); }
    }), new Promise((_, reject) => { captureTimeout = setTimeout(() => reject(new Error('QA recording exceeded 10 seconds.')), 10_000); })]);
    clearTimeout(captureTimeout);
    assert(capture.poster.startsWith(JPEG_PREFIX), 'the recording poster is not JPEG.');
    const video = Buffer.from(capture.videoBase64, 'base64');
    const poster = Buffer.from(capture.poster.slice(JPEG_PREFIX.length), 'base64');
    assert(video.length >= 16 && video.length < 1024 * 1024, 'the synthetic recording exceeded its 1 MB limit.');
    assert(poster.length > 0 && poster.length < 256 * 1024, 'the synthetic poster exceeded its limit.');
    return { video, poster, contentType: 'video/webm' };
  } finally { clearTimeout(captureTimeout); await browser.close(); }
}

/** The injected request keeps existing timeout/retry/version routing semantics.
 * Authentication is sent only to the init route; public delivery is unauthenticated. */
export async function runHostedAuraClipSmoke({ request, authHeaders, baseUrl, frontendOrigin, challengeToken, media, expectedSha, log = () => {} }) {
  const apiOrigin = new URL(baseUrl).origin;
  const appOrigin = new URL(frontendOrigin).origin;
  let upload = null;
  let failure = null;
  let clip = null;
  const response = async (label, target, status, init = {}) => {
    const res = await request(target, { redirect: 'error', ...init });
    assert(res.status === status, `${label} expected HTTP ${status}, got ${res.status}.`);
    return res;
  };
  if (expectedSha) {
    const release = await (await response('frontend provenance', `${appOrigin}/release.json`, 200)).json();
    const health = await (await response('worker provenance', `${apiOrigin}/health`, 200)).json();
    assert(release.gitSha === expectedSha, 'the frontend does not match this main commit.');
    assert(health.workerVersion?.tag?.startsWith(`prod-${expectedSha}-`), 'the Worker does not match this main commit.');
  }
  try {
    const initialized = await response('upload initialization', `${apiOrigin}/api/aura/clips`, 201, {
      method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ challengeToken, contentType: media.contentType, byteLength: media.video.length, posterBase64: media.poster.toString('base64') }),
    });
    upload = await initialized.json();
    assert(CLIP_ID.test(upload.id) && CLIP_ID.test(upload.deleteToken) && CLIP_ID.test(upload.uploadToken), 'initialization returned invalid capabilities.');
    const videoUrl = `${apiOrigin}/api/aura/clips/${upload.id}/video`;
    assert(upload.uploadUrl === videoUrl, 'the upload destination is not the configured API.');
    await response('unpublished metadata', `${apiOrigin}/api/aura/clips/${upload.id}`, 404);
    const completed = await response('video upload', videoUrl, 201, {
      method: 'PUT', headers: { Authorization: `Bearer ${upload.uploadToken}`, 'Content-Type': media.contentType }, body: media.video,
    });
    clip = (await completed.json()).clip;
    assert(clip?.id === upload.id && clip.challengeToken === challengeToken, 'publication changed the challenge.');
    assert(clip.shareUrl === `${appOrigin}/watch/${upload.id}`, 'sharing does not use the Insert Player watch route.');
    assert(clip.videoUrl === videoUrl && clip.downloadUrl === `${videoUrl}?download=1`, 'video/download routes are incorrect.');
    assert(clip.posterUrl === `${apiOrigin}/api/aura/clips/${upload.id}/poster`, 'the real recording poster is missing.');
    assert(clip.byteLength === media.video.length && clip.contentType === media.contentType, 'the recording metadata changed.');
    assert(clip.ogImageUrl.startsWith(`${apiOrigin}/challenges/aura/${challengeToken}/og.png?v=`), 'the Fight-style OG route is missing.');
    const publicResponse = await response('public metadata', `${apiOrigin}/api/aura/clips/${upload.id}`, 200);
    const publicText = await publicResponse.text();
    assert(JSON.stringify(JSON.parse(publicText)) === JSON.stringify(clip), 'public metadata differs from the uploaded recording.');
    assert(!publicText.includes(upload.deleteToken) && !publicText.includes(upload.uploadToken) && !publicText.includes('owner_user_id'), 'public metadata leaks a private capability or owner.');
    assert(publicResponse.headers.get('Cache-Control') === 'no-store', 'public metadata can outlive revocation in cache.');
    const watch = await response('root-domain watch page', clip.shareUrl, 200);
    const html = await watch.text();
    assert(watch.headers.get('Cache-Control') === 'no-store', 'the watch page can outlive revocation in cache.');
    assert((html.match(/property="og:image"/g) ?? []).length === 1 && html.includes(`content="${clip.ogImageUrl}"`), 'the watch page has missing or duplicate battle OG metadata.');
    assert(html.includes(`content="${clip.shareUrl}"`) && html.includes('Insert Player QA'), 'the watch page does not identify this published battle.');
    assert(/<script\b[^>]*src="\/assets\/[^\"]+\.js"/.test(html), 'the watch page is missing the production app shell.');
    assert(!html.includes('og:video') && !html.includes('location.replace'), 'the watch link bypasses the branded page.');
    const image = await response('battle OG image', clip.ogImageUrl, 200);
    const imageBytes = Buffer.from(await image.arrayBuffer());
    assert(image.headers.get('Content-Type')?.startsWith('image/png') && imageBytes.length > 24
      && imageBytes.readUInt32BE(16) === 1200 && imageBytes.readUInt32BE(20) === 630, 'the OG is not a 1200×630 PNG.');
    const range = await response('video seeking', videoUrl, 206, { headers: { Range: 'bytes=0-63' } });
    assert(range.headers.get('Content-Range') === `bytes 0-63/${media.video.length}`, 'the video range is incorrect.');
    assert(Buffer.from(await range.arrayBuffer()).equals(media.video.subarray(0, 64)), 'seeking returned different video bytes.');
    const download = await response('video download', clip.downloadUrl, 200);
    assert(download.headers.get('Content-Disposition')?.startsWith('attachment; filename="Insert-Player-Aura-'), 'the download lost Insert Player branding.');
    assert(Buffer.from(await download.arrayBuffer()).equals(media.video), 'the uploaded recording was altered.');
    const poster = await response('recording poster', clip.posterUrl, 200);
    assert(poster.headers.get('Content-Type') === 'image/jpeg' && Buffer.from(await poster.arrayBuffer()).equals(media.poster), 'the poster bytes changed.');
    log('Aura publishes original video with a real poster, root-domain watch page, Fight-style OG, seeking and download');
  } catch (error) { failure = error; }
  finally {
    if (upload && CLIP_ID.test(upload.id) && CLIP_ID.test(upload.deleteToken)) {
      try {
        await response('clip revocation', `${apiOrigin}/api/aura/clips/${upload.id}`, 204, {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deleteToken: upload.deleteToken }),
        });
        for (const path of ['', '/video', '/poster']) await response('revoked clip resource', `${apiOrigin}/api/aura/clips/${upload.id}${path}`, 404);
        const revoked = await response('revoked watch page', `${appOrigin}/watch/${upload.id}`, 404);
        assert(!(await revoked.text()).includes('property="og:image"'), 'the revoked watch page retained the public battle preview.');
        log('Aura smoke clip revoked; metadata, video, poster and watch URL are unavailable');
      } catch (cleanupError) {
        if (failure) throw new AggregateError([failure, cleanupError], 'Aura clip verification failed and cleanup could not be confirmed.');
        throw cleanupError;
      }
    }
  }
  if (failure) throw failure;
}
