import { VERSUS_INVITE_OG_CSS } from './arcadeChallengeOgStyles.mjs';
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
    css: VERSUS_INVITE_OG_CSS,
  };
}
