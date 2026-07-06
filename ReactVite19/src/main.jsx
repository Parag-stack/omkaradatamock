import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// NOTE: We intentionally do NOT wrap <App /> in <React.StrictMode>.
// StrictMode double-invokes effects in development, which would run the
// imperative bootstrap (event listeners, modal injection, auto-refresh
// timers) twice. The legacy app is also guarded against this, but keeping
// StrictMode off avoids any duplicate side effects in the imperative layer.
createRoot(document.getElementById('root')).render(<App />);
