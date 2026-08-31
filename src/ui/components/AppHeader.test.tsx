import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppHeader } from './AppHeader.tsx';

describe('AppHeader', () => {
  it('keeps the main menu header visible like every other app route', () => {
    const menuMarkup = renderToStaticMarkup(
      <AppHeader currentRoute="/menu" onNavigate={vi.fn()} />,
    );
    const galleryMarkup = renderToStaticMarkup(
      <AppHeader currentRoute="/gallery" onNavigate={vi.fn()} />,
    );

    expect(menuMarkup).toContain('class="app-header"');
    expect(menuMarkup).not.toContain('app-header--menu');
    expect(galleryMarkup).toContain('class="app-header"');
    expect(galleryMarkup).not.toContain('app-header--menu');
  });

  it('renders account controls inside the responsive navigation', () => {
    const markup = renderToStaticMarkup(
      <AppHeader
        currentRoute="/menu"
        onNavigate={vi.fn()}
        authSlot={<button type="button">Player account</button>}
      />,
    );

    const navStart = markup.indexOf('<nav');
    const accountStart = markup.indexOf('class="app-header__account"');
    const navEnd = markup.indexOf('</nav>');

    expect(navStart).toBeGreaterThanOrEqual(0);
    expect(accountStart).toBeGreaterThan(navStart);
    expect(navEnd).toBeGreaterThan(accountStart);
    expect(markup).toContain('Player account');
  });
});
