import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import './ui/styles.css';

const rootEl = document.getElementById('app');

if (!rootEl) {
  throw new Error('Missing #app root element');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
