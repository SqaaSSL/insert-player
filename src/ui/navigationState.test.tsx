import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { legalReturnRouteFromState, shouldCommitTrialLaunch } from './App.tsx';
import { resolveAuthBootstrapMode } from './authState.ts';
import { CacheStatusBanner } from './components/CacheStatusBanner.tsx';
import { GenerationConsent } from './components/LegalConsent.tsx';
import { shouldUseSpaNavigation } from './components/LegalFooter.tsx';
import { Modal } from './components/Modal.tsx';

describe('auth and navigation hardening', () => {
  it('allows keyless local auth only in development', () => {
    expect(resolveAuthBootstrapMode('pk_live_example', false)).toBe('clerk');
    expect(resolveAuthBootstrapMode('  ', true)).toBe('local-dev');
    expect(resolveAuthBootstrapMode(undefined, false)).toBe('misconfigured');
  });

  it('accepts only safe app routes as legal return targets', () => {
    expect(legalReturnRouteFromState({ legalReturnTo: '/' })).toBe('/');
    expect(legalReturnRouteFromState({ legalReturnTo: '/arcade' })).toBe('/arcade');
    expect(legalReturnRouteFromState({ legalReturnTo: '/fighters/new' })).toBe('/fighters/new');
    expect(legalReturnRouteFromState({ legalReturnTo: '/fight' })).toBe('/menu');
    expect(legalReturnRouteFromState({ legalReturnTo: 'https://example.com' })).toBe('/menu');
    expect(legalReturnRouteFromState(null)).toBe('/menu');
  });

  it('commits a loaded trial only while the same request still owns the landing route', () => {
    expect(shouldCommitTrialLaunch(4, 4, '/', '')).toBe(true);
    expect(shouldCommitTrialLaunch(4, 5, '/', '')).toBe(false);
    expect(shouldCommitTrialLaunch(4, 4, '/arcade', '')).toBe(false);
    expect(shouldCommitTrialLaunch(4, 4, '/', '#/gallery')).toBe(false);
  });

  it('keeps modified legal-link clicks under native browser control', () => {
    const plainClick = {
      button: 0,
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    };
    expect(shouldUseSpaNavigation(plainClick)).toBe(true);
    expect(shouldUseSpaNavigation({ ...plainClick, metaKey: true })).toBe(false);
    expect(shouldUseSpaNavigation({ ...plainClick, button: 1 })).toBe(false);
  });

  it('opens consent policies separately so an in-progress form stays mounted', () => {
    const markup = renderToStaticMarkup(
      <GenerationConsent checked={false} onChange={vi.fn()} onNavigate={vi.fn()} />,
    );
    expect(markup.match(/target="_blank"/g)).toHaveLength(3);
    expect(markup.match(/rel="noreferrer"/g)).toHaveLength(3);
  });

  it('describes anonymous storage as device-local rather than inventing an account', () => {
    const markup = renderToStaticMarkup(
      <GenerationConsent checked={false} storageMode="device" onChange={vi.fn()} />,
    );
    expect(markup).toContain('privately store this fighter on this device');
    expect(markup).not.toContain('in my Insert Player account');
  });

  it('renders degraded cache recovery as an actionable alert', () => {
    const markup = renderToStaticMarkup(
      <CacheStatusBanner status="degraded" message="Storage failed." onRetry={vi.fn()} />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Storage failed.');
    expect(markup).toContain('Retry Storage');
  });

  it('keeps the shared modal labelled and keyboard-focusable', () => {
    const markup = renderToStaticMarkup(
      <Modal title="Confirm action" onClose={vi.fn()}><p>Details</p></Modal>,
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toMatch(/aria-labelledby="([^"]+)"/);
    expect(markup).toContain('tabindex="-1"');
  });
});
