/**
 * UCT Academic Support — standalone app shell.
 *
 * Routes: the admin module (behind a login — only administrators use the
 * platform), the public student onboarding link (/onboard), and the public
 * mentor completion link (/mentor/:id). A HashRouter keeps deep links working on
 * a static GitHub Pages host.
 */
import { StrictMode, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { queryClient, qk } from './query.js';
import * as api from './api.js';
import { IS_DEMO, resetDemo } from './api.js';
import { AcademicModule } from './academic.jsx';
import { MentorPlanPage } from './MentorPlanPage.jsx';
import { StudentOnboardingPage } from './StudentOnboardingPage.jsx';
import { ReportPage } from './ReportPage.jsx';
import './app.css';

const ADMIN_KEY = 'uct-academic-admin';
/** Demo access — a stand-in for the real Cognito sign-in the dev team wires up. */
const DEMO_PASSWORD = 'ikeys';

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

/** Administrator sign-in. Only administrators reach the platform. */
function AdminLogin({ onAuthed }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);

  function submit(e) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      return setError('Enter a valid email address.');
    if (IS_DEMO ? password !== DEMO_PASSWORD : !password)
      return setError('That password is not correct.');
    try {
      localStorage.setItem(ADMIN_KEY, JSON.stringify({ email: email.trim(), at: Date.now() }));
    } catch {
      /* private mode — session-only is fine */
    }
    onAuthed(email.trim());
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="login-mark">UCT</span>
          <div>
            <div className="login-title">Academic Support</div>
            <div className="login-sub">Administrator sign-in</div>
          </div>
        </div>
        <label className="fld">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@ikeys.uct.ac.za"
            autoFocus
          />
        </label>
        <label className="fld">
          <span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <button className="btn btn-primary login-btn" type="submit">
          Sign in
        </button>
        {IS_DEMO && (
          <p className="login-demo">
            Demo access — any email, password <code>{DEMO_PASSWORD}</code>. Production wires UCT
            single sign-on.
          </p>
        )}
      </form>
    </div>
  );
}

function AdminApp() {
  const [authed, setAuthed] = useState(() => {
    try {
      return !!localStorage.getItem(ADMIN_KEY);
    } catch {
      return false;
    }
  });

  if (!authed) return <AdminLogin onAuthed={() => setAuthed(true)} />;

  function signOut() {
    try {
      localStorage.removeItem(ADMIN_KEY);
    } catch {
      /* ignore */
    }
    setAuthed(false);
  }

  return <AdminShell onSignOut={signOut} />;
}

function AdminShell({ onSignOut }) {
  const [toast, toastNode] = useToasts();
  const { data: settings } = useQuery({ queryKey: qk.settings(), queryFn: api.getSettings });
  const brand = settings
    ? `${settings.orgShort || settings.orgName || ''} ${settings.programmeName || 'Academic Support'}`.trim()
    : 'Academic Support';
  const sub = settings?.sport ? `${settings.sport} · academic tracking` : 'Student-athlete academic tracking';

  return (
    <div className="app-shell">
      <header className="app-bar">
        <div className="app-brand">
          {brand}
          <span className="app-brand-sub">{sub}</span>
        </div>
        <div className="app-bar-right">
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
          <button className="app-signout" onClick={onSignOut}>
            Sign out
          </button>
        </div>
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
          <Route path="/onboard" element={<StudentOnboardingPage />} />
          <Route path="/mentor/:id" element={<MentorPlanPage />} />
          <Route path="/report/:id" element={<ReportPage />} />
          <Route path="*" element={<AdminApp />} />
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>,
);
