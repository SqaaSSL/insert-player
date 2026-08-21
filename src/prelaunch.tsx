import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PrelaunchApp } from './ui/PrelaunchApp.tsx';
import '@fontsource/press-start-2p/latin-400.css';
import './ui/styles.css';

const rootEl = document.getElementById('app');

if (!rootEl) {
  throw new Error('Missing #app root element');
}

createRoot(rootEl).render(
  <StrictMode>
    <PrelaunchApp />
  </StrictMode>,
);
