import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/base.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/screens.css';
import './styles/calendar.css';
import './styles/transitions.css';
import { App } from './App';
import { registerSW } from 'virtual:pwa-register';
import { bootAppearance, PrefsProvider } from './lib/prefs';
import { installViewport } from './lib/viewport';

bootAppearance();
installViewport();

// the app shell opens offline once the worker has installed (production builds only)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  registerSW({ immediate: true });
  void navigator.storage?.persisted?.().then((p) => {
    if (!p) void navigator.storage?.persist?.();
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrefsProvider>
      <App />
    </PrefsProvider>
  </StrictMode>,
);
