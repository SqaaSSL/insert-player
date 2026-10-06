import { describe, expect, it } from 'vitest';
import { isLowPowerDevice } from './lowPowerDevice.ts';

describe('isLowPowerDevice', () => {
  it('flags a 4 GB phone', () => expect(isLowPowerDevice({ deviceMemory: 4, hardwareConcurrency: 8 }, true)).toBe(true));
  it('flags a 4-core touch device', () => expect(isLowPowerDevice({ hardwareConcurrency: 4 }, true)).toBe(true));
  it('does not flag a 4-core desktop or CI runner', () => expect(isLowPowerDevice({ hardwareConcurrency: 4 }, false)).toBe(false));
  it('does not flag an 8 GB phone', () => expect(isLowPowerDevice({ deviceMemory: 8, hardwareConcurrency: 8 }, true)).toBe(false));
});
