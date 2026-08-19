/**
 * Student gradebook — the no-login page where a student records their marks.
 *
 * Their assessment dates come from onboarding (or a teammate who's taken the
 * same module). Three weeks after each assessment, marks are usually out, so the
 * due ones are highlighted and the student is prompted to add them. The student
 * can also add assessments of their own. On submit they get a clear thank-you.
 */
import { useState, useEffect, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import * as api from './api.js';
import { Btn, Pill, Icon } from './atoms.jsx';
import { assessmentStatus, gradeKey } from './academic-model.js';
import { formatDeadlineLong } from './format.js';
import './academic.css';

export function StudentGradebookPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const token = params.get('t');

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [marks, setMarks] = useState({});
  const [added, setAdded] = useState([]); // assessments the student added this visit
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // thank-you state: { recorded, total }

  function seedMarks(d) {
    const seed = {};
    for (const m of d.modules) for (const a of m.assessments) seed[a.key] = a.mark === '' ? '' : String(a.mark);
    return seed;
  }

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
        setMarks(seedMarks(d));
      })
      .catch((e) => live && setError(e.message || 'This link is not valid.'));
    return () => {
      live = false;
    };
  }, [id, token]);

  // The rendered modules = what's on record + anything the student just added.
  const modules = useMemo(() => {
    if (!data) return [];
    const groups = data.modules.map((m) => ({ ...m, assessments: [...m.assessments] }));
    for (const ex of added) {
      let g = groups.find((x) => x.code === ex.code);
      if (!g) {
        g = { code: ex.code, name: ex.name, assessments: [] };
        groups.push(g);
      }
      const key = gradeKey(ex.code, ex.label, ex.date);
      if (!g.assessments.some((a) => a.key === key)) {
        g.assessments.push({ label: ex.label, date: ex.date, key, mark: '', student: true });
      }
    }
    for (const g of groups) g.assessments.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return groups;
  }, [data, added]);

  const summary = useMemo(() => {
    let due = 0;
    let recorded = 0;
    let total = 0;
    for (const m of modules)
      for (const a of m.assessments) {
        total++;
        const st = assessmentStatus(a.date, marks[a.key]);
        if (st.key === 'recorded') recorded++;
        else if (st.key === 'due') due++;
      }
    return { due, recorded, total };
  }, [modules, marks]);

  function setMark(key, value) {
    if (value !== '' && !/^\d{0,3}(\.\d?)?$/.test(value)) return;
    if (value !== '' && Number(value) > 100) return;
    setMarks((m) => ({ ...m, [key]: value }));
  }
  function addAssessment(a) {
    setAdded((xs) => [...xs, a]);
    setAdding(false);
  }

  async function submit() {
    setBusy(true);
    try {
      await api.submitGrades(id, token, {
        grades: Object.entries(marks).map(([key, mark]) => ({ key, mark })),
        newAssessments: added.map((a) => ({ code: a.code, label: a.label, date: a.date })),
      });
      const fresh = await api.getGradebook(id, token);
      setData(fresh);
      setMarks(seedMarks(fresh));
      setAdded([]);
      setDone({ recorded: fresh.recorded, total: fresh.total });
    } catch (e) {
      setError(e.message || 'Could not save your marks.');
    }
    setBusy(false);
  }

  const firstName = (data?.athleteName ?? '').split(' ')[0];

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

  // Thank-you — the clear end-of-submission confirmation.
  if (done) {
    return (
      <div className="mentor-page">
        <div className="mentor-card">
          <div className="gb-thanks-tick">
            <Icon.Check />
          </div>
          <div className="mentor-eyebrow">Your marks</div>
          <h1>Thank you{firstName ? `, ${firstName}` : ''}!</h1>
          <p>
            Your marks are saved — <strong>{done.recorded}</strong> of {done.total} recorded. The
            sport office can see them now.
          </p>
          <p className="muted">
            You can close this page. Come back to this link any time to add more marks as your
            results come out.
          </p>
          <Btn tone="primary" onClick={() => setDone(null)}>
            Back to my gradebook
          </Btn>
        </div>
      </div>
    );
  }

  const empty = summary.total === 0;

  return (
    <div className="mentor-page gradebook-page">
      <div className="mentor-intro">
        <div className="mentor-eyebrow">Your marks</div>
        <h1>{data.athleteName}’s gradebook</h1>
        <p className="muted">
          Add your marks as they come out — no login needed. You can add your own assessments and
          update marks any time.
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
          <Btn tone="primary" icon={Icon.Check} onClick={submit} disabled={busy || empty}>
            {busy ? 'Submitting…' : 'Submit marks'}
          </Btn>
        </div>

        {empty ? (
          <div className="gb-empty">
            <p className="muted">No assessments yet — add your first one below.</p>
          </div>
        ) : (
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
                {modules.map((m) => (
                  <GradebookModule key={m.code} module={m} marks={marks} onMark={setMark} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="gb-add-row">
          {adding ? (
            <AddAssessmentForm
              modules={data.allModules ?? []}
              onAdd={addAssessment}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <button type="button" className="onboard-add-assess" onClick={() => setAdding(true)}>
              <Icon.Plus /> Add an assessment
            </button>
          )}
        </div>
      </div>

      <div className="gb-foot">
        <Btn tone="primary" icon={Icon.Check} onClick={submit} disabled={busy || empty}>
          {busy ? 'Submitting…' : 'Submit marks'}
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

/** Small form to add an assessment of the student's own to the gradebook. */
function AddAssessmentForm({ modules, onAdd, onCancel }) {
  const [code, setCode] = useState(modules[0]?.code ?? '__other');
  const [otherCode, setOtherCode] = useState('');
  const [label, setLabel] = useState('');
  const [date, setDate] = useState('');
  const isOther = code === '__other' || modules.length === 0;
  const finalCode = (isOther ? otherCode : code).trim().toUpperCase();
  const canAdd = finalCode && label.trim();

  return (
    <div className="gb-add-form">
      <div className="gb-add-title">Add an assessment</div>
      <div className="gb-add-grid">
        <label className="fld">
          <span>Module</span>
          {modules.length > 0 ? (
            <select value={code} onChange={(e) => setCode(e.target.value)}>
              {modules.map((m) => (
                <option key={m.code} value={m.code}>
                  {m.code}
                  {m.name ? ` · ${m.name}` : ''}
                </option>
              ))}
              <option value="__other">＋ Another module…</option>
            </select>
          ) : (
            <input value={otherCode} onChange={(e) => setOtherCode(e.target.value.toUpperCase())} placeholder="Code" />
          )}
        </label>
        {isOther && modules.length > 0 && (
          <label className="fld">
            <span>Module code</span>
            <input
              value={otherCode}
              onChange={(e) => setOtherCode(e.target.value.toUpperCase())}
              placeholder="e.g. ECO1010F"
            />
          </label>
        )}
        <label className="fld">
          <span>Assessment name</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Test 2" />
        </label>
        <label className="fld">
          <span>Date (optional)</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <div className="gb-add-foot">
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn
          tone="primary"
          icon={Icon.Plus}
          disabled={!canAdd}
          onClick={() => {
            const m = modules.find((x) => x.code === finalCode);
            onAdd({ code: finalCode, name: m?.name, label: label.trim(), date });
          }}
        >
          Add to gradebook
        </Btn>
      </div>
    </div>
  );
}
