import { useEffect, useRef } from 'react';
import appMarkup from './appMarkup.html?raw';
import { initLegacyApp } from './legacyApp.js';

/**
 * App is a thin React shell around the original Omkara Data Room app.
 *
 * The original is an imperative, DOM-owning application (querySelector /
 * getElementById / insertAdjacentHTML). To preserve its behaviour exactly,
 * React's job here is narrow and deliberate:
 *
 *   1. Render the original markup ONCE via dangerouslySetInnerHTML. The
 *      container has no React state that changes, so React never re-renders
 *      it — the imperative code keeps full ownership of the DOM it built.
 *   2. After the markup is committed to the DOM, run initLegacyApp(), which
 *      wires events, injects modals, kicks off the first data fetch, etc.
 *
 * initLegacyApp() is internally idempotent, so even if this effect runs
 * twice (React StrictMode in dev), the bootstrap only happens once.
 */
export default function App() {
  const mountedRef = useRef(false);

  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    initLegacyApp();
  }, []);

  return <div id="omkara-root" dangerouslySetInnerHTML={{ __html: appMarkup }} />;
}
