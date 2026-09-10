import type { ReactElementLike } from 'takumi-js';
import { VERSUS_INVITE_OG_CSS } from './arcadeChallengeOgStyles.mjs';

export const AURA_CHALLENGE_OG_VERSION = 'aura-versus-v2';
export const AURA_CHALLENGE_OG_WIDTH = 1200;
export const AURA_CHALLENGE_OG_HEIGHT = 630;
export const AURA_CHALLENGE_OG_ART_URL = 'asset://insert-player/aura-six-seven-og-v2';

function element(type: string, className: string, ...children: (ReactElementLike | string)[]): ReactElementLike {
  return { type, props: { className, children } };
}

/** Break long public names at a word boundary, or at the middle for one word. */
function nameLines(name: string): string[] {
  const characters = Array.from(name);
  if (characters.length <= 16) return [name];
  const middle = Math.ceil(characters.length / 2);
  let split = middle;
  for (let offset = 0; offset <= 5; offset++) {
    if (characters[middle - offset] === ' ') { split = middle - offset; break; }
    if (characters[middle + offset] === ' ') { split = middle + offset; break; }
  }
  return [characters.slice(0, split).join('').trim(), characters.slice(split).join('').trim()];
}

export function buildAuraChallengeOgDocument(input: { name: string; score: number; difficulty: string }): { node: ReactElementLike; css: string } {
  const score = input.score.toLocaleString('en-US');
  const scoreClass = score.length > 15 ? 'score-compact' : score.length > 10 ? 'score-small' : score.length > 7 ? 'score-medium' : '';
  const lines = nameLines(input.name);
  const nameClass = Math.max(...lines.map(line => Array.from(line).length)) > 16 ? 'name-small' : '';
  const e = element;
  return {
    // The image is representative Aura artwork, not the sender's private fighter.
    // Chosen names stay text nodes, including any HTML-looking characters.
    node: e('div', 'canvas aura-invite',
      e('div', 'red-field'), e('div', 'blue-field'),
      e('div', 'red-energy red-energy--one'), e('div', 'red-energy red-energy--two'),
      e('div', 'blue-energy blue-energy--one'), e('div', 'blue-energy blue-energy--two'),
      e('div', 'fighter-stage',
        e('div', 'performer-halo'),
        { type: 'img', props: { className: 'fighter-image', src: AURA_CHALLENGE_OG_ART_URL } },
        e('div', 'fighter-wash'),
        e('div', 'aura-label', 'AURA DUEL'),
        e('div', 'fighter-caption', e('div', 'score-label', 'AURA TO BEAT'), e('div', `aura-score ${scoreClass}`, score))),
      e('div', 'challenge-stage',
        e('div', 'challenge-grid'),
        e('div', 'challenge-cross challenge-cross--horizontal'), e('div', 'challenge-cross challenge-cross--vertical'),
        e('div', 'challenge-halo',
          e('div', 'challenge-ring challenge-ring--outer'), e('div', 'challenge-ring challenge-ring--middle'),
          e('div', 'challenge-core', e('div', 'seat-kicker', 'PLAYER TWO'), e('div', 'seat-number', 'P2'), e('div', 'seat-status', 'YOUR TURN')),
          e('div', 'challenge-banner', 'BEAT MY AURA')),
        e('div', 'challenge-copy', e('div', 'challenge-action', 'ACCEPT THE CHALLENGE'), e('div', 'challenge-instruction', 'SAME SONG · SAME MOVES · PLAY FREE')),
        ...['tl', 'tr', 'bl', 'br'].map(corner => e('div', `challenge-corner challenge-corner--${corner}`))),
      e('div', 'center-shadow'), e('div', 'center-cut'),
      e('div', 'challenger-intro', e('div', 'challenger-kicker', 'CHALLENGE FROM'),
        e('div', `challenger-name ${nameClass}`, ...lines.map(line => e('span', '', line))), e('div', 'challenger-mode', 'CAN YOU TOP THIS?')),
      e('div', 'versus-lockup', e('div', 'brand-mark', 'P1'), e('div', 'brand-name', 'INSERT PLAYER'),
        e('div', 'versus-copy', e('span', '', 'V'), e('b', '', 'S')), e('div', 'versus-status', 'AURA CHALLENGE'),
        e('div', 'rhythm-dots', e('i', 'note-cyan'), e('i', 'note-violet'), e('i', 'note-gold'), e('i', 'note-red'))),
      e('div', 'scanlines'),
      e('div', 'footer', e('span', '', 'insertplayer.ai'), e('span', '', 'FRIENDLY CHALLENGE · YOUR TURN TO SHINE'))),
    css: `${VERSUS_INVITE_OG_CSS}
      .aura-invite .fighter-image{left:-88px;top:35px;width:780px;height:1040px;object-fit:contain;object-position:center top}
      .aura-invite .fighter-wash{background:linear-gradient(0deg,rgba(12,2,8,.99) 0%,rgba(20,3,10,.8) 16%,rgba(20,3,10,0) 35%),linear-gradient(90deg,rgba(90,4,13,.12) 0%,rgba(6,3,10,0) 72%,rgba(6,3,10,.62) 100%)}
      .performer-halo{position:absolute;left:86px;top:140px;width:360px;height:360px;border:2px solid rgba(255,179,48,.28);border-radius:999px;box-shadow:0 0 40px rgba(255,119,26,.13),inset 0 0 30px rgba(255,119,26,.1)}
      .aura-label{position:absolute;z-index:4;top:31px;left:32px;font-family:'Press Start 2P';font-size:15px;color:#ffc52f;text-shadow:3px 3px 0 #4d0b12}
      .aura-invite .challenger-name{font-size:16px;line-height:1.3}
      .aura-invite .challenger-name.name-small{font-size:13px}
      .aura-invite .challenger-intro{left:411px;width:378px;top:18px}
      .aura-invite .challenger-kicker{font-size:8px}
      .aura-invite .challenger-mode{font-size:8px}
      .aura-invite .fighter-caption{bottom:55px;width:475px}
      .score-label{font-family:'Press Start 2P';font-size:11px;color:#ffb853;letter-spacing:1px;margin-bottom:13px}
      .aura-score{font-family:'Press Start 2P';font-size:58px;color:#fff8df;line-height:1.12;letter-spacing:-2px;text-shadow:4px 4px 0 #781019}
      .aura-score.score-medium{font-size:43px}.aura-score.score-small{font-size:30px}.aura-score.score-compact{font-size:22px;letter-spacing:-1px}
      .aura-invite .challenge-banner{font-size:18px;letter-spacing:0}
      .aura-invite .brand-name{font-size:12px;letter-spacing:.5px}
      .aura-invite .versus-status{font-size:8px;letter-spacing:0}
      .aura-invite .seat-status{font-size:9px}
      .aura-invite .challenge-instruction{font-size:8px;letter-spacing:0}
      .aura-invite .footer{font-size:8px;letter-spacing:0}
      .rhythm-dots{display:flex;gap:6px;margin-top:14px}
      .rhythm-dots i{width:14px;height:7px;border:1px solid #fff8df}
      .note-cyan{background:#4fdced}.note-violet{background:#b28aff}.note-gold{background:#ffce3a}.note-red{background:#ff6474}
    `,
  };
}
