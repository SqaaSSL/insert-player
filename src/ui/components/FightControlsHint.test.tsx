import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FightControlsHint } from './FightControlsHint';

describe('FightControlsHint', () => {
  it('shows useful controls immediately without waiting for an intro event', () => {
    const markup = renderToStaticMarkup(<FightControlsHint />);
    expect(markup).toContain('aria-label="Fight controls"');
    expect(markup).toContain('<kbd>J</kbd><span>Punch</span>');
    expect(markup).toContain('<kbd>K</kbd><span>Kick</span>');
    expect(markup).toContain('<kbd>L</kbd><span>Guard (hold)</span>');
    expect(markup).toContain('<kbd>W</kbd><span>Jump</span>');
    expect(markup).not.toContain('Show controls');
  });

  it('explains lane movement and the dedicated jump in Rush', () => {
    const markup = renderToStaticMarkup(<FightControlsHint mode="rush" />);
    expect(markup).toContain('aria-label="Rush controls"');
    expect(markup).toContain('<kbd>W A S D</kbd><span>Move</span>');
    expect(markup).toContain('<kbd>Space / I</kbd><span>Jump</span>');
    expect(markup).not.toContain('Crouch');
    expect(markup).not.toContain('Uppercut');
    expect(markup).not.toContain('full meter');
  });

  it('gives both players their own bindings in local versus and co-op', () => {
    const markup = renderToStaticMarkup(<FightControlsHint mode="rush" twoPlayers />);
    expect(markup).toContain('P1 keyboard controls');
    expect(markup).toContain('P2 keyboard controls');
    expect(markup).toContain('<kbd>Num 4</kbd><span>Punch</span>');
    expect(markup).toContain('<kbd>Num 2</kbd><span>Jump</span>');
  });

  it('shows the local P1 binding set for an online guest in slot P2', () => {
    const markup = renderToStaticMarkup(<FightControlsHint playerLabel="P2" />);
    expect(markup).toContain('P2 keyboard controls');
    expect(markup).toContain('<kbd>J</kbd><span>Punch</span>');
    expect(markup).not.toContain('Num 4');
  });
});
