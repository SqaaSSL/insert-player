/** Super-meter economy: every exchange feeds the bar, a full bar buys one
 * SUPER FIREBALL. Values are integers so the sim stays deterministic. */

export const METER_MAX = 100;

/** Super fireball: mid-height (cannot be ducked), unreflectable, faster. */
export const SUPER_FIREBALL_DAMAGE = 110;
export const SUPER_FIREBALL_SPEED_SCALE = 1.45;

export interface MeterExchange {
  blocked: boolean;
  counter?: boolean;
}

/** Meter the attacker earns from landing (or having blocked) an attack. */
export function attackerMeterGain(exchange: MeterExchange): number {
  if (exchange.blocked) return 4;
  return exchange.counter ? 18 : 12;
}

/** Meter the defender earns from eating (or blocking) an attack. */
export function defenderMeterGain(exchange: MeterExchange): number {
  return exchange.blocked ? 3 : 8;
}

/** Meter earned by reflecting a fireball with a standing guard. */
export const REFLECT_METER_GAIN = 10;

export function clampMeter(value: number): number {
  return Math.max(0, Math.min(METER_MAX, Math.round(value)));
}
