/**
 * Phones like a Redmi 13C (4 GB, Mali GPU) report deviceMemory <= 4 in
 * Chrome. Used to skip optional per-frame work such as canvas recording.
 */
export function isLowPowerDevice(nav: { deviceMemory?: number; hardwareConcurrency?: number } | undefined =
  typeof navigator === 'undefined' ? undefined : navigator as Navigator & { deviceMemory?: number }): boolean {
  if (!nav) return false;
  const memory = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;
  const cores = typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null;
  return (memory !== null && memory <= 4) || (cores !== null && cores <= 4);
}
