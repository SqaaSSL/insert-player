import { useEffect, useState } from 'react';

export const ARCADE_TOUCH_QUERY = '(max-width: 767px), (pointer: coarse)';

/** Landscape phones retain touch controls even above the desktop width breakpoint. */
export function useArcadeTouchLayout(): boolean {
  const [touch, setTouch] = useState(() => typeof window !== 'undefined'
    && Boolean(window.matchMedia?.(ARCADE_TOUCH_QUERY).matches));
  useEffect(() => {
    const media = window.matchMedia?.(ARCADE_TOUCH_QUERY);
    if (!media) return;
    const update = () => setTouch(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return touch;
}
