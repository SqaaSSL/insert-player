import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MobileFightControls } from './MobileFightControls';

describe('MobileFightControls', () => {
  it('labels the controlled player instead of implying every overlay is P1', () => {
    const markup = renderToStaticMarkup(
      <MobileFightControls playerIndex={1} playerLabel="player 2" />,
    );

    expect(markup).toContain('aria-label="player 2 controls"');
    expect(markup).toContain('aria-label="Punch, player 2"');
    expect(markup).not.toContain('Punch, player 1');
  });
});
