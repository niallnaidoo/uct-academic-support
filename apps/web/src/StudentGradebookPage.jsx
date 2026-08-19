/**
 * Student gradebook — the no-login page where a student records their marks.
 *
 * Their assessment dates come from onboarding (or a teammate who's taken the
 * same module). Three weeks after each assessment, marks are usually out, so the
 * due ones are highlighted and the student is prompted to add them. The table is
 * a familiar gradebook: enter or update a mark per assessment, then save.
 */
import { useState, useEffect, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import * as api from './api.js';
import { Btn, Pill, Icon } from './atoms.jsx';
import { assessmentStatus } from './academic-model.js';
import { formatDeadlineLong } from './format.js';
import './academic.css';

export function StudentGradebookPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const token = params.get('t');

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [marks, setMarks] = useState({});
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => {
    if (!token) {
      setError('This link is missing its token.');
      return;
    }
    let live = true;
    api
      .getGradebook(id, token)
      .then((d) => {
        if (!live) return;
        setData(d);
        const seed = {};
        for (const m of d.modules) for (const a of m.assessments) seed[a.key] = a.mark === '' ? '' : String(a.mark);
        setMarks(seed);
      })
      .catch((e) => live && setError(e.message || 'This link is not valid.'));
    return () => {
      live = false;
    };
  }, [id, token]);

  // Live status + due count as the student types.
  const summary = useMemo(() => {
    if (!data) return { due: 0, recorded: 0, total: 0 };
    let due = 0;
    let recorded = 0;
    let total = 0;
    for (const m of data.modules) {
      for (const a of m.assessments) {
        total++;
        const st = assessmentStatus(a.date, marks[a.key]);
        if (st.key === 'recorded') recorded++;
        else if (st.key === 'due') due++;
      }
    }
    return { due, recorded, total };
  }, [data, marks]);

  function setMark(key, value) {
    // Keep it a plain number 0–100 (allow empty to clear).
    if (value !== '' && !/^\d{0,3}(\.\d?)?$/.test(value)) return;
    if (value !== '' && Number(value) > 100) return;
    setMarks((m) => ({ ...m, [key]: value }));
    setSavedAt(null);
  }

  async function save() {
    setBusy(true);
    try {
      await api.submitGrades(id, token, {
        grades: Object.entries(marks).map(([key, mark]) => ({ key, mark })),
      });
      setSavedAt(Date.now());
    } catch (e) {
      setError(e.message || 'Could not save your marks.');
    }
    setBusy(false);
  }

  if (error) {
    return (
      <div className="mentor-page">
        <div className="mentor-card">
          <h1>Gradebook not available</h1>
          <p className="muted">{error}</p>
          <p className="muted">Please ask the sport office to resend your link.</p>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="mentor-page">
        <div className="mentor-card">
          <div className="muted">Loading your gradebook…</div>
        </div>
      </div>
    );
  }
  if (data.total === 0) {
    return (
      <div className="mentor-page">
        <div className="mentor-card">
          <div className="mentor-eyebrow">Your marks</div>
          <h1>Nothing to record yet</h1>
          <p>
            No assessments are logged for your modules yet. Once dates are captured, they’ll appear
            here for you to add your marks.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mentor-page gradebook-page">
      <div className="mentor-intro">
        <div className="mentor-eyebrow">Your marks</div>
        <h1>{data.athleteName}’s gradebook</h1>
        <p className="muted">
          Add your marks as they come out — no login needed. You can update them any time.
        </p>
      </div>

      {summary.due > 0 && (
        <div className="gb-prompt">
          <Icon.Bell />
          <span>
            <strong>
              {summary.due} assessment{summary.due === 1 ? '' : 's'} ready
            </strong>{' '}
            — the results should be out now. Add your mark{summary.due === 1 ? '' : 's'} below.
          </span>
        </div>
      )}

      <div className="gb-card">
        <div className="gb-head">
          <div>
            <strong>{summary.recorded}</strong>
            <span className="muted"> / {summary.total} recorded</span>
          </div>
          <div className="gb-save-wrap">
            {savedAt && <span className="gb-saved">Saved ✓</span>}
            <Btn tone="primary" icon={Icon.Check} onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save marks'}
            </Btn>
          </div>
        </div>

        <div className="gb-scroll">
          <table className="gradebook">
            <thead>
              <tr>
                <th>Assessment</th>
                <th className="gb-date-col">Date</th>
                <th>Status</th>
                <th className="gb-mark-col">Your mark</th>
              </tr>
            </thead>
            <tbody>
              {data.modules.map((m) => (
                <GradebookModule key={m.code} module={m} marks={marks} onMark={setMark} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="gb-foot">
        <Btn tone="primary" icon={Icon.Check} onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save marks'}
        </Btn>
      </div>
    </div>
  );
}

function GradebookModule({ module: m, marks, onMark }) {
  return (
    <>
      <tr className="gb-modrow">
        <td colSpan={4}>
          <strong>{m.code}</strong>
          {m.name ? <span className="muted"> · {m.name}</span> : null}
        </td>
      </tr>
      {m.assessments.map((a) => {
        const st = assessmentStatus(a.date, marks[a.key]);
        return (
          <tr key={a.key} className={st.key === 'due' ? 'gb-due' : ''}>
            <td>
              {a.label || <span className="muted">Assessment</span>}
              {a.date && <span className="gb-date-sub">{formatDeadlineLong(a.date)}</span>}
            </td>
            <td className="gb-date-col">
              {a.date ? formatDeadlineLong(a.date) : <span className="muted">—</span>}
            </td>
            <td>
              <Pill tone={st.tone}>{st.label}</Pill>
            </td>
            <td className="gb-mark-col">
              <div className="gb-mark">
                <input
                  inputMode="decimal"
                  value={marks[a.key] ?? ''}
                  onChange={(e) => onMark(a.key, e.target.value)}
                  placeholder="—"
                  aria-label={`Mark for ${a.label || 'assessment'}`}
                />
                <span className="gb-pct">%</span>
              </div>
            </td>
          </tr>
        );
      })}
    </>
  );
}
