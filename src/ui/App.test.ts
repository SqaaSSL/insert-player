import { describe, expect, it } from 'vitest';
import { fightExitRoute, normalizeRoute } from './App';

describe('App route normalization', () => {
  it('preserves valid direct routes', () => {
    expect(normalizeRoute('/', '')).toBe('/');
    expect(normalizeRoute('/fight', '')).toBe('/fight');
    expect(normalizeRoute('/roster/vs/', '')).toBe('/roster/vs');
    expect(normalizeRoute('/roster/rush/', '')).toBe('/roster/rush');
    expect(normalizeRoute('/stages/new', '')).toBe('/stages/new');
  });

  it('falls back to the menu for unknown paths', () => {
    expect(normalizeRoute('/not-a-route', '')).toBe('/menu');
    expect(normalizeRoute('/', '#/community')).toBe('/community');
  });
});

describe('fight exit route', () => {
  it('returns online players to the online lobby', () => {
    expect(fightExitRoute({
      online: { roomCode: 'ABCD', localSlot: 0, matchSerial: 3, inputDelay: 2 },
    })).toBe('/versus/online');
  });

  it('preserves the landing return for trials and Play for offline matches', () => {
    expect(fightExitRoute({ experience: 'trial' })).toBe('/');
    expect(fightExitRoute(null)).toBe('/menu');
  });
});
