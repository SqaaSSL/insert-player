import { describe, expect, it } from 'vitest';
import { httpUrlsInText, textReferencesHostname, textReferencesOrigin } from './url-reference.mjs';

describe('URL reference parsing', () => {
  it('matches an exact origin in structured text', () => {
    expect(textReferencesOrigin(
      "connect-src 'self' https://api.insertplayer.ai https://clerk.insertplayer.ai;",
      'https://api.insertplayer.ai',
    )).toBe(true);
  });

  it('rejects attacker-controlled prefix, suffix, path, and userinfo lookalikes', () => {
    const lookalikes = [
      'https://api.insertplayer.ai.attacker.example',
      'https://attacker.example/api.insertplayer.ai',
      'https://attacker.example?next=https://api.insertplayer.ai',
      'https://api.insertplayer.ai@attacker.example',
    ];

    for (const candidate of lookalikes) {
      expect(textReferencesOrigin(candidate, 'https://api.insertplayer.ai')).toBe(false);
    }
  });

  it('matches forbidden hostnames exactly', () => {
    expect(textReferencesHostname(
      '<link href="https://fonts.googleapis.com/css2?family=Inter">',
      ['fonts.googleapis.com', 'fonts.gstatic.com'],
    )).toBe(true);
    expect(textReferencesHostname(
      '<link href="https://fonts.googleapis.com.attacker.example/css">',
      ['fonts.googleapis.com', 'fonts.gstatic.com'],
    )).toBe(false);
  });

  it('ignores malformed URL-shaped text', () => {
    expect(httpUrlsInText('https://[not-a-host')).toEqual([]);
  });
});
