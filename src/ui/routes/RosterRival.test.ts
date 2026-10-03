import { describe, expect, it } from 'vitest';
import { nextRivalKey } from './RosterPage';

const base = { available: ['me', 'trump', 'rosalia'], playerKey: 'me', defaultRivalKey: 'trump', chosenByPlayer: false };

describe('nextRivalKey', () => {
  it('replaces an unchosen mirror once an official has loaded', () => {
    expect(nextRivalKey({ ...base, current: 'me' })).toBe('trump');
  });
  it('keeps a mirror the player picked on purpose', () => {
    expect(nextRivalKey({ ...base, current: 'me', chosenByPlayer: true })).toBe('me');
  });
  it('keeps a mirror while the player is the only fighter available', () => {
    expect(nextRivalKey({ ...base, available: ['me'], current: 'me', defaultRivalKey: 'me' })).toBe('me');
  });
  it('keeps any other valid rival and falls back when the rival disappears', () => {
    expect(nextRivalKey({ ...base, current: 'rosalia' })).toBe('rosalia');
    expect(nextRivalKey({ ...base, current: 'gone' })).toBe('trump');
    expect(nextRivalKey({ ...base, current: null })).toBe('trump');
  });
});
