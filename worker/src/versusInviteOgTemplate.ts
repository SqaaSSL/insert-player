import type { QualityTier } from './types';

export const VERSUS_INVITE_TEMPLATE_VERSION = 'loading-challenge-v7';
export const VERSUS_INVITE_OG_WIDTH = 1200;
export const VERSUS_INVITE_OG_HEIGHT = 630;
export const VERSUS_INVITE_FIGHTER_ASSET_URL = 'asset://insert-player/versus-fighter';

export interface VersusInviteOgCopy {
  inviterName: string;
  fighterName: string;
  qualityTier: QualityTier;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}

function displayText(value: string, fallback: string, maxCharacters: number): string[] {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || fallback;
  return Array.from(normalized).slice(0, maxCharacters);
}

function challengerNameClass(length: number): string {
  if (length <= 10) return 'challenger-name--xl';
  if (length <= 16) return 'challenger-name--lg';
  if (length <= 21) return 'challenger-name--md';
  if (length <= 25) return 'challenger-name--sm';
  return 'challenger-name--xs';
}

function balanceChallengerName(characters: string[]): string[] {
  const name = characters.join('');
  if (characters.length <= 16) return [name];

  const words = name.split(' ').filter(Boolean);
  if (words.length <= 1) {
    const splitAt = Math.ceil(characters.length / 2);
    return [characters.slice(0, splitAt).join(''), characters.slice(splitAt).join('')];
  }

  let best = 1;
  let smallestDifference = Number.POSITIVE_INFINITY;
  for (let index = 1; index < words.length; index++) {
    const firstLength = words.slice(0, index).join(' ').length;
    const secondLength = words.slice(index).join(' ').length;
    const difference = Math.abs(firstLength - secondLength);
    if (difference < smallestDifference) {
      best = index;
      smallestDifference = difference;
    }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

function fighterNameClass(length: number): string {
  if (length <= 14) return 'fighter-name--xl';
  if (length <= 21) return 'fighter-name--lg';
  if (length <= 28) return 'fighter-name--md';
  return 'fighter-name--sm';
}

export function buildVersusInviteOgDocument(copy: VersusInviteOgCopy): { html: string; css: string } {
  const inviterCharacters = displayText(copy.inviterName, 'Player', 48);
  const fighterCharacters = displayText(copy.fighterName, 'Fighter', 32);
  const inviterLines = balanceChallengerName(inviterCharacters);
  const inviterLineLength = Math.max(...inviterLines.map((line) => Array.from(line).length));
  const inviterName = inviterLines
    .map((line) => `<span>${escapeHtml(line.toUpperCase())}</span>`)
    .join('');
  const fighterName = escapeHtml(fighterCharacters.join('').toUpperCase());
  const qualityTier = escapeHtml(copy.qualityTier.toUpperCase());

  return {
    html: `<div class="canvas">
      <div class="red-field"></div>
      <div class="blue-field"></div>
      <div class="red-energy red-energy--one"></div>
      <div class="red-energy red-energy--two"></div>
      <div class="blue-energy blue-energy--one"></div>
      <div class="blue-energy blue-energy--two"></div>

      <section class="fighter-stage">
        <img class="fighter-image" src="${VERSUS_INVITE_FIGHTER_ASSET_URL}" />
        <div class="fighter-wash"></div>
        <div class="fighter-caption">
          <div class="fighter-meta">THEIR FIGHTER · ${qualityTier}</div>
          <div class="fighter-name ${fighterNameClass(fighterCharacters.length)}">${fighterName}</div>
        </div>
      </section>

      <section class="challenge-stage">
        <div class="challenge-grid"></div>
        <div class="challenge-cross challenge-cross--horizontal"></div>
        <div class="challenge-cross challenge-cross--vertical"></div>
        <div class="challenge-halo">
          <div class="challenge-ring challenge-ring--outer"></div>
          <div class="challenge-ring challenge-ring--middle"></div>
          <div class="challenge-core">
            <div class="seat-kicker">PLAYER TWO</div>
            <div class="seat-number">P2</div>
            <div class="seat-status">SEAT OPEN</div>
          </div>
          <div class="challenge-banner">CHALLENGE</div>
        </div>
        <div class="challenge-copy">
          <div class="challenge-action">ACCEPT THE CHALLENGE</div>
          <div class="challenge-instruction">OPEN THE LINK · CHOOSE YOUR FIGHTER</div>
        </div>
        <div class="challenge-corner challenge-corner--tl"></div>
        <div class="challenge-corner challenge-corner--tr"></div>
        <div class="challenge-corner challenge-corner--bl"></div>
        <div class="challenge-corner challenge-corner--br"></div>
      </section>

      <div class="center-shadow"></div>
      <div class="center-cut"></div>

      <header class="challenger-intro">
        <div class="challenger-kicker">YOUR CHALLENGER</div>
        <div class="challenger-name ${challengerNameClass(inviterLineLength)}">${inviterName}</div>
        <div class="challenger-mode">PRIVATE ONLINE CHALLENGE</div>
      </header>

      <section class="versus-lockup">
        <div class="brand-mark">P1</div>
        <div class="brand-name">INSERT PLAYER</div>
        <div class="versus-copy"><span>V</span><b>S</b></div>
        <div class="versus-status">WAITING FOR PLAYER 2</div>
        <div class="loading-dots"><i></i><i></i><i></i><i></i></div>
      </section>

      <div class="scanlines"></div>
      <footer class="footer"><span>INSERTPLAYER.AI</span><span>ONE LINK · ONE RIVAL · ONE FIGHT</span></footer>
    </div>`,
    css: `
      * { box-sizing: border-box; }
      .canvas {
        position: relative;
        width: 1200px;
        height: 630px;
        overflow: hidden;
        color: #fff8df;
        background: #05050d;
        font-family: 'Space Grotesk';
      }
      .red-field {
        position: absolute;
        z-index: 0;
        inset: 0 auto 0 0;
        width: 665px;
        background:
          radial-gradient(circle at 27% 44%, rgba(164,18,29,0.84) 0%, rgba(76,5,13,0.72) 43%, rgba(17,2,8,0.98) 82%),
          linear-gradient(112deg, #700910, #18030a);
      }
      .blue-field {
        position: absolute;
        z-index: 0;
        inset: 0 0 0 auto;
        width: 665px;
        background:
          radial-gradient(circle at 72% 42%, rgba(26,79,165,0.78) 0%, rgba(9,29,77,0.76) 45%, rgba(5,6,20,0.98) 84%),
          linear-gradient(110deg, #050617, #11285b);
      }
      .red-energy, .blue-energy { position: absolute; z-index: 2; height: 2px; opacity: 0.64; }
      .red-energy { background: #ef3542; box-shadow: 0 0 14px rgba(243,45,61,0.5); transform: rotate(-8deg); }
      .blue-energy { background: #3fb4ff; box-shadow: 0 0 14px rgba(54,174,255,0.48); transform: rotate(-8deg); }
      .red-energy--one { left: -80px; top: 178px; width: 720px; }
      .red-energy--two { left: -65px; top: 210px; width: 460px; opacity: 0.24; }
      .blue-energy--one { right: -100px; bottom: 103px; width: 745px; }
      .blue-energy--two { right: -45px; bottom: 139px; width: 430px; opacity: 0.24; }

      .fighter-stage { position: absolute; z-index: 3; left: 0; top: 0; width: 632px; height: 630px; overflow: hidden; }
      .fighter-image { position: absolute; z-index: 0; left: -8px; top: 0; width: 672px; height: 630px; object-fit: cover; object-position: center top; }
      .fighter-wash { position: absolute; z-index: 1; inset: 0; background: linear-gradient(90deg, rgba(104,4,13,0.34) 0%, rgba(63,3,12,0.06) 56%, rgba(6,3,10,0.72) 100%); }
      .fighter-caption { position: absolute; z-index: 4; left: 31px; bottom: 47px; width: 465px; }
      .fighter-meta { margin-bottom: 9px; color: rgba(255,248,223,0.76); font-family: 'Press Start 2P'; font-size: 7px; letter-spacing: 1px; }
      .fighter-name { color: #ff3d49; font-family: 'Press Start 2P'; line-height: 1.22; letter-spacing: -1px; text-shadow: 4px 4px 0 #741019, 0 0 14px rgba(255,52,66,0.28); }
      .fighter-name--xl { font-size: 28px; }
      .fighter-name--lg { font-size: 22px; }
      .fighter-name--md { font-size: 17px; }
      .fighter-name--sm { font-size: 13px; }

      .challenge-stage { position: absolute; z-index: 3; right: 0; top: 0; width: 627px; height: 630px; overflow: hidden; }
      .challenge-grid { position: absolute; inset: 56px 0 34px; opacity: 0.12; background-image: linear-gradient(90deg, rgba(76,185,255,0.5) 1px, transparent 1px), linear-gradient(180deg, rgba(76,185,255,0.5) 1px, transparent 1px); background-size: 58px 58px; transform: perspective(420px) rotateX(58deg) translateY(230px) scale(1.28); }
      .challenge-cross { position: absolute; z-index: 2; background: rgba(72,181,255,0.22); box-shadow: 0 0 12px rgba(72,181,255,0.22); }
      .challenge-cross--horizontal { left: 102px; right: 34px; top: 287px; height: 1px; }
      .challenge-cross--vertical { top: 89px; bottom: 120px; left: 364px; width: 1px; }
      .challenge-halo { position: absolute; z-index: 5; right: 68px; top: 111px; width: 350px; height: 350px; }
      .challenge-ring { position: absolute; border-radius: 999px; }
      .challenge-ring--outer { inset: 0; border: 2px solid rgba(76,185,255,0.66); box-shadow: 0 0 26px rgba(50,155,255,0.18), inset 0 0 26px rgba(50,155,255,0.12); }
      .challenge-ring--middle { inset: 25px; border: 2px dashed rgba(255,197,47,0.48); }
      .challenge-core { position: absolute; z-index: 3; left: 72px; top: 72px; width: 206px; height: 206px; display: flex; flex-direction: column; align-items: center; justify-content: center; border: 3px solid #55bcff; border-radius: 999px; background: radial-gradient(circle, rgba(18,55,112,0.94), rgba(5,8,25,0.98) 72%); box-shadow: 0 0 28px rgba(61,174,255,0.24), inset 0 0 24px rgba(70,180,255,0.12); }
      .seat-kicker, .seat-status { color: rgba(224,242,255,0.68); font-family: 'Press Start 2P'; font-size: 7px; letter-spacing: 2px; }
      .seat-number { margin: 13px 0 10px; color: #5cc1ff; font-family: 'Press Start 2P'; font-size: 58px; line-height: 0.88; letter-spacing: -5px; text-shadow: 5px 5px 0 #073c70; }
      .seat-status { color: #ffc52f; }
      .challenge-banner { position: absolute; z-index: 7; left: 3px; top: 225px; width: 344px; height: 57px; display: flex; align-items: center; justify-content: center; border: 2px solid #ffc52f; background: #c51e2b; color: #fff8df; font-family: 'Press Start 2P'; font-size: 20px; letter-spacing: 2px; text-shadow: 3px 3px 0 #5f0810; box-shadow: 7px 7px 0 rgba(3,4,13,0.72); }
      .challenge-copy { position: absolute; z-index: 7; right: 42px; bottom: 49px; width: 465px; text-align: right; }
      .challenge-action { color: #56bdff; font-family: 'Press Start 2P'; font-size: 21px; line-height: 1.3; letter-spacing: -1px; text-shadow: 4px 4px 0 #073d72; }
      .challenge-instruction { margin-top: 11px; color: rgba(225,242,255,0.66); font-family: 'Press Start 2P'; font-size: 7px; letter-spacing: 1px; }
      .challenge-corner { position: absolute; z-index: 5; width: 35px; height: 35px; border-color: rgba(85,188,255,0.62); }
      .challenge-corner--tl { left: 145px; top: 92px; border-left: 2px solid; border-top: 2px solid; }
      .challenge-corner--tr { right: 35px; top: 92px; border-right: 2px solid; border-top: 2px solid; }
      .challenge-corner--bl { left: 145px; bottom: 120px; border-left: 2px solid; border-bottom: 2px solid; }
      .challenge-corner--br { right: 35px; bottom: 120px; border-right: 2px solid; border-bottom: 2px solid; }

      .center-shadow { position: absolute; z-index: 12; left: 568px; top: -55px; width: 62px; height: 735px; background: rgba(3,3,9,0.72); transform: rotate(5deg); box-shadow: 0 0 28px rgba(0,0,0,0.82); }
      .center-cut { position: absolute; z-index: 14; left: 598px; top: -55px; width: 5px; height: 735px; background: #fff8df; transform: rotate(5deg); box-shadow: 0 0 12px rgba(255,248,223,0.48); }
      .challenger-intro { position: absolute; z-index: 20; left: 440px; top: 18px; width: 320px; min-height: 88px; padding: 9px 14px 11px; text-align: center; background: radial-gradient(ellipse at center, rgba(4,5,15,0.96) 0%, rgba(4,5,15,0.9) 62%, transparent 100%); }
      .challenger-kicker { color: #f13b47; font-family: 'Press Start 2P'; font-size: 7px; letter-spacing: 2px; }
      .challenger-name { margin-top: 7px; color: #fff8df; font-family: 'Press Start 2P'; line-height: 1.24; letter-spacing: -1px; text-shadow: 3px 3px 0 #4d0b12; }
      .challenger-name span { display: block; white-space: nowrap; }
      .challenger-name--xl { font-size: 20px; }
      .challenger-name--lg { font-size: 16px; }
      .challenger-name--md { font-size: 13px; }
      .challenger-name--sm { font-size: 11px; }
      .challenger-name--xs { font-size: 9px; }
      .challenger-mode { margin-top: 6px; color: #ffc52f; font-family: 'Press Start 2P'; font-size: 7px; letter-spacing: 1px; }
      .versus-lockup { position: absolute; z-index: 22; left: 502px; top: 218px; width: 202px; display: flex; flex-direction: column; align-items: center; text-align: center; }
      .brand-mark { width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; border: 3px solid #fff8df; border-radius: 999px; background: #d92331; color: #fff8df; font-size: 14px; font-weight: 700; box-shadow: 3px 3px 0 rgba(0,0,0,0.7); }
      .brand-name { margin-top: 12px; padding: 8px 10px 7px; background: rgba(4,4,11,0.86); color: #fff8df; font-family: 'Press Start 2P'; font-size: 10px; letter-spacing: 1px; white-space: nowrap; }
      .versus-copy { display: flex; margin-top: 7px; font-family: 'Press Start 2P'; font-size: 55px; line-height: 0.9; letter-spacing: -11px; }
      .versus-copy span { color: #ff3945; text-shadow: 4px 4px 0 #781019; }
      .versus-copy b { color: #50baff; text-shadow: 4px 4px 0 #073f75; }
      .versus-status { margin-top: 12px; color: #ffc52f; font-family: 'Press Start 2P'; font-size: 7px; letter-spacing: 1px; white-space: nowrap; }
      .loading-dots { display: flex; gap: 6px; margin-top: 12px; }
      .loading-dots i { display: block; width: 8px; height: 8px; background: #9f7b22; }
      .loading-dots i:nth-child(2) { background: #c89827; }
      .loading-dots i:nth-child(3) { background: #ffc52f; }
      .loading-dots i:nth-child(4) { background: #4eb8ff; }
      .scanlines { position: absolute; z-index: 31; inset: 0; opacity: 0.075; background-image: repeating-linear-gradient(180deg, rgba(255,255,255,0.25) 0px, rgba(255,255,255,0.25) 1px, transparent 1px, transparent 5px); }
      .footer { position: absolute; z-index: 32; left: 0; right: 0; bottom: 0; height: 27px; display: flex; align-items: center; justify-content: space-between; padding: 0 22px; border-top: 1px solid rgba(199,138,22,0.28); background: rgba(4,4,11,0.88); color: rgba(255,248,223,0.46); font-family: 'Press Start 2P'; font-size: 6px; letter-spacing: 1px; }
      .footer span:first-child { color: #ffc52f; }
    `,
  };
}
