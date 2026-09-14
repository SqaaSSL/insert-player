import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AuraStartReady } from './AuraStartReady.tsx';
import { Modal } from './Modal.tsx';

const props = { playerName: 'Trump', rivalName: 'Rosalía', practiceAvailable: true, onStart: vi.fn(), onExit: vi.fn() };
const find = (node: any, className: string): any => {
  if (!node) return undefined;
  if (Array.isArray(node)) return node.map(child => find(child, className)).find(Boolean);
  if (typeof node !== 'object') return undefined;
  if (node.props?.className?.split(' ').includes(className)) return node;
  return find(node.props?.children, className);
};

describe('Aura start choice', () => {
  it('identifies the player and offers a short, explicit practice before a duel', () => {
    const markup = renderToStaticMarkup(<AuraStartReady {...props} />);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('Learn Aura in 4 notes');
    expect(markup).toContain('Play as <strong>Trump</strong>');
    expect(markup).toContain('vs Rosalía');
    expect(markup).toContain('Hit the notes when they reach the line.');
    expect(markup).toContain('Four practice hits, then your duel.');
    expect(markup).toContain('Practice 4 notes');
    expect(markup).toContain('Start duel');
    expect(markup).not.toContain('I’m ready');
  });

  it('lets a new player choose practice or go straight to the duel', () => {
    const onStart = vi.fn();
    const view = AuraStartReady({ ...props, onStart });
    find(view, 'aura-start-ready__primary').props.onClick();
    find(view, 'aura-start-ready__skip').props.onClick();
    expect(onStart.mock.calls).toEqual([[true], [false]]);
  });

  it('keeps practice available for returning players without making it the main action', () => {
    const onStart = vi.fn();
    const view = AuraStartReady({ ...props, practiceRecommended: false, onStart });
    const markup = renderToStaticMarkup(view);
    expect(markup.indexOf('Start duel')).toBeLessThan(markup.indexOf('Practice 4 notes'));
    find(view, 'aura-start-ready__primary').props.onClick();
    find(view, 'aura-start-ready__skip').props.onClick();
    expect(onStart.mock.calls).toEqual([[false], [true]]);
  });

  it('gives matches that cannot practice one direct start action', () => {
    const onStart = vi.fn();
    const view = AuraStartReady({ ...props, practiceAvailable: false, onStart });
    const markup = renderToStaticMarkup(view);
    expect(markup.match(/<button /g)).toHaveLength(2);
    expect(markup).toContain('Start duel');
    expect(markup).not.toContain('practice');
    find(view, 'aura-start-ready__primary').props.onClick();
    expect(onStart).toHaveBeenCalledWith(false);
  });

  it('cannot submit either choice while the start is already in progress', () => {
    const onStart = vi.fn();
    const onExit = vi.fn();
    const view = AuraStartReady({ ...props, busy: true, onStart, onExit });
    const markup = renderToStaticMarkup(view);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Starting…');
    expect(markup.match(/disabled=""/g)).toHaveLength(3);
    for (const className of ['aura-start-ready__primary', 'aura-start-ready__skip', 'aura-start-ready__back']) {
      find(view, className).props.onClick();
    }
    view.props.onClose();
    expect(onStart).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('uses the shared accessible dialog and lets Back or dismissal leave without starting', () => {
    const onExit = vi.fn();
    const onStart = vi.fn();
    const view = AuraStartReady({ ...props, onExit, onStart });
    expect(view.type).toBe(Modal);
    expect(view.props.showClose).toBe(false);
    expect(view.props.title).toBe('Learn Aura in 4 notes');
    find(view, 'aura-start-ready__back').props.onClick();
    view.props.onClose();
    expect(onExit).toHaveBeenCalledTimes(2);
    expect(onStart).not.toHaveBeenCalled();
  });
});
