/**
 * Student self-onboarding — the public link the sport office sends to a student.
 *
 * No login: the student captures their details and screens their modules (class
 * times + assessment dates). Everything they type for a module is saved against
 * the course code, so the next student taking the same module gets it pre-filled
 * — the office only ever captures a module once. On submit the athlete is created
 * (or updated) and lands on the roster, ready for a development plan.
 */
import { useState, useEffect, useRef } from 'react';
import * as api from './api.js';
import { Btn, Card, Icon } from './atoms.jsx';
import { FACULTIES, DEGREES_BY_FACULTY, YEARS_OF_STUDY } from './academic-model.js';
import {
  lookupCourse,
  moduleDifficulty,
  courseSuggestions,
  normaliseCode,
  CATALOGUE_SIZE,
} from './course-catalogue.js';
import './screener.css';
import './academic.css';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayIndex = (d) => DAYS.indexOf(d);
/** A readable "Mon 09:00, Wed 09:00" string from structured sessions. */
const sessionsToText = (sessions) =>
  (sessions ?? []).map((s) => `${s.day} ${s.time}`).join(', ');
const sortSessions = (sessions) =>
  [...sessions].sort((a, b) => dayIndex(a.day) - dayIndex(b.day) || a.time.localeCompare(b.time));

let seq = 0;
const rowId = () => `m${(seq += 1)}`;
const blankModule = () => ({ _id: rowId(), code: '', name: '', sessions: [], assessments: [], _auto: false });

