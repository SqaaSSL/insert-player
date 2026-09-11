import { useEffect, useRef, useState } from 'react';
import '../menu-music.css';

const PREFERENCE_KEY = 'insert-player-menu-music';
const readPreference = () => { try { return localStorage.getItem(PREFERENCE_KEY) !== 'off'; } catch { return true; } };

/** The cabinet bed lives only outside the game. A rejected autoplay is shown as
 * an invitation, never as an audible state; the next gesture can unlock it. */
export function MenuMusic({ active = true }: { active?: boolean }) {
  const [enabled, setEnabled] = useState(readPreference);
  const [audible, setAudible] = useState(false);
  const wanted = useRef(enabled); wanted.current = enabled;
  const audio = useRef<HTMLAudioElement | null>(null);
  const unlock = useRef<() => void>(() => {});
  useEffect(() => {
    if (!active) return;
    const player = new Audio('/assets/audio/neon-arena-battle-v1.mp3');
    player.loop = true;
    player.preload = 'none';
    player.volume = 0.09;
    audio.current = player;
    let disposed = false;
    let pending = false;
    const play = () => {
      if (disposed || pending || !wanted.current || document.hidden) return;
      pending = true;
      void player.play().then(() => {
        pending = false;
        if (disposed || !wanted.current || document.hidden) { player.pause(); return; }
        setAudible(true);
      }).catch(() => { pending = false; if (!disposed) setAudible(false); });
    };
    unlock.current = play;
    const gesture = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[data-menu-music]')) return;
      play();
    };
    const visibility = () => {
      if (document.hidden) { player.pause(); setAudible(false); }
      else play();
    };
    const failed = () => { if (!disposed) setAudible(false); };
    player.addEventListener('error', failed);
    document.addEventListener('pointerdown', gesture);
    document.addEventListener('keydown', gesture);
    document.addEventListener('visibilitychange', visibility);
    play();
    return () => {
      disposed = true;
      unlock.current = () => {};
      audio.current = null;
      player.pause();
      player.removeAttribute('src');
      player.load();
      document.removeEventListener('pointerdown', gesture);
      document.removeEventListener('keydown', gesture);
      document.removeEventListener('visibilitychange', visibility);
      player.removeEventListener('error', failed);
    };
  }, [active]);
  useEffect(() => {
    if (enabled) unlock.current();
    else { audio.current?.pause(); setAudible(false); }
  }, [enabled]);
  if (!active) return null;
  const toggle = () => {
    // When the browser blocked autoplay, the invitation enables playback instead
    // of toggling an already-enabled preference off on the user's first click.
    const next = !(enabled && audible);
    wanted.current = next;
    setEnabled(next);
    try { localStorage.setItem(PREFERENCE_KEY, next ? 'on' : 'off'); } catch { /* optional preference */ }
    if (next) unlock.current();
    else { audio.current?.pause(); setAudible(false); }
  };
  const label = audible ? 'Menu music on' : enabled ? 'Enable menu music' : 'Menu music off';
  return <button type="button" className={`menu-music${audible ? ' is-playing' : ''}`} data-menu-music
    aria-label={label} aria-pressed={audible} title={label} onClick={toggle}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l11-2v13M9 8l11-2" /><ellipse cx="6" cy="18" rx="3" ry="2" /><ellipse cx="17" cy="16" rx="3" ry="2" /></svg>
    <span>{audible ? 'Music on' : enabled ? 'Enable music' : 'Music off'}</span>
  </button>;
}
