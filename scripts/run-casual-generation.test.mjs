import { describe, expect, it, vi } from 'vitest';
import { casualRuntimeEnvironment } from './run-casual-generation.mjs';

describe('Casual dedicated Meterkey credential wrapper', () => {
  it('reads only the dedicated credential and forwards it to both transports', () => {
    const readCredential = vi.fn(() => 'dedicated-fixture'), validateCredential = vi.fn();
    const environment = { PATH: '/fixture', FAL_API_KEY: 'forbidden-legacy', GEMINI_API_KEY: 'forbidden-legacy', METERKEY_API_KEY: 'unapproved-inherited' };
    const result = casualRuntimeEnvironment(['--execute'], { environment, readCredential, validateCredential });
    expect(readCredential).toHaveBeenCalledOnce();
    expect(validateCredential).toHaveBeenCalledWith('dedicated-fixture', { keyFingerprint: '08d594f84f67aa9c6f2e5b571fcf61f275e32d03d9fb77418777af71482c5502' });
    expect(result).toEqual({ PATH: '/fixture', CASUAL_GENERATION_CREDENTIALS_READY: '1', CASUAL_GEMINI_TRANSPORT: 'meterkey',
      CASUAL_GEMINI_KEY: 'dedicated-fixture', CASUAL_FAL_METERKEY_KEY: 'dedicated-fixture' });
    expect(environment.FAL_API_KEY).toBe('forbidden-legacy');
  });
  it('does not access credentials for dry runs and rejects legacy credential options', () => {
    const readCredential = vi.fn(() => { throw new Error('must not access'); });
    expect(casualRuntimeEnvironment(['--phase=canary'], { environment: {}, readCredential })).toEqual({});
    for (const argument of ['--credentials-file=/old/.env', '--google-direct']) {
      expect(() => casualRuntimeEnvironment(['--execute', argument], { readCredential })).toThrow('Direct provider credentials are disabled');
    }
    expect(readCredential).not.toHaveBeenCalled();
  });
  it('fails closed on keychain failure or a credential fingerprint mismatch', () => {
    expect(() => casualRuntimeEnvironment(['--execute'], { readCredential: () => { throw new Error('keychain unavailable'); } })).toThrow('keychain');
    expect(() => casualRuntimeEnvironment(['--execute'], { readCredential: () => 'wrong-key' })).toThrow('approved Insert Player');
  });
});
