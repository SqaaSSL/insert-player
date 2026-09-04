import { describe, expect, it } from 'vitest';
import {
  buildVersusInviteOgDocument,
  VERSUS_INVITE_FIGHTER_ASSET_URL,
  VERSUS_INVITE_OG_HEIGHT,
  VERSUS_INVITE_OG_WIDTH,
} from './versusInviteOgTemplate';

describe('versus invitation OG template', () => {
  it('builds the fixed social-card canvas around the selected fighter', () => {
    const document = buildVersusInviteOgDocument({
      inviterName: 'Francisco',
      fighterName: 'Rosalía',
      qualityTier: 'champion',
    });
    expect(VERSUS_INVITE_OG_WIDTH).toBe(1200);
    expect(VERSUS_INVITE_OG_HEIGHT).toBe(630);
    expect(document.html).toContain('FRANCISCO');
    expect(document.html).toContain('ROSALÍA');
    expect(document.html).toContain('CHAMPION');
    expect(document.html).toContain(VERSUS_INVITE_FIGHTER_ASSET_URL);
    expect(document.html).toContain('CHALLENGER');
    expect(document.html).toContain('PRIVATE ONLINE CHALLENGE');
    expect(document.html).toContain('ACCEPT THE CHALLENGE');
    expect(document.html).toContain('WAITING FOR PLAYER 2');
    expect(document.html).toContain('challenge-halo');
    expect(document.html).toContain('challenge-banner');
    expect(document.html).toContain('center-cut');
    expect(document.html).not.toContain('fight-pass');
    expect(document.html).not.toContain('rival-silhouette');
    expect(document.html).not.toContain('rival-question');
    expect(document.css).toContain("font-family: 'Press Start 2P'");
    expect(document.css).toContain('.center-cut');
    expect(document.css).toContain('.challenge-core');
    expect(document.css).toContain('.challenger-intro { position: absolute; z-index: 20; left: 440px;');
    expect(document.css).toContain('width: 320px;');
    expect(document.html).not.toContain('inviter-plate');
  });

  it('escapes inviter and fighter names before placing them in HTML', () => {
    const document = buildVersusInviteOgDocument({
      inviterName: '<script>alert(1)</script>',
      fighterName: '<img src=x onerror=alert(1)>',
      qualityTier: 'rookie',
    });
    expect(document.html).not.toContain('<script>');
    expect(document.html).toContain('<span>&lt;SCRIPT&gt;ALERT</span><span>(1)&lt;/SCRIPT&gt;</span>');
    expect(document.html).not.toContain('<img src=x onerror');
    expect(document.html).toContain('&lt;IMG SRC=X ONERROR=ALERT(1)&gt;');
  });

  it('scales long names down to stay inside the challenger intro', () => {
    const document = buildVersusInviteOgDocument({
      inviterName: 'The Incredibly Long Inviter Display Name For Testing',
      fighterName: 'The Incredibly Long Challenger Name',
      qualityTier: 'contender',
    });
    expect(document.html).toContain('challenger-name--xs');
    expect(document.html).toContain('<span>THE INCREDIBLY LONG INVITER</span><span>DISPLAY NAME FOR TES</span>');
    expect(document.html).toContain('fighter-name--sm');
    expect(document.html).toContain('THE INCREDIBLY LONG CHALLENGER');
  });

  it('balances a real long challenger name inside the central safe lane', () => {
    const document = buildVersusInviteOgDocument({
      inviterName: 'Francisco Novella Fletcher',
      fighterName: 'Player One',
      qualityTier: 'champion',
    });
    expect(document.html).toContain('<span>FRANCISCO</span><span>NOVELLA FLETCHER</span>');
    expect(document.html).toContain('challenger-name--lg');
    expect(document.css).toContain('left: 440px;');
    expect(document.css).toContain('width: 320px;');
  });
});
