import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FightLoadingCurtain } from './FightLoadingCurtain.tsx';

describe('FightLoadingCurtain', () => {
  it('renders the current matchup while the cabinet is loading', () => {
    const markup = renderToStaticMarkup(
      <FightLoadingCurtain
        phase="loading"
        p1Name="Fran"
        p2Name="Rosalia"
        p1PhotoHash={null}
        p2PhotoHash={null}
        stageLabel="Tablao 3000"
        onExit={vi.fn()}
      />,
    );

    expect(markup).toContain('class="fight-loader is-loading"');
    expect(markup).toContain('FRAN');
    expect(markup).toContain('ROSALIA');
    expect(markup).toContain('TABLAO 3000');
    expect(markup).toContain('PLAYER ONE');
    expect(markup).toContain('PLAYER TWO');
    expect(markup).toContain('INSERTING FIGHTERS');
    expect(markup).not.toContain('Back To Arcade');
  });

  it('offers a way back when the runtime cannot mount', () => {
    const markup = renderToStaticMarkup(
      <FightLoadingCurtain
        phase="error"
        p1Name="Fran"
        p2Name="CPU"
        p1PhotoHash={null}
        p2PhotoHash={null}
        stageLabel="Insert Player Arena"
        onExit={vi.fn()}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('CABINET OFFLINE');
    expect(markup).toContain('Back To Arcade');
  });

  it('identifies the CPU partner and route while Rush is loading', () => {
    const markup = renderToStaticMarkup(
      <FightLoadingCurtain
        phase="loading"
        mode="rush"
        p1Name="Fran"
        p2Name="Byte"
        p1PhotoHash={null}
        p2PhotoHash={null}
        stageLabel="Side Street"
        onExit={vi.fn()}
      />,
    );

    expect(markup).toContain('is-rush');
    expect(markup).toContain('CO-OP RUSH');
    expect(markup).toContain('LOADING SIDE STREET');
    expect(markup).toContain('CPU');
    expect(markup).toContain('>+</i>');
  });
});
