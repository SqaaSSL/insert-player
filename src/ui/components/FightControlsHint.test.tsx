import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFightControlTracker, type ControlGamepad } from '../shared/fightControlState.ts';
import { useFightControlState } from '../shared/useFightControlState.ts';
import { useArcadeTouchLayout } from '../shared/useArcadeTouchLayout.ts';
import { FightControlsHint } from './FightControlsHint.tsx';

vi.mock('../shared/useFightControlState.ts', () => ({ useFightControlState: vi.fn() }));
vi.mock('../shared/useArcadeTouchLayout.ts', () => ({ useArcadeTouchLayout: vi.fn() }));

beforeEach(() => {
  vi.mocked(useArcadeTouchLayout).mockReturnValue(false);
  vi.mocked(useFightControlState).mockImplementation((mode, twoPlayers) => createFightControlTracker(mode, twoPlayers).getSnapshot());
});

describe('FightControlsHint arcade panel', () => {
  it('places the desktop arcade actions on their real keyboard keys', () => {
    const markup = renderToStaticMarkup(<FightControlsHint />);
    expect(markup).toContain('aria-label="Fight controls"');
    expect(markup).toContain('aria-label="Jump: W"');
    expect(markup).toContain('aria-label="Crouch: S"');
    expect(markup).toContain('arcade-keyboard__joystick');
    expect(markup).toContain('data-key="U" data-action="fireball"');
    expect(markup).toContain('data-key="K" data-action="kick"');
    expect(markup.indexOf('data-action="fireball"')).toBeLessThan(markup.indexOf('data-action="punch"'));
    expect(markup).toContain('aria-label="Punch: J"');
    expect(markup).toContain('aria-label="Kick: K"');
    expect(markup).toContain('aria-label="Guard: L"');
    expect(markup).toContain('aria-label="Guard: G"');
    expect(markup).toContain('Hold Guard · ↓ + Punch or Kick = low attack.');
    expect(markup).not.toContain('Show controls');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('tabindex');
  });

  it('separates Rush lane movement from the dedicated I / Space jump', () => {
    const markup = renderToStaticMarkup(<FightControlsHint mode="rush" />);
    expect(markup).toContain('aria-label="Rush controls"');
    expect(markup).toContain('aria-label="Up: W"');
    expect(markup).toContain('aria-label="Jump: I"');
    expect(markup).toContain('aria-label="Jump: Space"');
    expect(markup).toContain('Hold Guard near a fallen ally to revive.');
    expect(markup).not.toContain('Crouch');
    expect(markup).not.toContain('Uppercut');
    expect(markup).not.toContain('Full meter');
  });

  it('gives both players their own bindings in local versus and co-op', () => {
    const markup = renderToStaticMarkup(<FightControlsHint mode="rush" twoPlayers />);
    expect(markup).toContain('fight-keys--two-players');
    expect(markup).toContain('P1 keyboard controls');
    expect(markup).toContain('P2 keyboard controls');
    expect(markup).toContain('aria-label="Punch: Num 4"');
    expect(markup).toContain('aria-label="Jump: Num 2"');
  });

  it('shows the P1 binding set under P2 for an online guest', () => {
    const markup = renderToStaticMarkup(<FightControlsHint playerLabel="P2" />);
    expect(markup).toContain('P2 keyboard controls');
    expect(markup).toContain('aria-label="Punch: J"');
    expect(markup).not.toContain('Num 4');
  });

  it('lights held directions, button chords and G / Space aliases individually', () => {
    const tracker = createFightControlTracker('rush', true);
    for (const code of [68, 74, 71, 32]) tracker.keyDown(code);
    vi.mocked(useFightControlState).mockReturnValue(tracker.getSnapshot());
    const markup = renderToStaticMarkup(<FightControlsHint mode="rush" twoPlayers />);
    for (const action of ['right', 'punch', 'guard', 'uppercut']) {
      expect(markup).toContain(`data-action="${action}" data-active="true"`);
    }
    expect(markup).toContain('data-action="kick" data-active="false"');
    expect(markup).toContain('aria-label="Guard: L or G, pressed"');
    expect(markup).toContain('aria-label="Jump: I or Space, pressed"');
    expect(markup).toContain('data-x="1" data-y="0"');
  });

  it('renders independent gamepad and keyboard players with the real guard alternatives', () => {
    const tracker = createFightControlTracker('fight', true);
    const pad: ControlGamepad = { axes: [0, 0], buttons: Array.from({ length: 8 }, (_, index) => ({ pressed: index === 5 })) };
    tracker.gamepads([pad]);
    tracker.keyDown(100);
    vi.mocked(useFightControlState).mockReturnValue(tracker.getSnapshot());
    const markup = renderToStaticMarkup(<FightControlsHint twoPlayers />);
    expect(markup).toContain('P1 gamepad controls');
    expect(markup).toContain('P2 keyboard controls');
    expect(markup).toContain('aria-label="Guard: LB / L1, RB / R1, or LT / L2, pressed"');
    expect(markup).toContain('aria-label="Punch: Num 4, pressed"');
    expect(markup).toContain('Stick / D-pad');
  });

  it('replaces the keyboard with one actual touch control set on mobile', () => {
    vi.mocked(useFightControlState).mockReturnValue(createFightControlTracker('rush', false, 'touch').getSnapshot());
    const markup = renderToStaticMarkup(<FightControlsHint mode="rush" />);
    expect(markup).toContain('fight-keys--touch');
    expect(markup).toContain('revive');
    expect(markup).toContain('aria-label="P1 touch controls"');
    expect(markup).toContain('aria-label="Kick, P1"');
    expect(markup).toContain('aria-label="Jump, P1"');
    expect(markup).toContain('fight-keys__touch-stick');
    expect(markup.match(/<button /g)).toHaveLength(10);
    expect(markup).not.toContain('arcade-keyboard');
    expect(markup).not.toContain('fight-keys__players');
  });

  it('makes a narrow viewport clickable even when the last input was keyboard', () => {
    vi.mocked(useArcadeTouchLayout).mockReturnValue(true);
    const markup = renderToStaticMarkup(<FightControlsHint disabled />);
    expect(markup).toContain('P1 touch controls');
    expect(markup.match(/disabled=""/g)).toHaveLength(10);
    expect(markup).toContain('needs a full meter');
    expect(markup).not.toContain('arcade-keyboard');
  });
});
