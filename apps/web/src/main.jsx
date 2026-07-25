/**
 * UCT Academic Support — standalone app shell.
 *
 * Two routes: the admin module (roster, tracker, development plans, mentors,
 * interventions, dashboard) and the public /mentor/:id completion page. Uses a
 * HashRouter so deep mentor links survive a static GitHub Pages host.
 */
import { StrictMode, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './query.js';
import { IS_DEMO, resetDemo } from './api.js';
import { AcademicModule } from './academic.jsx';
import { MentorPlanPage } from './MentorPlanPage.jsx';
import './app.css';

function useToasts() {
  const [items, setItems] = useState([]);
  const toast = useCallback((message, kind = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setItems((xs) => [...xs, { id, message, kind }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3200);
  }, []);
  const node = (
    <div className="toast-stack">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'err' ? 'toast-err' : ''}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
  return [toast, node];
}

function AdminApp() {
  const [toast, toastNode] = useToasts();
  return (
    <div className="app-shell">
      <header className="app-bar">
        <div className="app-brand">
          UCT Academic Support
          <span className="app-brand-sub">Student-athlete academic tracking</span>
        </div>
        {IS_DEMO && (
          <div className="demo-flag">
            Demo — data is stored in your browser
            <button
              className="demo-reset"
              onClick={() => {
                if (window.confirm('Reset the demo to its seeded data?')) {
                  resetDemo();
                  window.location.reload();
                }
              }}
            >
              Reset
            </button>
          </div>
        )}
      </header>
      <main className="main app-main">
        <AcademicModule toast={toast} />
      </main>
      {toastNode}
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Routes>
          <Route path="/mentor/:id" element={<MentorPlanPage />} />
          <Route path="*" element={<AdminApp />} />
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>,
);
