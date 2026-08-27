import type { ReactNode } from 'react';
import { BrandMark } from './BrandMark.tsx';
import { PUBLIC_APP_NAME } from '../publicBrand.ts';

export interface AppHeaderNavTarget {
  route: '/menu' | '/gallery' | '/community';
  label: string;
}

const NAV_TARGETS: AppHeaderNavTarget[] = [
  { route: '/menu', label: 'Arcade' },
  { route: '/gallery', label: 'Gallery' },
  { route: '/community', label: 'Community' },
];

interface AppHeaderProps {
  currentRoute: string;
  onNavigate: (route: '/menu' | '/gallery' | '/community') => void;
  authSlot?: ReactNode;
}

/** Slim cabinet-style top bar on every non-fight screen. */
export function AppHeader({ currentRoute, onNavigate, authSlot }: AppHeaderProps) {
  return (
    <header className="app-header">
      <a
        href="/menu"
        className="app-header__brand"
        onClick={(event) => {
          event.preventDefault();
          onNavigate('/menu');
        }}
      >
        <BrandMark size={34} />
        <span>{PUBLIC_APP_NAME}</span>
      </a>
      <nav className="app-header__nav" aria-label="Primary">
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
      <div className="app-header__auth">{authSlot}</div>
    </header>
  );
}
