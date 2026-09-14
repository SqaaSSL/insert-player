import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createFightControlTracker } from '../shared/fightControlState.ts';
import { ArcadeKeyboard } from './ArcadeKeyboard.tsx';

describe('ArcadeKeyboard', () => {
  it('puts arcade controls on their real QWERTY keys and labels the moves', () => {
    const tracker = createFightControlTracker('fight', false);
    const markup = renderToStaticMarkup(<ArcadeKeyboard mode="fight" playerIndex={0} playerLabel="P1" state={tracker.getSnapshot().players[0]} />);
    const firstRow = markup.slice(markup.indexOf('arcade-keyboard__row--0'), markup.indexOf('arcade-keyboard__row--1'));
    const secondRow = markup.slice(markup.indexOf('arcade-keyboard__row--1'), markup.indexOf('arcade-keyboard__row--2'));
    expect(firstRow).toContain('aria-label="Jump: W"');
    expect(firstRow).toContain('aria-label="Fireball: U"');
    expect(firstRow).toContain('aria-label="Uppercut: I"');
    expect(firstRow).toContain('aria-label="Super: O"');
    expect(secondRow).toContain('aria-label="Punch: J"');
    expect(secondRow).toContain('aria-label="Kick: K"');
    expect(secondRow).toContain('aria-label="Guard: L"');
    expect(markup).toContain('arcade-keyboard__stick-ball');
    expect(markup).not.toContain('<button');
  });

  it('reflects movement and Rush aliases while keeping the mode-specific labels correct', () => {
    const tracker = createFightControlTracker('rush', false);
    for (const code of [68, 32, 71]) tracker.keyDown(code);
    const markup = renderToStaticMarkup(<ArcadeKeyboard mode="rush" playerIndex={0} playerLabel="P2" state={tracker.getSnapshot().players[0]} />);
    expect(markup).toContain('aria-label="P2 keyboard controls"');
    expect(markup).toContain('aria-label="Up: W"');
    expect(markup).toContain('aria-label="Jump: I, pressed"');
    expect(markup).toContain('aria-label="Jump: Space, pressed"');
    expect(markup).toContain('aria-label="Guard: G, pressed"');
    expect(markup).toContain('aria-label="Guard: L, pressed"');
    expect(markup).toContain('data-x="1" data-y="0"');
    expect(markup).not.toContain('Uppercut');
    expect(markup).not.toContain('Crouch');
  });

  it('uses arrow and numpad geography for the second local player', () => {
    const tracker = createFightControlTracker('fight', true);
    tracker.keyDown(100);
    const markup = renderToStaticMarkup(<ArcadeKeyboard mode="fight" playerIndex={1} playerLabel="P2" state={tracker.getSnapshot().players[1]} />);
    expect(markup).toContain('arcade-keyboard--numpad');
    expect(markup).toContain('aria-label="Punch: Num 4, pressed"');
    expect(markup).toContain('aria-label="Kick: Num 1"');
    expect(markup).toContain('aria-label="Fireball: Num 5"');
    expect(markup).toContain('aria-label="Jump: ↑"');
    expect(markup).not.toContain('aria-label="Punch: J"');
  });
});
