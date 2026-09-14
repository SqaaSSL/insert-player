/** One visual mapping for the instrument, touch pads, practice and previews. */
export const AURA_LANES = [
  { tone: 0x4fdced, css: '#4fdced', name: 'Cyan', position: 'left' },
  { tone: 0xb38aff, css: '#b38aff', name: 'Purple', position: 'middle left' },
  { tone: 0xffce3a, css: '#ffce3a', name: 'Yellow', position: 'middle right' },
  { tone: 0xff7777, css: '#ff7777', name: 'Coral', position: 'right' },
] as const;

/** Input capability, not viewport width: narrow desktop windows still need keys. */
export function auraUsesTouchControls(): boolean {
  return typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches ?? false);
}
