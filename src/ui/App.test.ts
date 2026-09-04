import { describe, expect, it } from 'vitest';
import { fightExitRoute, gameRouteForMatch, normalizeRoute } from './App';

describe('App route normalization', () => {
  it('preserves valid direct routes', () => {
    expect(normalizeRoute('/', '')).toBe('/');
    expect(normalizeRoute('/fight', '')).toBe('/fight');
    expect(normalizeRoute('/rush', '')).toBe('/rush');
    expect(normalizeRoute('/aura/', '')).toBe('/aura');
    expect(normalizeRoute('/roster/vs/', '')).toBe('/roster/vs');
    expect(normalizeRoute('/roster/rush/', '')).toBe('/roster/rush');
    expect(normalizeRoute('/stages/new', '')).toBe('/stages/new');
    expect(normalizeRoute('/roster/aura/', '')).toBe('/roster/aura');
    expect(normalizeRoute('/roster/aura-vs/', '')).toBe('/roster/aura-vs');
    expect(normalizeRoute('/roster/aura-watch/', '')).toBe('/roster/aura-watch');
  });

  it('falls back to the menu for unknown paths', () => {
    expect(normalizeRoute('/not-a-route', '')).toBe('/menu');
    expect(normalizeRoute('/', '#/community')).toBe('/community');
  });
});

describe('game route selection', () => {
  it('gives every game mode its own public route', () => {
    expect(gameRouteForMatch({ gameMode: 'fight' })).toBe('/fight');
    expect(gameRouteForMatch({ gameMode: 'rush' })).toBe('/rush');
    expect(gameRouteForMatch({ gameMode: 'aura' })).toBe('/aura');
    expect(gameRouteForMatch({})).toBe('/fight');
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
