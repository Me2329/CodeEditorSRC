import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { CodeCraftIDE } from './components/CodeCraftIDE';
import { ErrorBoundary, STORED_KEYS, STORED_PREFIXES } from './components/ErrorBoundary';
// Configures Monaco to load from the bundle rather than a CDN. Imported before
// the IDE so the loader is pointed at the local copy first.
import './lib/monaco-setup';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    {/*
      Inside StrictMode rather than outside it, so the boundary is part of the
      tree being checked rather than a wrapper around it.
    */}
    <ErrorBoundary storageKeys={STORED_KEYS} storagePrefixes={STORED_PREFIXES}>
      <CodeCraftIDE />
    </ErrorBoundary>
  </StrictMode>,
);
