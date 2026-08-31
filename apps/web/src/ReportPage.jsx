/**
 * Public plan report — the no-password link the student and mentor open to see
 * their completed academic development plan.
 *
 * The token in the query string is the whole credential (same token that gates
 * the mentor completion page). Read-only: it renders the plan summary embedded,
 * with no wizard and nothing to submit.
 */
import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import * as api from './api.js';
import { AdpDetail, ChecklistView } from './academic.jsx';
import { Btn, Icon } from './atoms.jsx';
import { planChecklistSummary } from './academic-model.js';
import './academic.css';

export function ReportPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const token = params.get('t');

  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState([]); // checklist done-state, by item index
  const [savingProgress, setSavingProgress] = useState(false);
  const [progressSaved, setProgressSaved] = useState(false);

  useEffect(() => {
    if (!token) {
      setError('This link is missing its token.');
      return;
    }
    let live = true;
    api
      .getMentorPlan(id, token)
      .then((p) => {
        if (!live) return;
        setPlan(p);
        setDone((p.plan ?? []).map((i) => !!i.done));
      })
      .catch((e) => live && setError(e.message || 'This link is not valid.'));
    return () => {
      live = false;
    };
  }, [id, token]);

  const toggleAction = (idx) => {
    setDone((d) => d.map((v, i) => (i === idx ? !v : v)));
    setProgressSaved(false);
  };
  async function saveProgress() {
    setSavingProgress(true);
    try {
      await api.setPlanProgress(id, token, { done });
      setProgressSaved(true);
    } catch {
      /* ignore — they can retry */
    }
    setSavingProgress(false);
  }

  if (error) {
    return (
      <div className="mentor-page">
        <div className="mentor-card">
          <h1>Report not available</h1>
          <p className="muted">{error}</p>
          <p className="muted">Please ask the sport office to resend your link.</p>
        </div>
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="mentor-page">
        <div className="mentor-card">
          <div className="muted">Loading the report…</div>
        </div>
      </div>
    );
  }

  if (plan.planStatus !== 'completed') {
    return (
      <div className="mentor-page">
        <div className="mentor-card">
          <div className="mentor-eyebrow">Academic development plan</div>
          <h1>Not ready yet</h1>
          <p>
            The report for <strong>{plan.athleteName}</strong> will appear here once the plan has
            been completed.
          </p>
        </div>
      </div>
    );
  }

  const checkIn = {
    ...plan,
    id,
    token,
    kind: 'adp',
    planStatus: 'completed',
    date: (plan.completedAt ?? '').slice(0, 10),
  };
  const athletes = [
    { studentNumber: plan.studentNumber, faculty: plan.faculty, degree: plan.degree },
  ];

  return (
    <div className="mentor-page report-page">
      <div className="mentor-intro">
        <div className="mentor-eyebrow">Academic development plan · Report</div>
        <h1>
          {plan.athleteName}
          {plan.period ? <span className="muted"> · {plan.period}</span> : null}
        </h1>
        <p className="muted">
          Your academic development plan report — no login needed. You can bookmark this page and
          come back to it any time.
        </p>
      </div>

      {(plan.plan ?? []).length > 0 && (
        <div className="gb-card report-checklist">
          <div className="gb-head">
            <div>
              <strong>{done.filter(Boolean).length}</strong>
              <span className="muted"> / {(plan.plan ?? []).length} actions done</span>
            </div>
            <div className="gb-save-wrap">
              {progressSaved && <span className="gb-saved">Saved ✓</span>}
              <Btn tone="primary" icon={Icon.Check} onClick={saveProgress} disabled={savingProgress}>
                {savingProgress ? 'Saving…' : 'Save my progress'}
              </Btn>
            </div>
          </div>
          <div className="report-checklist-body">
            <p className="muted">
              Tick off each action as you do it — your mentor and the sport office can see your
              progress.
            </p>
            <ChecklistView
              plan={(plan.plan ?? []).map((i, idx) => ({ ...i, done: done[idx] }))}
              onToggle={toggleAction}
            />
          </div>
        </div>
      )}

      <AdpDetail checkIn={checkIn} athletes={athletes} embedded />
    </div>
  );
}
