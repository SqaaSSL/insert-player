import { describe, expect, it } from 'vitest';
import {
  clearPendingCheckout,
  consumePendingCheckout,
  expectedCheckoutBalance,
  readPendingCheckout,
  rememberPendingCheckout,
} from './checkoutStatus';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe('pending checkout state', () => {
  it('is scoped to the auth session and consumed once', () => {
    const storage = new MemoryStorage();
    const pending = { packId: 'starter', credits: 20, balanceBefore: 5 };
    rememberPendingCheckout(pending, 'user-a', storage, 1_000);

    expect(consumePendingCheckout('user-b', storage, 1_001)).toBeNull();
    expect(consumePendingCheckout('user-a', storage, 1_001)).toEqual(pending);
    expect(consumePendingCheckout('user-a', storage, 1_001)).toBeNull();
  });

  it('can be read without consuming during Strict Mode effect replay', () => {
    const storage = new MemoryStorage();
    const pending = { packId: 'starter', credits: 20, balanceBefore: 5 };
    rememberPendingCheckout(pending, 'user-a', storage, 1_000);

    expect(readPendingCheckout('user-a', storage, 1_001)).toEqual(pending);
    expect(readPendingCheckout('user-a', storage, 1_002)).toEqual(pending);
  });

  it('does not claim a target balance when the starting balance is unknown', () => {
    expect(expectedCheckoutBalance({ packId: 'starter', credits: 20, balanceBefore: 5 })).toBe(25);
    expect(expectedCheckoutBalance({ packId: 'starter', credits: 20, balanceBefore: null })).toBeNull();
  });

  it('clears only the current session pending checkout', () => {
    const storage = new MemoryStorage();
    const pending = { packId: 'starter', credits: 20, balanceBefore: 5 };
    rememberPendingCheckout(pending, 'user-a', storage, 1_000);
    rememberPendingCheckout(pending, 'user-b', storage, 1_000);
    clearPendingCheckout('user-a', storage);

    expect(consumePendingCheckout('user-a', storage, 1_001)).toBeNull();
    expect(consumePendingCheckout('user-b', storage, 1_001)).toEqual(pending);
  });
});
