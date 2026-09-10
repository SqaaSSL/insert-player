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
    expect(markup).toContain('aria-label="Uppercut, player 2"');
    expect(markup).not.toContain('Punch, player 1');
  });

  it('turns the uppercut input into an explicit jump control for Rush', () => {
    const markup = renderToStaticMarkup(
      <MobileFightControls mode="rush" playerLabel="player 1" />,
    );

    expect(markup).toContain('aria-label="Jump, player 1"');
    expect(markup).toContain('is-jump');
    expect(markup).not.toContain('aria-label="Uppercut, player 1"');
  });
});

describe('Persistent touch layout', () => {
  it('keeps the super button in its slot before Fight meter is full', () => {
    const markup = renderToStaticMarkup(<MobileFightControls />);
    expect(markup).toMatch(/class="mobile-fight-control is-super"[^>]*disabled=""/);
    expect(markup).toContain('Charge meter');
    for (const label of ['Punch', 'Kick', 'Guard', 'Fireball', 'Uppercut', 'Super']) {
      expect(markup).toContain(`<span>${label}</span>`);
    }
    expect(markup).toContain('Drag to move');
  });

  it('makes Rush super available without waiting for Fight HUD meter events', () => {
    const markup = renderToStaticMarkup(<MobileFightControls mode="rush" />);
    expect(markup).toContain('is-super');
    expect(markup).not.toContain('disabled');
    expect(markup).toContain('Use the Jump button to jump');
    expect(markup).not.toContain('down to crouch');
  });
});
