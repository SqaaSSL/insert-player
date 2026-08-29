import { useEffect, useRef, useState } from 'react';
import { BrandMark } from './BrandMark.tsx';
import { PUBLIC_APP_NAME } from '../publicBrand.ts';

export interface AppHeaderNavTarget {
  route: '/menu' | '/arcade' | '/gallery' | '/community';
  label: string;
}

const NAV_TARGETS: AppHeaderNavTarget[] = [
  { route: '/menu', label: 'Play' },
  { route: '/arcade', label: 'Arcade' },
  { route: '/gallery', label: 'Gallery' },
  { route: '/community', label: 'Community' },
];

interface AppHeaderProps {
  currentRoute: string;
  onNavigate: (route: '/' | '/menu' | '/arcade' | '/gallery' | '/community') => void;
}

/** Slim cabinet-style top bar on every non-fight screen. The Clerk auth dock
 * renders outside this header: its backdrop-filter would otherwise become the
 * containing block for the dock's fixed bottom-left positioning. */
export function AppHeader({ currentRoute, onNavigate }: AppHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!headerRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    setMenuOpen(false);
  }, [currentRoute]);

  const className = currentRoute === '/menu'
    ? 'app-header app-header--menu'
    : 'app-header';

  return (
    <header className={menuOpen ? `${className} is-menu-open` : className} ref={headerRef}>
      <a
        href="/"
        className="app-header__brand"
        aria-current={currentRoute === '/' ? 'page' : undefined}
        onClick={(event) => {
          event.preventDefault();
          onNavigate('/');
        }}
      >
        <BrandMark size={34} />
        <span>{PUBLIC_APP_NAME}</span>
      </a>
      <button
        type="button"
        className="app-header__burger"
        aria-expanded={menuOpen}
        aria-controls="app-header-nav"
        aria-label={menuOpen ? 'Close menu' : 'Open menu'}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <span aria-hidden="true" />
      </button>
      <nav className="app-header__nav" id="app-header-nav" aria-label="Primary">
        {NAV_TARGETS.map((target) => (
          <a
            key={target.route}
            href={target.route}
            aria-current={currentRoute === target.route ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(target.route);
            }}
          >
            {target.label}
          </a>
        ))}
      </nav>
    </header>
  );
}
