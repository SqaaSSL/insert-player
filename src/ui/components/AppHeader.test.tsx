import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppHeader } from './AppHeader.tsx';

describe('AppHeader', () => {
  it('marks only the main menu header as redundant on mobile', () => {
    const menuMarkup = renderToStaticMarkup(
      <AppHeader currentRoute="/menu" onNavigate={vi.fn()} />,
    );
    const galleryMarkup = renderToStaticMarkup(
      <AppHeader currentRoute="/gallery" onNavigate={vi.fn()} />,
    );

    expect(menuMarkup).toContain('class="app-header app-header--menu"');
    expect(galleryMarkup).toContain('class="app-header"');
    expect(galleryMarkup).not.toContain('app-header--menu');
  });
});
