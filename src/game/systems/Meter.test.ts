import { describe, expect, it } from 'vitest';
import {
  METER_MAX,
  REFLECT_METER_GAIN,
  attackerMeterGain,
  clampMeter,
  defenderMeterGain,
} from './Meter.ts';

describe('super meter economy', () => {
  it('rewards clean hits more than blocked ones for the attacker', () => {
    expect(attackerMeterGain({ blocked: false })).toBeGreaterThan(
      attackerMeterGain({ blocked: true }),
    );
  });

  it('rewards counter hits above normal hits', () => {
    expect(attackerMeterGain({ blocked: false, counter: true })).toBeGreaterThan(
      attackerMeterGain({ blocked: false }),
    );
  });

  it('feeds the defender on both hits and blocks, hits more', () => {
    expect(defenderMeterGain({ blocked: false })).toBeGreaterThan(
      defenderMeterGain({ blocked: true }),
    );
    expect(defenderMeterGain({ blocked: true })).toBeGreaterThan(0);
  });

  it('pays a skill bonus for reflecting a fireball', () => {
    expect(REFLECT_METER_GAIN).toBeGreaterThan(defenderMeterGain({ blocked: true }));
  });

  it('clamps to [0, METER_MAX] and keeps integers', () => {
    expect(clampMeter(-5)).toBe(0);
    expect(clampMeter(9999)).toBe(METER_MAX);
    expect(clampMeter(41.6)).toBe(42);
  });

  it('cannot fill the bar in fewer than four clean counter hits', () => {
    expect(attackerMeterGain({ blocked: false, counter: true }) * 4).toBeLessThanOrEqual(
      METER_MAX,
    );
  });
});
