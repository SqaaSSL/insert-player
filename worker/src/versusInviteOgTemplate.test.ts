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
    expect(document.css).toContain('.fighter-image { position: absolute; z-index: 4;');
    expect(document.css).toContain('.inviter-plate { position: absolute; z-index: 3;');
  });

  it('escapes inviter and fighter names before placing them in HTML', () => {
    const document = buildVersusInviteOgDocument({
      inviterName: '<script>alert(1)</script>',
      fighterName: '<img src=x onerror=alert(1)>',
      qualityTier: 'rookie',
    });
    expect(document.html).not.toContain('<script>');
    expect(document.html).toContain('&lt;SCRIPT&gt;ALERT(1)&lt;/SCRIPT&gt;');
    expect(document.html).not.toContain('<img src=x onerror');
    expect(document.html).toContain('&lt;IMG SRC=X ONERROR=ALERT(1)&gt;');
  });

  it('scales long names down to stay inside the fight-intro plate', () => {
    const document = buildVersusInviteOgDocument({
      inviterName: 'The Incredibly Long Inviter Display Name For Testing',
      fighterName: 'The Incredibly Long Challenger Name',
      qualityTier: 'contender',
    });
    expect(document.html).toContain('inviter-name--xs');
    expect(document.html).toContain('fighter-name--sm');
    expect(document.html).toContain('THE INCREDIBLY LONG CHALLENGER');
  });
});
