import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FightHud } from './FightHud';
import type { HudStateDetail } from '../../game/match/MatchConfig.ts';

function makeHudState(overrides: Partial<HudStateDetail> = {}): HudStateDetail {
  return {
    visible: true,
    p1Health: 100,
    p2Health: 40,
    maxHealth: 100,
    p1Meter: 30,
    p2Meter: 100,
    meterMax: 100,
    timer: 87,
    p1Wins: 1,
    p2Wins: 0,
    roundsToWin: 2,
    p1Name: 'Fran',
    p2Name: 'Rival Bot',
    p1Tag: null,
    p2Tag: 'CPU',
    p1PhotoHash: null,
    p2PhotoHash: null,
    matchLabel: 'NEON DOJO · CLASSIC',
    ...overrides,
  };
}

describe('FightHud', () => {
  it('renders both fighters, timer, pips, and proportional health widths', () => {
    const markup = renderToStaticMarkup(<FightHud initialState={makeHudState()} />);

    expect(markup).toContain('class="fight-hud"');
    expect(markup).toContain('FRAN');
    expect(markup).toContain('RIVAL BOT');
    expect(markup).toContain('CPU');
    expect(markup).toContain('>87<');
    expect(markup).toContain('NEON DOJO · CLASSIC');
    // P1 at full health fills the whole 330-wide bar; P2 at 40% fills 132.
    expect(markup).toMatch(/fight-hud__bar-fill fight-hud__bar-fill--ok"[^>]*width="330"/);
    expect(markup).toMatch(/fight-hud__bar-fill fight-hud__bar-fill--ok"[^>]*width="132"/);
    // One round pip won for P1, none for P2.
    expect(markup.match(/fight-hud__pip is-won/g)).toHaveLength(1);
    // P1 bar drains from the outer edge via the mirrored SVG.
    expect(markup).toContain('fight-hud__bar--mirrored');
  });

  it('switches fill class at low health and flags the low timer', () => {
    const markup = renderToStaticMarkup(
      <FightHud initialState={makeHudState({ p2Health: 10, timer: 5 })} />,
    );

    expect(markup).toContain('fight-hud__bar-fill--low');
    expect(markup).toContain('fight-hud__timer--low');
    expect(markup).toContain('>5<');
  });

  it('renders nothing while the HUD is hidden (intro/video sequences)', () => {
    const markup = renderToStaticMarkup(<FightHud initialState={makeHudState({ visible: false })} />);
    expect(markup).toBe('');
  });
});