export function StudentOnboardingPage() {
  const [profiles, setProfiles] = useState({});
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    studentNumber: '',
    faculty: '',
    degree: '',
    yearOfStudy: '',
    consent: false,
  });
  const [modules, setModules] = useState([blankModule()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  useEffect(() => {
    api.getModuleProfiles().then(setProfiles).catch(() => setProfiles({}));
  }, []);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const degrees = form.faculty ? DEGREES_BY_FACULTY[form.faculty] : [];

  const addModule = () => setModules((ms) => [...ms, blankModule()]);
  const removeModule = (id) => setModules((ms) => (ms.length === 1 ? ms : ms.filter((m) => m._id !== id)));
  const patchModule = (id, patch) =>
    setModules((ms) => ms.map((m) => (m._id === id ? { ...m, ...patch } : m)));

  // Typing a code fills the title/convener/credits/difficulty from the catalogue,
  // AND — the key trick — pre-fills class times + assessment dates from whatever a
  // previous student already captured for this exact module.
  function onCode(id, value) {
    setModules((ms) =>
      ms.map((m) => {
        if (m._id !== id) return m;
        const course = lookupCourse(value);
        const diff = moduleDifficulty(value);
        const profile = profiles[normaliseCode(value)];
        const next = { ...m, code: value, _prefilled: false };
        if (course && (!m.name || m._auto)) {
          next.name = course.title;
          next._auto = true;
        } else if (!course && m._auto) {
          next.name = '';
          next._auto = false;
        }
        next.convener = course?.convener || undefined;
        next.credits = course?.credits ?? undefined;
        next.faculty = course?.faculty || undefined;
        next.nqf = course?.nqf ?? undefined;
        next.difficulty = diff ? diff.level : undefined;
        // Auto-populate the shared per-module detail if the student hasn't typed any.
        if (profile) {
          const emptySessions = !(m.sessions ?? []).length;
          const emptyAssess = !(m.assessments ?? []).length;
          if (emptySessions && profile.sessions?.length) {
            next.sessions = profile.sessions.map((s) => ({ ...s }));
          }
          if (emptyAssess && profile.assessments?.length) {
            next.assessments = profile.assessments.map((a) => ({ ...a }));
          }
          next._prefilled =
            (emptySessions && !!profile.sessions?.length) ||
            (emptyAssess && !!profile.assessments?.length);
        }
        return next;
      }),
    );
  }

  const addAssessment = (id) =>
    setModules((ms) =>
      ms.map((m) =>
        m._id === id ? { ...m, assessments: [...(m.assessments ?? []), { label: '', date: '' }] } : m,
      ),
    );
  const setAssessment = (id, i, patch) =>
    setModules((ms) =>
      ms.map((m) =>
        m._id === id
          ? { ...m, assessments: m.assessments.map((a, j) => (j === i ? { ...a, ...patch } : a)) }
          : m,
      ),
    );
  const removeAssessment = (id, i) =>
    setModules((ms) =>
      ms.map((m) => (m._id === id ? { ...m, assessments: m.assessments.filter((_, j) => j !== i) } : m)),
    );

  async function submit(e) {
    e?.preventDefault();
    if (!form.firstName.trim() || !form.lastName.trim())
      return setError('Please enter your name and surname.');
    if (!form.studentNumber.trim()) return setError('Please enter your student number.');
    const real = modules.filter((m) => m.code.trim());
    if (!real.length) return setError('Add at least one module.');
    setBusy(true);
    setError(null);
    try {
      const athlete = await api.submitOnboarding({
        firstName: form.firstName,
        lastName: form.lastName,
        studentNumber: form.studentNumber,
        faculty: form.faculty || undefined,
        degree: form.degree || undefined,
        yearOfStudy: form.yearOfStudy || undefined,
        consent: form.consent,
        modules: real.map((m) => ({
          code: m.code,
          name: m.name,
          convener: m.convener,
          credits: m.credits,
          faculty: m.faculty,
          nqf: m.nqf,
          difficulty: m.difficulty,
          sessions: sortSessions(m.sessions ?? []),
          times: sessionsToText(m.sessions) || undefined,
          assessments: (m.assessments ?? []).filter((a) => a.date || a.label),
        })),
      });
      setDone({ name: `${athlete.firstName} ${athlete.lastName}`, modules: real.length });
    } catch (err) {
      setError(err.message || 'Something went wrong — please try again.');
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="mentor-page">
        <div className="mentor-card">
          <div className="mentor-eyebrow">Academic support</div>
          <h1>You’re all set, {done.name.split(' ')[0]}.</h1>
          <p>
            Thanks — we’ve registered you with <strong>{done.modules}</strong> module
            {done.modules === 1 ? '' : 's'}. The sport office has your details and will be in touch
            about your academic development plan.
          </p>
          <p className="muted" style={{ fontSize: 13 }}>
            You can close this page now.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mentor-page onboard-page">
      <div className="mentor-intro">
        <div className="mentor-eyebrow">Academic support · Student registration</div>
        <h1>Let’s get you set up</h1>
        <p className="muted">
          A couple of details and the modules you’re taking this semester. It takes about two
          minutes — no login needed.
        </p>
      </div>

      <form onSubmit={submit} className="onboard-form">
        <Card title="Your details" sub="So we know who you are.">
          <div className="fld-row">
            <label className="fld">
              <span>First name</span>
              <input value={form.firstName} onChange={(e) => set({ firstName: e.target.value })} />
            </label>
            <label className="fld">
              <span>Surname</span>
              <input value={form.lastName} onChange={(e) => set({ lastName: e.target.value })} />
            </label>
            <label className="fld">
              <span>Student number</span>
              <input
                value={form.studentNumber}
                onChange={(e) => set({ studentNumber: e.target.value.toUpperCase() })}
                placeholder="e.g. NKSSIP001"
                autoCapitalize="characters"
              />
            </label>
          </div>
          <div className="fld-row">
            <label className="fld">
              <span>Faculty (optional)</span>
              <select value={form.faculty} onChange={(e) => set({ faculty: e.target.value, degree: '' })}>
                <option value="">—</option>
                {FACULTIES.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
            <label className="fld">
              <span>Degree (optional)</span>
              <select
                value={form.degree}
                onChange={(e) => set({ degree: e.target.value })}
                disabled={!form.faculty}
              >
                <option value="">—</option>
                {degrees.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </label>
            <label className="fld">
              <span>Year (optional)</span>
              <select value={form.yearOfStudy} onChange={(e) => set({ yearOfStudy: e.target.value })}>
                <option value="">—</option>
                {YEARS_OF_STUDY.map((y) => (
                  <option key={y}>{y}</option>
                ))}
              </select>
            </label>
          </div>
        </Card>

        <Card
          title="Your modules this semester"
          sub={`Add each module — start typing the code and the name fills in from the ${CATALOGUE_SIZE.toLocaleString()} UCT courses. Class times and assessment dates you add are shared, so a module already captured by a teammate fills in automatically.`}
        >
          <div className="onboard-modules">
            {modules.map((m, i) => (
              <ModuleCapture
                key={m._id}
                index={i + 1}
                module={m}
                canRemove={modules.length > 1}
                onCode={(v) => onCode(m._id, v)}
                onField={(patch) => patchModule(m._id, patch)}
                onRemove={() => removeModule(m._id)}
                onAddAssessment={() => addAssessment(m._id)}
                onAssessment={(idx, patch) => setAssessment(m._id, idx, patch)}
                onRemoveAssessment={(idx) => removeAssessment(m._id, idx)}
              />
            ))}
          </div>
          <Btn icon={Icon.Plus} onClick={addModule} style={{ marginTop: 12 }}>
            Add another module
          </Btn>
        </Card>

        <label className="onboard-consent">
          <input
            type="checkbox"
            checked={form.consent}
            onChange={(e) => set({ consent: e.target.checked })}
          />
          <span>
            I agree that the sport office can use these details to support me academically.
          </span>
        </label>

        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}

        <div className="onboard-foot">
          <Btn tone="primary" icon={Icon.Check} type="submit" disabled={busy}>
            {busy ? 'Submitting…' : 'Finish registration'}
          </Btn>
        </div>
      </form>
    </div>
  );
}

function ModuleCapture({
  index,
  module: m,
  canRemove,
  onCode,
  onField,
  onRemove,
  onAddAssessment,
  onAssessment,
  onRemoveAssessment,
}) {
  const listId = useRef(`oc-${rowId()}`).current;
  const suggestions = courseSuggestions(m.code);
  return (
    <div className="onboard-mod">
      <div className="onboard-mod-head">
        <span className="onboard-mod-n">{index}</span>
        <input
          className="module-code"
          value={m.code}
          list={listId}
          onChange={(e) => onCode(e.target.value)}
          placeholder="Code — e.g. ECO1010F"
          autoCapitalize="characters"
        />
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s.code} value={s.code}>
              {s.title}
            </option>
          ))}
        </datalist>
        <button
          type="button"
          className="icon-btn onboard-mod-x"
          onClick={onRemove}
          aria-label="Remove module"
          disabled={!canRemove}
        >
          <Icon.X />
        </button>
      </div>
      <input
        className="module-name onboard-mod-name"
        value={m.name}
        onChange={(e) => onField({ name: e.target.value, _auto: false })}
        placeholder="Module name (fills in automatically)"
      />
      {(m.convener || m.credits != null) && (
        <div className="module-meta">
          {m.faculty && <span>{m.faculty}</span>}
          {m.credits != null && <span>{m.credits} credits</span>}
          {m.convener && <span>Convener: {m.convener}</span>}
        </div>
      )}

      <div className="onboard-mod-body">
        <ClassTimesField
          sessions={m.sessions ?? []}
          prefilled={m._prefilled && !!(m.sessions ?? []).length}
          onChange={(sessions) => onField({ sessions, _prefilled: false })}
        />

        <div className="onboard-assess">
          <div className="onboard-assess-label">
            <span>Assessment dates</span>
            {m._prefilled && !!(m.assessments ?? []).length && (
              <span className="auto-tag" title="Filled in from a teammate">auto-filled</span>
            )}
          </div>
          {(m.assessments ?? []).map((a, i) => (
            <div key={i} className="onboard-assess-row">
              <input
                className="onboard-assess-name"
                value={a.label}
                onChange={(e) => onAssessment(i, { label: e.target.value })}
                placeholder="e.g. Test 1 / Assignment 2"
              />
              <input
                type="date"
                className="onboard-assess-date"
                value={a.date}
                onChange={(e) => onAssessment(i, { date: e.target.value })}
              />
              <button
                type="button"
                className="icon-btn"
                onClick={() => onRemoveAssessment(i)}
                aria-label="Remove assessment"
              >
                <Icon.X />
              </button>
            </div>
          ))}
          <button type="button" className="onboard-add-assess" onClick={onAddAssessment}>
            <Icon.Plus /> Add an assessment date
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Class times as tappable chips — the student picks the day(s) and a time in a
 * little pop-up instead of typing a free-text string. Much easier on a phone.
 */
function ClassTimesField({ sessions, prefilled, onChange }) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState([]);
  const [time, setTime] = useState('');

  const toggleDay = (d) => setDays((ds) => (ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d]));
  const reset = () => {
    setDays([]);
    setTime('');
    setOpen(false);
  };
  const add = () => {
    if (!days.length || !time) return;
    const next = [...sessions];
    for (const d of days) {
      if (!next.some((s) => s.day === d && s.time === time)) next.push({ day: d, time });
    }
    onChange(sortSessions(next));
    reset();
  };
  const remove = (i) => onChange(sessions.filter((_, j) => j !== i));

  return (
    <div className="ct-field">
      <div className="onboard-assess-label">
        <span>Class times</span>
        {prefilled && (
          <span className="auto-tag" title="Filled in from a teammate">
            auto-filled
          </span>
        )}
      </div>
      <div className="ct-chips">
        {sessions.map((s, i) => (
          <span key={`${s.day}-${s.time}-${i}`} className="ct-chip">
            {s.day} {s.time}
            <button type="button" onClick={() => remove(i)} aria-label={`Remove ${s.day} ${s.time}`}>
              <Icon.X />
            </button>
          </span>
        ))}
        <button
          type="button"
          className="ct-add"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <Icon.Plus /> Add a class time
        </button>
      </div>

      {open && (
        <div className="ct-pop">
          <div className="ct-pop-label">Which day(s)?</div>
          <div className="ct-days">
            {DAYS.map((d) => (
              <button
                key={d}
                type="button"
                className={`ct-day ${days.includes(d) ? 'on' : ''}`}
                onClick={() => toggleDay(d)}
                aria-pressed={days.includes(d)}
              >
                {d}
              </button>
            ))}
          </div>
          <div className="ct-pop-label">What time?</div>
          <input
            type="time"
            className="ct-time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
          <div className="ct-pop-foot">
            <button type="button" className="ct-cancel" onClick={reset}>
              Cancel
            </button>
            <button type="button" className="ct-save" onClick={add} disabled={!days.length || !time}>
              Add {days.length > 1 ? `${days.length} times` : 'time'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
