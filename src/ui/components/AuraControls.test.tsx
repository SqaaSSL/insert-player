import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuraControls } from './AuraControls.tsx';
import { AURA_INPUT_EVENT } from '../../game/match/MatchConfig.ts';

afterEach(() => vi.unstubAllGlobals());

describe('Aura touch controls', () => {
  it('renders four accessible controls for the selected performer', () => {
    const markup = renderToStaticMarkup(<AuraControls playerIndex={1} disabled />);
    expect(markup).toContain('Aura controls, player 2');
    expect(markup.match(/disabled=""/g)).toHaveLength(4);
    for (const label of ['Circle', 'Diamond', 'Square', 'Triangle']) expect(markup).toContain(`aria-label="${label}"`);
  });
  it('judges pointer contact once, but also supports keyboard activation', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    const button = AuraControls({ playerIndex: 1 }).props.children[2];
    const preventDefault = vi.fn();
    button.props.onPointerDown({ preventDefault });
    button.props.onClick({ detail: 1 });
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls[0][0].type).toBe(AURA_INPUT_EVENT);
    expect(dispatchEvent.mock.calls[0][0].detail).toEqual({ lane: 2, playerIndex: 1 });
    button.props.onClick({ detail: 0 });
    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    expect(preventDefault).toHaveBeenCalledOnce();
  });
  it('cannot submit a paused input through either handler', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    const button = AuraControls({ disabled: true }).props.children[0];
    button.props.onPointerDown({ preventDefault: vi.fn() });
    button.props.onClick({ detail: 0 });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
