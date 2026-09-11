import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AuraStartReady } from './AuraStartReady.tsx';

const props = { playerName: 'Trump', rivalName: 'Rosalía', practiceAvailable: true, onStart: vi.fn() };

describe('Aura start choice', () => {
  it('identifies the player and offers a short, explicit practice before a duel', () => {
    const markup = renderToStaticMarkup(<AuraStartReady {...props} />);
    expect(markup).toContain('Play as Trump');
    expect(markup).toContain('vs Rosalía');
    expect(markup).toContain('Four practice hits, then the duel.');
    expect(markup).toContain('Practice 4 notes');
    expect(markup).toContain('Start duel');
    expect(markup).not.toContain('I’m ready');
  });

  it('lets a new player choose practice or go straight to the duel', () => {
    const onStart = vi.fn();
    const view = AuraStartReady({ ...props, onStart });
    const actions = view.props.children[2].props.children;
    actions[0].props.onClick();
    actions[1].props.onClick();
    expect(onStart.mock.calls).toEqual([[true], [false]]);
  });

  it('keeps practice available for returning players without making it the main action', () => {
    const onStart = vi.fn();
    const view = AuraStartReady({ ...props, practiceRecommended: false, onStart });
    const markup = renderToStaticMarkup(view);
    expect(markup.indexOf('Start duel')).toBeLessThan(markup.indexOf('Practice 4 notes'));
    const actions = view.props.children[2].props.children;
    actions[0].props.onClick();
    actions[1].props.onClick();
    expect(onStart.mock.calls).toEqual([[false], [true]]);
  });

  it('gives matches that cannot practice one direct start action', () => {
    const onStart = vi.fn();
    const view = AuraStartReady({ ...props, practiceAvailable: false, onStart });
    const markup = renderToStaticMarkup(view);
    expect(markup.match(/<button /g)).toHaveLength(1);
    expect(markup).toContain('Start duel');
    expect(markup).not.toContain('practice');
    view.props.children[2].props.children[0].props.onClick();
    expect(onStart).toHaveBeenCalledWith(false);
  });

  it('cannot submit either choice while the start is already in progress', () => {
    const onStart = vi.fn();
    const view = AuraStartReady({ ...props, busy: true, onStart });
    const markup = renderToStaticMarkup(view);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Starting…');
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    for (const button of view.props.children[2].props.children) button.props.onClick();
    expect(onStart).not.toHaveBeenCalled();
  });
});
