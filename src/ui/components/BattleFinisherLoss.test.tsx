import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BattleFinisherPanel } from './BattleFinisherPanel.tsx';

const capture = (winner: 'p1' | 'p2') => ({
  clientBattleId: 'battle-client-1234567890', stillBase64: 'AAAA',
  summary: { game: 'fight' as const, winner, p1Name: 'Rosalía', p2Name: 'Donald Trump', stageLabel: 'Executive Rumble', durationSeconds: 60 },
});

describe('BattleFinisherPanel after a loss', () => {
  it('offers the fatality as a quiet link when the player lost', () => {
    const html = renderToStaticMarkup(<BattleFinisherPanel capture={capture('p2') as never} authStatus="signed-out" authSessionKey="guest" />);
    expect(html).toContain('Make a fatality anyway');
    expect(html).not.toContain('asf-btn battle-finisher__offer');
  });
  it('keeps the full offer for a win', () => {
    const html = renderToStaticMarkup(<BattleFinisherPanel capture={capture('p1') as never} authStatus="signed-out" authSessionKey="guest" />);
    expect(html).toContain('asf-btn battle-finisher__offer');
    expect(html).not.toContain('Make a fatality anyway');
  });
});
