/**
 * Phones like a Redmi 13C (4 GB, Mali GPU) report deviceMemory <= 4 in
 * Chrome. A low core count only counts on a touch device, so desktops and
 * CI runners with 4 cores are not treated as weak phones.
 */
export function isLowPowerDevice(
  nav: { deviceMemory?: number; hardwareConcurrency?: number } | undefined =
    typeof navigator === 'undefined' ? undefined : navigator as Navigator & { deviceMemory?: number },
  coarsePointer: boolean = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true,
): boolean {
  if (!nav) return false;
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 4) return true;
  return coarsePointer && typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency <= 4;
}
