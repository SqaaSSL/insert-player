import { render, type FontLoader } from 'takumi-js';
import pressStart2P from '@fontsource/press-start-2p/files/press-start-2p-latin-400-normal.woff2';
import spaceGroteskBold from '@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2';
import type { BattleSummary } from '../../src/shared/BattleFinisher';
import type { Env } from './types';
import { publicFrontendOrigin } from './branding';
import { battleStillKey, loadBattle } from './battleMedia';
const fonts: FontLoader[] = [
  { name: 'Press Start 2P', data: pressStart2P, weight: 400 },
  { name: 'Space Grotesk', data: spaceGroteskBold, weight: 700 },
];
export const escapeBattleHtml = (text: string) => text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!);
export async function renderBattleOg(summary: BattleSummary, still: ArrayBuffer): Promise<ArrayBuffer> {
  const winner = summary.winner === 'p2' ? summary.p2Name : summary.winner === 'p1' ? summary.p1Name : summary.winner === 'team' ? 'TEAM WINS' : summary.winner === 'rivals' ? 'RIVALS WIN' : 'WHAT A DUEL';
  const html = `<div class="card"><div class="top">INSERT PLAYER<span>${summary.game.toUpperCase()}</span></div><div class="art"><img src="asset://battle-still"></div><div class="copy"><div class="label">THE FINAL MOMENT</div><div class="winner">${escapeBattleHtml(winner)}</div><div class="versus">${escapeBattleHtml(summary.p1Name)}<br>VS ${escapeBattleHtml(summary.p2Name)}</div><div class="cta">WATCH THE BATTLE ></div></div><div class="footer">YOUR PLAYER. YOUR MOMENT.<span>insertplayer.ai</span></div></div>`;
  const css = `.card{width:1200px;height:630px;background:#10111b;color:#fff4d6;position:relative;overflow:hidden;font-family:"Space Grotesk"}.top{position:absolute;left:44px;right:44px;top:34px;height:48px;font-family:"Press Start 2P";font-size:26px;color:#ffce3a;display:flex;justify-content:space-between;align-items:center}.top span{font-size:16px;color:#fff4d6}.art{position:absolute;left:570px;top:104px;width:588px;height:422px;border:4px solid #ffce3a;overflow:hidden;transform:rotate(-2deg)}.art img{width:580px;height:414px;object-fit:contain;object-position:center top}.copy{position:absolute;left:44px;top:118px;width:490px}.label{font-family:"Press Start 2P";font-size:14px;color:#ffce3a}.winner{font-size:59px;line-height:1.03;margin-top:24px;max-height:186px;overflow:hidden;word-break:break-word;font-weight:700}.versus{font-size:22px;line-height:1.3;margin-top:22px;color:#b9bac9}.cta{display:flex;background:#ffce3a;color:#10111b;font-weight:700;font-size:19px;margin-top:26px;padding:13px 20px;width:280px}.footer{position:absolute;left:44px;right:44px;bottom:35px;border-top:2px solid #343544;padding-top:22px;display:flex;justify-content:space-between;font-size:16px;color:#a8a9b9}.footer span{color:#ffce3a}`;
  const bytes = await render(html, { width: 1200, height: 630, format: 'png', fonts, stylesheets: [css], images: { cache: 'auto', sources: [{ src: 'asset://battle-still', data: still }], allowUrl: () => false }, emoji: 'from-font' });
  return bytes.slice().buffer as ArrayBuffer;
}
export async function battleShareResponse(request: Request, env: Env, id: string, part?: string): Promise<Response> {
  const row = await loadBattle(env, id);
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (!row || row.status !== 'ready' || !row.published || !row.owner_user_id) return new Response('Battle unavailable', { status: 404, headers });
  const summary = JSON.parse(row.summary_json) as BattleSummary;
  if (part === 'og.png') {
    const key = `${row.storage_prefix}og-v1.png`;
    let object = await env.SPRITES.get(key);
    if (!object) {
      const source = await env.SPRITES.get(battleStillKey(row)); if (!source) return new Response('Battle unavailable', { status: 404, headers });
      const image = await renderBattleOg(summary, await source.arrayBuffer());
      await env.SPRITES.put(key, image, { httpMetadata: { contentType: 'image/png', cacheControl: 'private, no-store' } });
      const current = await loadBattle(env, id); if (!current || current.status !== 'ready' || !current.published) { await env.SPRITES.delete(key); return new Response('Battle unavailable', { status: 404, headers }); }
      object = await env.SPRITES.get(key);
    }
    return new Response(request.method === 'HEAD' ? null : object?.body, { headers: { ...headers, 'Content-Type': 'image/png' } });
  }
  const url = `${publicFrontendOrigin(env)}/battles/${id}${part === 'finisher' ? '/finisher' : ''}`;
  const title = `${summary.p1Name} vs ${summary.p2Name} · ${summary.game.toUpperCase()} · Insert Player`;
  const og = `${new URL(request.url).origin}/share/battles/${id}/og.png`;
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeBattleHtml(title)}</title><meta property="og:title" content="${escapeBattleHtml(title)}"><meta property="og:description" content="Watch the final moment on Insert Player. Then take your turn."><meta property="og:type" content="website"><meta property="og:site_name" content="Insert Player"><meta property="og:url" content="${escapeBattleHtml(url)}"><meta property="og:image" content="${escapeBattleHtml(og)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${escapeBattleHtml(og)}"></head><body><h1>${escapeBattleHtml(title)}</h1><a href="${escapeBattleHtml(url)}">Watch on Insert Player</a></body></html>`;
  return new Response(request.method === 'HEAD' ? null : body, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" } });
}
