import { drawAuraPreview, AURA_PREVIEW_FRAME } from '../../src/ui/shared/auraPreviewCanvas.ts';
import { AURA_PREVIEW_STILL_MS, auraPreviewDuelAt } from '../../src/ui/shared/auraPreviewDuel.ts';
import { auraPreviewFrameGeometry, type AuraPreviewSubject, type AuraPreviewAnimation } from '../../src/ui/shared/auraPreviewGeometry.ts';

interface Input { key: string; url: string; contentHash: string }
async function image(url: string): Promise<HTMLImageElement> {
  const result = new Image();
  result.src = url;
  await result.decode();
  return result;
}
/** Freeze the shipped demo's real chart, scores, HUD and calibrated 6–7 pose. */
export async function draw(inputs: Input[], stageUrl: string) {
  const atlases = new Map(await Promise.all(inputs.map(async ({ key, url, contentHash }) => {
    const [subject, animation] = key.split('/');
    if (!auraPreviewFrameGeometry({ subject: subject as AuraPreviewSubject, animation: animation as AuraPreviewAnimation, frameIndex: 0, contentHash, ...AURA_PREVIEW_FRAME })) throw new Error(`Unreviewed social-card atlas: ${key}`);
    return [key, { image: await image(url), contentHash }] as const;
  })));
  const canvas = document.querySelector<HTMLCanvasElement>('#aura-gameplay');
  const ctx = canvas?.getContext('2d');
  if (!ctx) throw new Error('Missing Aura social-card canvas');
  drawAuraPreview(ctx, await image(stageUrl), atlases, auraPreviewDuelAt(AURA_PREVIEW_STILL_MS, 1), AURA_PREVIEW_STILL_MS);
}

const ready = (async () => {
  // Resolve installed fonts through the local server, including symlinked worktree dependencies.
  const faces = [
    new FontFace('Press Start 2P', 'url(/node_modules/@fontsource/press-start-2p/files/press-start-2p-latin-400-normal.woff2)'),
    new FontFace('Space Grotesk', 'url(/node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2)', { weight: '700' }),
  ];
  for (const face of faces) document.fonts.add(await face.load());
  await document.fonts.ready;
  const keys = ['donald-trump/aura_six_seven', 'template-zero/aura_unbothered'];
  const inputs = await Promise.all(keys.map(async key => {
    const url = `/assets/aura/${key}.png`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Missing social-card atlas: ${key}`);
    const hash = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
    return { key, url, contentHash: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('') };
  }));
  await draw(inputs, '/assets/stages/aura/aura-plaza-v3.webp');
  document.documentElement.dataset.socialCardReady = 'true';
})();
void ready.catch(error => { document.body.textContent = String(error); throw error; });
