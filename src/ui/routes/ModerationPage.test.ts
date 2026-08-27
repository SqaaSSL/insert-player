import { describe, expect, it } from 'vitest';
import { isCurrentModerationRequest } from './ModerationPage.tsx';

describe('ModerationPage request epochs', () => {
  it('accepts only the response for the current filter and request epoch', () => {
    expect(isCurrentModerationRequest(4, 4, 'open', 'open')).toBe(true);
    expect(isCurrentModerationRequest(3, 4, 'open', 'open')).toBe(false);
    expect(isCurrentModerationRequest(4, 4, 'open', 'dismissed')).toBe(false);
  });
});
