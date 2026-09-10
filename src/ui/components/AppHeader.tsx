import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BrandMark } from './BrandMark.tsx';
import { PUBLIC_APP_NAME } from '../publicBrand.ts';

export interface AppHeaderNavTarget {
  route: '/menu' | '/gallery' | '/challenges' | '/credits' | '/community';
  label: string;
}

const NAV_TARGETS: AppHeaderNavTarget[] = [
  { route: '/menu', label: 'Play' },
  { route: '/gallery', label: 'My characters' },
  { route: '/challenges', label: 'Challenges' },
];

interface AppHeaderProps {
  currentRoute: string;
  onNavigate: (route: '/' | '/menu' | '/gallery' | '/challenges' | '/credits' | '/community') => void;
  authSlot?: ReactNode;
}

/** Slim cabinet-style top bar on every non-fight screen. Account controls share
 * the desktop row and become the final section of the collapsed mobile nav. */
export function AppHeader({ currentRoute, onNavigate, authSlot }: AppHeaderProps) {
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

  return (
    <header className={menuOpen ? 'app-header is-menu-open' : 'app-header'} ref={headerRef}>
      <a
        href="/"
        className="app-header__brand"
        aria-current={currentRoute === '/' ? 'page' : undefined}
        onClick={(event) => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
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
              if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
              onNavigate(target.route);
            }}
          >
            {target.label}
          </a>
        ))}
        <a href="/credits" onClick={(event) => { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); onNavigate('/credits'); }}>Credits</a>
        {authSlot ? <div className="app-header__account">{authSlot}</div> : null}
      </nav>
    </header>
  );
}
