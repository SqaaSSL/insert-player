import { describe, expect, it } from 'vitest';
import { normalizeRoute } from './App';

describe('App route normalization', () => {
  it('preserves valid direct routes', () => {
    expect(normalizeRoute('/', '')).toBe('/');
    expect(normalizeRoute('/fight', '')).toBe('/fight');
    expect(normalizeRoute('/roster/vs/', '')).toBe('/roster/vs');
    expect(normalizeRoute('/roster/rush/', '')).toBe('/roster/rush');
  });

  it('falls back to the menu for unknown paths', () => {
    expect(normalizeRoute('/not-a-route', '')).toBe('/menu');
    expect(normalizeRoute('/', '#/community')).toBe('/community');
  });
});
