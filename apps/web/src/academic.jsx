/**
 * Academic Support module — university student-athlete academic tracking.
 *
 * Built from the UCT RFC Academic Mentorship Tracker and Academic Assistance
 * SOP: a roster (Player Database), a Live Academic Tracker with a RAG risk rule,
 * bi-weekly check-ins, an intervention log, and the dashboards the SOP's monthly
 * review asks for. Risk is computed on the client (see academic-model.js).
 */
import { useState, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { qk, queryClient } from './query.js';
import * as api from './api.js';
import {
  Icon,
  Pill,
  Btn,
  Card,
  EmptyState,
  KPI,
  ProgressBar,
  Avatar,
  FilterChips,
  ResultCount,
  SegmentBar,
} from './atoms.jsx';
import { formatDeadlineLong } from './format.js';
import {
  SQUADS,
  FACULTIES,
  DEGREES_BY_FACULTY,
  ALL_DEGREES,
  YEARS_OF_STUDY,
  RISK_CATEGORIES,
  RISK_META,
  academicRisk,
  academicRiskScore,
  isAssessed,
  isVarsityCupEligible,
  VARSITY_CUP_MIN_CREDITS,
  needsImmediateAttention,
  riskSummary,
  facultyRiskAnalysis,
  mentorFollowUps,
  checkInFlags,
  INTERVENTION_STATUSES,
  REFERRAL_TARGETS,
  ADP_KIND,
  attrScale,
  semesterOf,
  QUESTION_BANK,
  ADP_SECTIONS,
  ADP_SECTION_META,
  SCREENER_QUESTIONS,
  MODULE_STATUS_META,
  moduleScreenStatus,
  flaggedModules,
  screenerSummary,
  ratingValue,
  sectionAverages,
  developmentPlanSummary,
  INTERVENTION_TYPES,
  INTERVENTION_TYPE_META,
  interventionLabel,
  adpSummary,
} from './academic-model.js';
import {
  lookupCourse,
  moduleDifficulty,
  courseSuggestions,
  DIFFICULTY_META,
  CATALOGUE_SIZE,
} from './course-catalogue.js';
import './screener.css';
import './academic.css';

const invAthletes = () => queryClient.invalidateQueries({ queryKey: qk.athletes() });
const invCheckIns = () => queryClient.invalidateQueries({ queryKey: qk.checkIns() });
const invMentors = () => queryClient.invalidateQueries({ queryKey: qk.mentors() });
const invInterventions = () => queryClient.invalidateQueries({ queryKey: qk.interventions() });

/** Assignment status of a plan, for the tracking view. */
function planStatusOf(c) {
  if (c.planStatus === 'sent') return { key: 'sent', label: 'Awaiting mentor', tone: 'amber' };
  if (c.planStatus === 'completed' || c.kind === ADP_KIND)
    return { key: 'completed', label: 'Completed', tone: 'green' };
  return { key: 'checkin', label: 'Check-in', tone: 'muted' };
}

/** Build the public mentor completion link for an assigned plan (hash-routed). */
function mentorLink(checkIn) {
  return `${window.location.origin}${import.meta.env.BASE_URL}#/mentor/${checkIn.id}?t=${checkIn.token}`;
}

const RiskPill = ({ athlete }) => {
  const r = academicRisk(athlete);
  return <Pill tone={RISK_META[r].tone}>{RISK_META[r].label}</Pill>;
};

const statusMeta = Object.fromEntries(INTERVENTION_STATUSES.map((s) => [s.key, s]));

export function AcademicModule({ toast }) {
  const [tab, setTab] = useState('dashboard');
  const [openAthlete, setOpenAthlete] = useState(null);

  const { data: athletes = [] } = useQuery({ queryKey: qk.athletes(), queryFn: api.getAthletes });
  const { data: checkIns = [] } = useQuery({ queryKey: qk.checkIns(), queryFn: api.getCheckIns });
  const { data: mentors = [] } = useQuery({ queryKey: qk.mentors(), queryFn: api.getMentors });
  const { data: interventions = [] } = useQuery({
    queryKey: qk.interventions(),
    queryFn: api.getInterventions,
  });

  const tabs = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'athletes', label: 'Athletes', badge: athletes.length || null },
    { key: 'tracker', label: 'Academic tracker' },
    { key: 'checkins', label: 'Academic development plans' },
    { key: 'mentors', label: 'Mentors', badge: mentors.length || null },
    { key: 'interventions', label: 'Interventions' },
  ];

  if (openAthlete) {
    return (
      <AthleteDetail
        athleteId={openAthlete}
        checkIns={checkIns}
        interventions={interventions}
        toast={toast}
        onBack={() => setOpenAthlete(null)}
      />
    );
  }

  return (
    <>
      <div className="tabs">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`tab ${tab === t.key ? 'on' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.badge ? <span className="tab-badge">{t.badge}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'dashboard' && (
        <DashboardTab
          athletes={athletes}
          interventions={interventions}
          checkIns={checkIns}
          onOpen={setOpenAthlete}
        />
      )}
      {tab === 'athletes' && (
        <AthletesTab athletes={athletes} toast={toast} onOpen={setOpenAthlete} />
      )}
      {tab === 'tracker' && (
        <TrackerTab athletes={athletes} toast={toast} onOpen={setOpenAthlete} />
      )}
      {tab === 'checkins' && (
        <CheckInsTab athletes={athletes} checkIns={checkIns} mentors={mentors} toast={toast} />
      )}
      {tab === 'mentors' && <MentorsTab mentors={mentors} toast={toast} />}
      {tab === 'interventions' && (
        <InterventionsTab athletes={athletes} interventions={interventions} toast={toast} />
      )}
    </>
  );
}

/* ═══════════════════════════════ Dashboard ══════════════════════════════ */

function DashboardTab({ athletes, interventions, checkIns, onOpen }) {
  const summary = riskSummary(athletes);
  const byFaculty = facultyRiskAnalysis(athletes);
  const mentors = mentorFollowUps(athletes, interventions, checkIns);
  const dp = developmentPlanSummary(checkIns);
  const immediate = athletes
    .filter(needsImmediateAttention)
    .sort((a, b) => RISK_META[academicRisk(b)].order - RISK_META[academicRisk(a)].order);
  const ineligible = athletes.filter((a) => !isVarsityCupEligible(a) && a.status !== 'withdrawn');

  return (
    <>
      <div className="kpi-row">
        <KPI label="Squad" num={summary.total} sub={`${summary.unassessed} not yet assessed`} />
        <KPI label="Green" num={summary.green} tone="teal" />
        <KPI label="Amber" num={summary.amber} tone={summary.amber ? 'amber' : ''} />
        <KPI label="Red" num={summary.red} tone={summary.red ? 'amber' : ''} />
        <KPI label="Critical" num={summary.critical} tone={summary.critical ? 'amber' : ''} />
      </div>

      <Card title="Risk distribution" sub="Where the squad sits on the RAG scale right now.">
        <SegmentBar
          segments={[
            { value: summary.green, tone: 'green', label: 'Green' },
            { value: summary.amber, tone: 'amber', label: 'Amber' },
            { value: summary.red, tone: 'red', label: 'Red' },
            { value: summary.critical, tone: 'critical', label: 'Critical' },
            { value: summary.unassessed, tone: 'muted', label: 'Not assessed' },
          ]}
        />
      </Card>

      <Card
        title="Development plans"
        sub={
          dp.plans
            ? 'How the squad sits across the four development areas, pooled from every plan run.'
            : 'A summary of the academic development plans will appear here once you run the first one.'
        }
      >
        {dp.plans === 0 ? (
          <EmptyState
            icon={Icon.Form}
            title="No development plans yet"
            sub="Build one from the Development plans tab to start tracking the squad’s areas."
          />
        ) : (
          <>
            <div className="kpi-row">
              <KPI label="Plans run" num={dp.plans} sub={`${dp.athletes} athletes`} />
              <KPI
                label="Overall"
                num={dp.meanBand ? dp.meanBand.tag : '—'}
                sub={dp.mean ? `avg ${dp.mean.toFixed(1)} / 5` : 'not yet rated'}
                tone={dp.meanBand && dp.meanBand.tone !== 'green' ? 'amber' : ''}
              />
              <KPI label="Flagged modules" num={dp.flaggedModules} />
              <KPI label="Interventions planned" num={dp.interventions} />
            </div>
            <div className="dash-radar-row">
              <RadarChart axes={dp.axes} />
              <div className="dash-radar-side">
                {dp.weakest && (
                  <div className="dash-callout">
                    <span className="dash-callout-l">Weakest area</span>
                    <span className="dash-callout-v t-red">
                      {dp.weakest.title} · {dp.weakest.value.toFixed(1)}
                    </span>
                  </div>
                )}
                {dp.strongest && dp.strongest !== dp.weakest && (
                  <div className="dash-callout">
                    <span className="dash-callout-l">Strongest area</span>
                    <span className="dash-callout-v t-green">
                      {dp.strongest.title} · {dp.strongest.value.toFixed(1)}
                    </span>
                  </div>
                )}
                {dp.followUps > 0 && (
                  <div className="dash-callout">
                    <span className="dash-callout-l">Need follow-up</span>
                    <span className="dash-callout-v">
                      {dp.followUps} plan{dp.followUps === 1 ? '' : 's'}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </Card>

      <div className="kpi-row">
        <KPI
          label="Immediate attention"
          num={summary.immediate}
          sub="Red + Critical"
          tone={summary.immediate ? 'amber' : ''}
        />
        <KPI
          label="Varsity Cup eligible"
          num={`${summary.eligible} / ${summary.total}`}
          sub={`≥ ${VARSITY_CUP_MIN_CREDITS} credits`}
        />
        <KPI
          label="Open interventions"
          num={interventions.filter((i) => i.status !== 'resolved').length}
        />
        <KPI label="Check-ins logged" num={checkIns.length} />
      </div>

      <Card
        title="Immediate attention"
        sub="Red and Critical student-athletes — the SOP's escalation set."
      >
        {immediate.length === 0 ? (
          <EmptyState
            icon={Icon.Check}
            title="Nobody in the red"
            sub="No student-athlete is currently Red or Critical."
          />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Athlete</th>
                <th>Squad</th>
                <th>Faculty</th>
                <th>Semester avg</th>
                <th>Faculty warning</th>
                <th>Mentor</th>
                <th>Risk</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {immediate.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>
                      {a.firstName} {a.lastName}
                    </strong>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {a.studentNumber}
                    </div>
                  </td>
                  <td>{a.squad}</td>
                  <td>{a.faculty || '—'}</td>
                  <td>{a.semesterAverage != null ? `${a.semesterAverage}%` : '—'}</td>
                  <td>{a.facultyWarning === 'Yes' ? <Pill tone="red">Yes</Pill> : 'No'}</td>
                  <td>{a.mentor || <span className="muted">unassigned</span>}</td>
                  <td>
                    <RiskPill athlete={a} />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Btn size="sm" onClick={() => onOpen(a.id)}>
                      Open
                    </Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="two-col">
        <Card title="Faculty risk analysis" sub="At-risk (Red + Critical) players per faculty.">
          {byFaculty.length === 0 ? (
            <EmptyState icon={Icon.Shield} title="No athletes yet" />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Faculty</th>
                  <th>Squad</th>
                  <th>At risk</th>
                </tr>
              </thead>
              <tbody>
                {byFaculty.map((f) => (
                  <tr key={f.faculty}>
                    <td>{f.faculty}</td>
                    <td>{f.total}</td>
                    <td>{f.atRisk ? <Pill tone="red">{f.atRisk}</Pill> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card
          title="Mentor follow-ups"
          sub="Outstanding interventions and flagged check-ins per mentor."
        >
          {mentors.length === 0 ? (
            <EmptyState icon={Icon.Users} title="No outstanding follow-ups" />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Mentor</th>
                  <th>Interventions</th>
                  <th>Check-ins</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {mentors.map((m) => (
                  <tr key={m.mentor}>
                    <td>{m.mentor}</td>
                    <td>{m.interventions || '—'}</td>
                    <td>{m.checkIns || '—'}</td>
                    <td>
                      <Pill tone="amber">{m.total}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {ineligible.length > 0 && (
        <Card
          title="Varsity Cup eligibility watch"
          sub={`Below ${VARSITY_CUP_MIN_CREDITS} credits — cannot play until they carry enough.`}
        >
          <table className="tbl">
            <thead>
              <tr>
                <th>Athlete</th>
                <th>Squad</th>
                <th>Credits</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ineligible.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.firstName} {a.lastName}
                  </td>
                  <td>{a.squad}</td>
                  <td>
                    <Pill tone="amber">{a.creditsRegistered ?? 0} credits</Pill>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Btn size="sm" onClick={() => onOpen(a.id)}>
                      Open
                    </Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

/* ═══════════════════════════════ Athletes ═══════════════════════════════ */

function AthletesTab({ athletes, toast, onOpen }) {
  const [adding, setAdding] = useState(false);
  const [squad, setSquad] = useState('all');
  const [faculty, setFaculty] = useState('all');
  const [risk, setRisk] = useState('all');
  const [q, setQ] = useState('');

  const shown = athletes.filter((a) => {
    if (squad !== 'all' && a.squad !== squad) return false;
    if (faculty !== 'all' && a.faculty !== faculty) return false;
    if (risk !== 'all' && academicRisk(a) !== risk) return false;
    if (q) {
      const hay = `${a.firstName} ${a.lastName} ${a.studentNumber}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  });

  return (
    <>
      {adding && <AthleteForm onClose={() => setAdding(false)} toast={toast} />}
      <Card
        title="Student-athletes"
        sub="The academic Player Database — one row per athlete on the programme."
        action={
          <Btn tone="primary" icon={Icon.Plus} onClick={() => setAdding(true)}>
            Add athlete
          </Btn>
        }
      >
        <div className="roster-head">
          <div className="roster-search">
            <Icon.Eye />
            <input
              placeholder="Search name or student number…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <ResultCount shown={shown.length} total={athletes.length} noun="athlete" />
        </div>
        <FilterChips
          chips={[
            {
              key: 'squad',
              label: 'Squad',
              value: squad,
              onChange: setSquad,
              options: [
                { value: 'all', label: 'All squads' },
                ...SQUADS.map((s) => ({ value: s, label: s })),
              ],
            },
            {
              key: 'faculty',
              label: 'Faculty',
              value: faculty,
              onChange: setFaculty,
              options: [
                { value: 'all', label: 'All faculties' },
                ...FACULTIES.map((f) => ({ value: f, label: f })),
              ],
            },
            {
              key: 'risk',
              label: 'Risk',
              value: risk,
              onChange: setRisk,
              options: [
                { value: 'all', label: 'All risk levels' },
                { value: 'critical', label: 'Critical' },
                { value: 'red', label: 'Red' },
                { value: 'amber', label: 'Amber' },
                { value: 'green', label: 'Green' },
                { value: 'unassessed', label: 'Not assessed' },
              ],
            },
          ]}
        />

        {shown.length === 0 ? (
          <EmptyState
            icon={Icon.Users}
            title={athletes.length ? 'No athletes match' : 'No athletes yet'}
            sub={athletes.length ? 'Try a different filter.' : 'Add your squad to start tracking.'}
          />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Athlete</th>
                <th>Squad</th>
                <th>Faculty · degree</th>
                <th>Year</th>
                <th>Credits</th>
                <th>Mentor</th>
                <th>Risk</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.id}>
                  <td>
                    <div className="cell-id">
                      <Avatar name={`${a.firstName} ${a.lastName}`} />
                      <div>
                        <button className="linklike" onClick={() => onOpen(a.id)}>
                          <strong>
                            {a.firstName} {a.lastName}
                          </strong>
                        </button>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {a.studentNumber}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>{a.squad}</td>
                  <td>
                    {a.faculty || '—'}
                    {a.degree && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {a.degree}
                      </div>
                    )}
                  </td>
                  <td>{a.yearOfStudy || '—'}</td>
                  <td>
                    {a.creditsRegistered != null ? (
                      isVarsityCupEligible(a) ? (
                        `${a.creditsRegistered}`
                      ) : (
                        <Pill tone="amber">{a.creditsRegistered}</Pill>
                      )
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{a.mentor || <span className="muted">—</span>}</td>
                  <td>
                    <RiskPill athlete={a} />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Btn size="sm" onClick={() => onOpen(a.id)}>
                      Open
                    </Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function AthleteForm({ onClose, toast }) {
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    studentNumber: '',
    squad: 'General',
    faculty: '',
    degree: '',
    yearOfStudy: '',
    creditsRegistered: '',
    mentor: '',
    riskCategory: '',
    consent: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const degrees = form.faculty ? DEGREES_BY_FACULTY[form.faculty] : ALL_DEGREES;

  async function submit(e) {
    e.preventDefault();
    if (!form.firstName.trim() || !form.lastName.trim())
      return setError('Name and surname are required.');
    if (!form.studentNumber.trim()) return setError('A student number is required.');
    setBusy(true);
    setError(null);
    try {
      await api.createAthlete({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        studentNumber: form.studentNumber.trim(),
        squad: form.squad,
        faculty: form.faculty || undefined,
        degree: form.degree || undefined,
        yearOfStudy: form.yearOfStudy || undefined,
        creditsRegistered: form.creditsRegistered ? Number(form.creditsRegistered) : undefined,
        mentor: form.mentor.trim() || undefined,
        riskCategory: form.riskCategory || undefined,
        consentAt: form.consent ? new Date().toISOString() : undefined,
      });
      invAthletes();
      toast(`${form.firstName} ${form.lastName} added.`);
      onClose();
    } catch (err) {
      setError(err.message || 'Could not add the athlete.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="modal-head">
          <div className="modal-title">Add student-athlete</div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.X />
          </button>
        </div>
        <form onSubmit={submit} className="modal-body">
          <div className="fld-row">
            <label className="fld">
              <span>First name</span>
              <input
                value={form.firstName}
                onChange={(e) => set({ firstName: e.target.value })}
                autoFocus
              />
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
                placeholder="ANDCHR020"
              />
            </label>
          </div>
          <div className="fld-row">
            <label className="fld">
              <span>Squad</span>
              <select value={form.squad} onChange={(e) => set({ squad: e.target.value })}>
                {SQUADS.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="fld">
              <span>Faculty</span>
              <select
                value={form.faculty}
                onChange={(e) => set({ faculty: e.target.value, degree: '' })}
              >
                <option value="">—</option>
                {FACULTIES.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
            <label className="fld">
              <span>Degree</span>
              <select value={form.degree} onChange={(e) => set({ degree: e.target.value })}>
                <option value="">—</option>
                {degrees.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="fld-row">
            <label className="fld">
              <span>Year of study</span>
              <select
                value={form.yearOfStudy}
                onChange={(e) => set({ yearOfStudy: e.target.value })}
              >
                <option value="">—</option>
                {YEARS_OF_STUDY.map((y) => (
                  <option key={y}>{y}</option>
                ))}
              </select>
            </label>
            <label className="fld">
              <span>Credits registered</span>
              <input
                type="number"
                min="0"
                value={form.creditsRegistered}
                onChange={(e) => set({ creditsRegistered: e.target.value })}
                placeholder={`${VARSITY_CUP_MIN_CREDITS}+ to be eligible`}
              />
            </label>
            <label className="fld">
              <span>Mentor</span>
              <input value={form.mentor} onChange={(e) => set({ mentor: e.target.value })} />
            </label>
            <label className="fld">
              <span>Risk category</span>
              <select
                value={form.riskCategory}
                onChange={(e) => set({ riskCategory: e.target.value })}
              >
                <option value="">—</option>
                {RISK_CATEGORIES.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={form.consent}
              onChange={(e) => set({ consent: e.target.checked })}
            />
            <span>
              POPIA consent on file — the athlete has authorised UCT RFC staff to access their
              academic information for support purposes (per the SOP consent form).
            </span>
          </label>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="modal-foot">
            <Btn type="button" onClick={onClose}>
              Cancel
            </Btn>
            <Btn tone="primary" type="submit" disabled={busy}>
              {busy ? 'Adding…' : 'Add athlete'}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ═══════════════════════════ Athlete detail ═════════════════════════════ */

function AthleteDetail({ athleteId, checkIns, interventions, toast, onBack }) {
  const { data: a } = useQuery({
    queryKey: qk.athlete(athleteId),
    queryFn: () => api.getAthlete(athleteId),
  });
  const [editingSnapshot, setEditingSnapshot] = useState(false);

  if (!a) return <div className="muted">Loading…</div>;

  const theirCheckIns = checkIns.filter((c) => c.studentNumber === a.studentNumber);
  const theirInterventions = interventions.filter((i) => i.studentNumber === a.studentNumber);
  const score = academicRiskScore(a);
  const theirPlans = theirCheckIns.filter((c) => c.kind === ADP_KIND || c.planStatus);
  const sortedPlans = [...theirPlans].sort((x, y) =>
    String(y.completedAt ?? y.sentAt ?? y.date).localeCompare(
      String(x.completedAt ?? x.sentAt ?? x.date),
    ),
  );
  const latestPlan = sortedPlans[0] ?? null;
  const latestCompleted = sortedPlans.find(
    (c) => c.planStatus === 'completed' || (c.kind === ADP_KIND && !c.planStatus),
  );
  const planSum = latestCompleted ? adpSummary(latestCompleted) : null;
  const lastSeen = latestCompleted?.completedAt ?? latestCompleted?.date ?? null;
  const nextSession = latestPlan?.scheduledNext ?? null;
  const awaitingPlan = theirPlans.some((c) => c.planStatus === 'sent');

  return (
    <>
      <Btn onClick={onBack} icon={Icon.Arrow}>
        Back to athletes
      </Btn>

      {editingSnapshot && (
        <SnapshotEditor athlete={a} onClose={() => setEditingSnapshot(false)} toast={toast} />
      )}

      <div className="page-head" style={{ marginTop: 14 }}>
        <div>
          <h1>
            {a.firstName} {a.lastName}
          </h1>
          <div className="muted">
            {a.studentNumber} · {a.squad}
            {a.faculty ? ` · ${a.faculty}` : ''}
            {a.degree ? ` · ${a.degree}` : ''}
          </div>
        </div>
        <RiskPill athlete={a} />
      </div>

      <div className="kpi-row">
        <KPI label="Risk score" num={score != null ? score : '—'} sub="0–100" />
        <KPI label="Semester avg" num={a.semesterAverage != null ? `${a.semesterAverage}%` : '—'} />
        <KPI
          label="Credits"
          num={a.creditsRegistered ?? '—'}
          sub={
            isVarsityCupEligible(a) ? 'Varsity Cup eligible' : `below ${VARSITY_CUP_MIN_CREDITS}`
          }
          tone={a.creditsRegistered != null && !isVarsityCupEligible(a) ? 'amber' : ''}
        />
        <KPI
          label="Consent"
          num={a.consentAt ? 'On file' : 'Missing'}
          tone={a.consentAt ? '' : 'amber'}
        />
      </div>

      <Card title="Mentorship" sub="Who’s working with them, when they last met, and what’s next.">
        <div className="kpi-row">
          <KPI
            label="Assigned mentor"
            num={latestPlan?.mentor || '—'}
            sub={latestPlan?.mentorEmail}
          />
          <KPI
            label="Last seen"
            num={lastSeen ? formatDeadlineLong(lastSeen.slice(0, 10)) : '—'}
            sub={lastSeen ? 'plan completed' : 'no completed plan'}
          />
          <KPI
            label="Next session"
            num={nextSession ? formatDeadlineLong(nextSession) : '—'}
            tone={nextSession ? '' : 'amber'}
          />
          <KPI
            label="Plans"
            num={theirPlans.length}
            sub={awaitingPlan ? 'one awaiting the mentor' : undefined}
            tone={awaitingPlan ? 'amber' : ''}
          />
        </div>
      </Card>

      <Card
        title="Live academic tracker"
        sub={
          a.assessedAt
            ? `Last assessed ${formatDeadlineLong(a.assessedAt.slice(0, 10))}`
            : 'Not yet assessed'
        }
        action={
          <Btn tone="primary" onClick={() => setEditingSnapshot(true)}>
            Update snapshot
          </Btn>
        }
      >
        {isAssessed(a) ? (
          <div className="metric-grid">
            <Metric label="Lecture attendance" value={a.lectureAttendance} good={85} warn={70} />
            <Metric label="Tutorial attendance" value={a.tutorialAttendance} good={85} warn={70} />
            <Metric
              label="Assignment completion"
              value={a.assignmentCompletion}
              good={85}
              warn={80}
            />
            <Metric label="Semester average" value={a.semesterAverage} good={60} warn={50} />
            <div className="metric">
              <div className="metric-label">Faculty warning</div>
              <div className="metric-value">
                {a.facultyWarning === 'Yes' ? (
                  <Pill tone="red">Yes</Pill>
                ) : (
                  <Pill tone="green">No</Pill>
                )}
              </div>
            </div>
          </div>
        ) : (
          <EmptyState
            icon={Icon.Star}
            title="No academic snapshot yet"
            sub="Capture attendance, assignments, semester average and faculty-warning status to compute risk."
          />
        )}
      </Card>

      {latestCompleted && (
        <Card
          title="Development plan"
          sub={`How ${a.firstName} is doing across the four areas — ${latestCompleted.period || 'latest plan'}, ${formatDeadlineLong((latestCompleted.completedAt ?? latestCompleted.date).slice(0, 10))}.`}
        >
          <div className="dash-radar-row">
            <RadarChart axes={sectionAverages(latestCompleted)} />
            <div className="dash-radar-side">
              <div className="dash-callout">
                <span className="dash-callout-l">Overall</span>
                <span
                  className={`dash-callout-v ${planSum.meanBand ? `t-${planSum.meanBand.tone}` : ''}`}
                >
                  {planSum.meanBand ? planSum.meanBand.tag : '—'}
                  {planSum.mean ? ` · ${planSum.mean.toFixed(1)} / 5` : ''}
                </span>
              </div>
              {planSum.floorBand && (
                <div className="dash-callout">
                  <span className="dash-callout-l">Lowest area</span>
                  <span className={`dash-callout-v t-${planSum.floorBand.tone}`}>
                    {planSum.floorBand.tag}
                  </span>
                </div>
              )}
              <div className="dash-callout">
                <span className="dash-callout-l">Flagged modules</span>
                <span className="dash-callout-v">{planSum.flaggedModules}</span>
              </div>
            </div>
          </div>
        </Card>
      )}

      <div className="two-col">
        <Card title="Check-ins" sub={`${theirCheckIns.length} logged`}>
          {theirCheckIns.length === 0 ? (
            <EmptyState
              icon={Icon.Form}
              title="No check-ins"
              sub="Log one from the Check-ins tab."
            />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Plan</th>
                  <th>Standing</th>
                  <th>Follow-up</th>
                </tr>
              </thead>
              <tbody>
                {theirCheckIns.map((c) => {
                  const isAdp = c.kind === ADP_KIND;
                  const sum = isAdp ? adpSummary(c) : null;
                  const flags = isAdp ? null : checkInFlags(c.answers);
                  return (
                    <tr key={c.id}>
                      <td>{formatDeadlineLong(c.date)}</td>
                      <td>
                        {isAdp ? (
                          c.period || 'Development plan'
                        ) : (
                          <span className="muted">Check-in</span>
                        )}
                      </td>
                      <td>
                        {isAdp && sum.floorBand ? (
                          <Pill tone={sum.floorBand.tone}>{sum.floorBand.tag}</Pill>
                        ) : flags ? (
                          <Pill tone={flags > 3 ? 'red' : 'amber'}>{flags} flags</Pill>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>{c.followUpRequired === 'Yes' ? <Pill tone="amber">Yes</Pill> : 'No'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Interventions" sub={`${theirInterventions.length} raised`}>
          {theirInterventions.length === 0 ? (
            <EmptyState
              icon={Icon.Alert}
              title="No interventions"
              sub="Raise one from the Interventions tab."
            />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Concern</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {theirInterventions.map((i) => (
                  <tr key={i.id}>
                    <td>{formatDeadlineLong(i.date)}</td>
                    <td>{i.concern}</td>
                    <td>
                      <Pill tone={statusMeta[i.status]?.tone}>{statusMeta[i.status]?.label}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}

function Metric({ label, value, good, warn }) {
  const tone = value >= good ? 'teal' : value >= warn ? 'amber' : 'red';
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}%</div>
      <ProgressBar value={value} tone={tone} />
    </div>
  );
}

function SnapshotEditor({ athlete, onClose, toast }) {
  const [form, setForm] = useState({
    lectureAttendance: athlete.lectureAttendance ?? '',
    tutorialAttendance: athlete.tutorialAttendance ?? '',
    assignmentCompletion: athlete.assignmentCompletion ?? '',
    semesterAverage: athlete.semesterAverage ?? '',
    facultyWarning: athlete.facultyWarning ?? 'No',
    creditsRegistered: athlete.creditsRegistered ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  // Live preview of the computed risk as the numbers change.
  const preview = {
    lectureAttendance: numOrNull(form.lectureAttendance),
    tutorialAttendance: numOrNull(form.tutorialAttendance),
    assignmentCompletion: numOrNull(form.assignmentCompletion),
    semesterAverage: numOrNull(form.semesterAverage),
    facultyWarning: form.facultyWarning,
  };
  const risk = academicRisk(preview);
  const score = academicRiskScore(preview);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.patchAthlete(athlete.id, {
        lectureAttendance: numOrNull(form.lectureAttendance) ?? undefined,
        tutorialAttendance: numOrNull(form.tutorialAttendance) ?? undefined,
        assignmentCompletion: numOrNull(form.assignmentCompletion) ?? undefined,
        semesterAverage: numOrNull(form.semesterAverage) ?? undefined,
        facultyWarning: form.facultyWarning,
        creditsRegistered:
          form.creditsRegistered !== '' ? Number(form.creditsRegistered) : undefined,
        version: athlete.version,
      });
      queryClient.invalidateQueries({ queryKey: qk.athlete(athlete.id) });
      invAthletes();
      toast('Academic snapshot updated.');
      onClose();
    } catch (err) {
      setError(err.message || 'Could not save the snapshot.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-head">
          <div className="modal-title">
            Academic snapshot — {athlete.firstName} {athlete.lastName}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.X />
          </button>
        </div>
        <form onSubmit={submit} className="modal-body">
          <div className="assess-summary">
            <div>
              <div className="muted" style={{ fontSize: 12 }}>
                Computed risk
              </div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                {score != null ? `Score ${score}` : 'Incomplete'}
              </div>
            </div>
            <Pill tone={RISK_META[risk].tone}>{RISK_META[risk].label}</Pill>
          </div>

          <div className="fld-row" style={{ marginTop: 14 }}>
            <label className="fld">
              <span>Lecture attendance %</span>
              <input
                type="number"
                min="0"
                max="100"
                value={form.lectureAttendance}
                onChange={(e) => set({ lectureAttendance: e.target.value })}
              />
            </label>
            <label className="fld">
              <span>Tutorial attendance %</span>
              <input
                type="number"
                min="0"
                max="100"
                value={form.tutorialAttendance}
                onChange={(e) => set({ tutorialAttendance: e.target.value })}
              />
            </label>
          </div>
          <div className="fld-row">
            <label className="fld">
              <span>Assignment completion %</span>
              <input
                type="number"
                min="0"
                max="100"
                value={form.assignmentCompletion}
                onChange={(e) => set({ assignmentCompletion: e.target.value })}
              />
            </label>
            <label className="fld">
              <span>Semester average %</span>
              <input
                type="number"
                min="0"
                max="100"
                value={form.semesterAverage}
                onChange={(e) => set({ semesterAverage: e.target.value })}
              />
            </label>
          </div>
          <div className="fld-row">
            <label className="fld">
              <span>Faculty warning</span>
              <select
                value={form.facultyWarning}
                onChange={(e) => set({ facultyWarning: e.target.value })}
              >
                <option value="No">No</option>
                <option value="Yes">Yes</option>
              </select>
            </label>
            <label className="fld">
              <span>Credits registered</span>
              <input
                type="number"
                min="0"
                value={form.creditsRegistered}
                onChange={(e) => set({ creditsRegistered: e.target.value })}
              />
            </label>
          </div>

          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="modal-foot">
            <Btn type="button" onClick={onClose}>
              Cancel
            </Btn>
            <Btn tone="primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save snapshot'}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ═══════════════════════════ Live tracker table ═════════════════════════ */

function TrackerTab({ athletes, toast, onOpen }) {
  const [editing, setEditing] = useState(null);
  const assessed = athletes.filter(isAssessed);
  const rows = [...athletes].sort(
    (a, b) => RISK_META[academicRisk(b)].order - RISK_META[academicRisk(a)].order,
  );

  return (
    <>
      {editing && (
        <SnapshotEditor athlete={editing} onClose={() => setEditing(null)} toast={toast} />
      )}
      <Card
        title="Live academic tracker"
        sub={`${assessed.length} of ${athletes.length} assessed · attendance, assignments, semester average → RAG risk.`}
      >
        {athletes.length === 0 ? (
          <EmptyState
            icon={Icon.Star}
            title="No athletes yet"
            sub="Add your squad on the Athletes tab."
          />
        ) : (
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Athlete</th>
                  <th>Lecture</th>
                  <th>Tutorial</th>
                  <th>Assign.</th>
                  <th>Sem. avg</th>
                  <th>Fac. warn</th>
                  <th>Risk</th>
                  <th>Score</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const score = academicRiskScore(a);
                  const r = academicRisk(a);
                  const cell = (v, warn) =>
                    v == null ? '—' : <span className={v < warn ? 'metric-bad' : ''}>{v}%</span>;
                  return (
                    <tr key={a.id} className={`risk-row risk-${r}`}>
                      <td>
                        <button className="linklike" onClick={() => onOpen(a.id)}>
                          {a.firstName} {a.lastName}
                        </button>
                      </td>
                      <td>{cell(a.lectureAttendance, 70)}</td>
                      <td>{cell(a.tutorialAttendance, 70)}</td>
                      <td>{cell(a.assignmentCompletion, 80)}</td>
                      <td>{cell(a.semesterAverage, 50)}</td>
                      <td>
                        {a.facultyWarning === 'Yes' ? (
                          <Pill tone="red">Yes</Pill>
                        ) : a.facultyWarning === 'No' ? (
                          'No'
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <RiskPill athlete={a} />
                      </td>
                      <td>{score != null ? score : '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <Btn size="sm" onClick={() => setEditing(a)}>
                          Edit
                        </Btn>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

/* ═══════════════════════ Academic Development Plans ══════════════════════ */

function CheckInsTab({ athletes, checkIns, mentors, toast }) {
  const [assigning, setAssigning] = useState(false);
  const [openPlan, setOpenPlan] = useState(null);
  const [linkFor, setLinkFor] = useState(null);
  // Admin in-house completion: { athlete, checkIn } → renders the wizard.
  const [completing, setCompleting] = useState(null);

  // Only the latest plan per athlete drives the tracking view; legacy check-ins
  // (no kind) are folded in as their own rows.
  const plans = checkIns
    .filter((c) => c.kind === ADP_KIND || c.planStatus)
    .sort((a, b) =>
      String(b.completedAt ?? b.sentAt ?? b.date).localeCompare(
        String(a.completedAt ?? a.sentAt ?? a.date),
      ),
    );
  const counts = {
    sent: plans.filter((c) => planStatusOf(c).key === 'sent').length,
    completed: plans.filter((c) => planStatusOf(c).key === 'completed').length,
  };

  async function adminComplete(payload) {
    // The admin completed a plan in-house: save it, log its interventions.
    const created = await api.createCheckIn({
      ...payload,
      athleteId: completing.athlete.id,
      mentor: completing.mentorName,
      mentorEmail: completing.mentorEmail,
      planStatus: 'completed',
    });
    for (const item of payload.plan ?? []) {
      try {
        await api.createIntervention({
          athleteId: completing.athlete.id,
          studentNumber: created.studentNumber,
          athleteName: created.athleteName,
          date: created.date,
          concern: `${interventionLabel(item)}${payload.period ? ` · ${payload.period}` : ''}${item.note ? ` — ${item.note}` : ''}`,
          actionTaken: INTERVENTION_TYPE_META[item.type]?.label,
          referredTo: item.referredTo || undefined,
          followUpDate: item.dueDate || undefined,
        });
      } catch {
        /* best-effort */
      }
    }
    invCheckIns();
    invInterventions();
    toast('Development plan saved.');
    setCompleting(null);
  }

  if (completing) {
    return (
      <AdpWizard
        athlete={completing.athlete}
        period={completing.period}
        onSubmit={adminComplete}
        onClose={() => setCompleting(null)}
      />
    );
  }

  return (
    <>
      {openPlan && (
        <AdpDetail checkIn={openPlan} athletes={athletes} onClose={() => setOpenPlan(null)} />
      )}
      {linkFor && (
        <MentorLinkModal checkIn={linkFor} onClose={() => setLinkFor(null)} toast={toast} />
      )}
      {assigning && (
        <AssignPlanModal
          athletes={athletes}
          mentors={mentors}
          toast={toast}
          onClose={() => setAssigning(false)}
          onAssigned={(checkIn) => {
            setAssigning(false);
            setLinkFor(checkIn);
          }}
          onCompleteNow={(ctx) => {
            setAssigning(false);
            setCompleting(ctx);
          }}
        />
      )}
      <Card
        title="Academic development plans"
        sub="Assign each athlete's plan to a mentor and send them a link — track who's been done, and open a completed plan to see its summary."
        action={
          <Btn
            tone="primary"
            icon={Icon.Plus}
            onClick={() => setAssigning(true)}
            disabled={athletes.length === 0}
          >
            New development plan
          </Btn>
        }
      >
        {plans.length === 0 ? (
          <EmptyState
            icon={Icon.Form}
            title="No plans yet"
            sub="Assign the first academic development plan to a mentor."
          />
        ) : (
          <>
            <div className="track-tally">
              <span>
                <Pill tone="green">{counts.completed}</Pill> completed
              </span>
              <span>
                <Pill tone="amber">{counts.sent}</Pill> awaiting the mentor
              </span>
            </div>
            <table className="tbl tbl-click">
              <thead>
                <tr>
                  <th>Athlete</th>
                  <th>Mentor</th>
                  <th>Term</th>
                  <th>Status</th>
                  <th>Overall</th>
                  <th>Updated</th>
                  <th>Next session</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((c) => {
                  const st = planStatusOf(c);
                  const sum = c.kind === ADP_KIND ? adpSummary(c) : null;
                  const onRow = () => (st.key === 'sent' ? setLinkFor(c) : setOpenPlan(c));
                  return (
                    <tr
                      key={c.id}
                      onClick={onRow}
                      tabIndex={0}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onRow()}
                      role="button"
                      aria-label={`Open ${c.athleteName}'s plan`}
                    >
                      <td>
                        <strong>{c.athleteName}</strong>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {c.studentNumber}
                        </div>
                      </td>
                      <td>
                        {c.mentor || <span className="muted">—</span>}
                        {c.mentorEmail && (
                          <div className="muted" style={{ fontSize: 12 }}>
                            {c.mentorEmail}
                          </div>
                        )}
                      </td>
                      <td>{c.period || <span className="muted">—</span>}</td>
                      <td>
                        <Pill tone={st.tone}>{st.label}</Pill>
                      </td>
                      <td>
                        {sum && sum.meanBand ? (
                          <Pill tone={sum.meanBand.tone}>{sum.meanBand.tag}</Pill>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {formatDeadlineLong(
                          (c.completedAt ?? c.sentAt ?? c.date ?? '').slice(0, 10),
                        )}
                      </td>
                      <td>
                        {c.scheduledNext ? (
                          formatDeadlineLong(c.scheduledNext)
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </Card>
    </>
  );
}

/* ───────────────────── Assign a plan to a mentor + link ──────────────────── */

function AssignPlanModal({ athletes, mentors, toast, onClose, onAssigned, onCompleteNow }) {
  const [athleteId, setAthleteId] = useState(athletes[0]?.id ?? '');
  const [mentorId, setMentorId] = useState(mentors[0]?.id ?? '__new');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [sessionDate, setSessionDate] = useState(new Date().toISOString().slice(0, 10));
  const [nextSession, setNextSession] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const athlete = athletes.find((a) => a.id === athleteId);
  const period = semesterOf(sessionDate).label;
  const isNew = mentorId === '__new';
  const chosen = mentors.find((m) => m.id === mentorId);
  const mentorName = isNew ? newName.trim() : (chosen?.name ?? '');
  const mentorEmail = isNew ? newEmail.trim() : (chosen?.email ?? '');

  function validate() {
    if (!athlete) return 'Choose an athlete.';
    if (!mentorName) return 'Choose or name a mentor.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mentorEmail)) return 'A valid mentor email is required.';
    return null;
  }

  async function assign() {
    const invalid = validate();
    if (invalid) return setError(invalid);
    setBusy(true);
    setError(null);
    try {
      const created = await api.createCheckIn({
        athleteId,
        studentNumber: athlete.studentNumber,
        athleteName: `${athlete.firstName} ${athlete.lastName}`,
        mentor: mentorName,
        mentorEmail,
        planStatus: 'sent',
        period,
        date: sessionDate,
        scheduledNext: nextSession || undefined,
        kind: ADP_KIND,
        answers: {},
        followUpRequired: 'No',
      });
      invCheckIns();
      toast('Plan created — share the link with the mentor.');
      onAssigned(created);
    } catch (err) {
      setError(err.message || 'Could not create the plan.');
      setBusy(false);
    }
  }

  function completeNow() {
    const invalid = validate();
    if (invalid) return setError(invalid);
    onCompleteNow({ athlete, period, mentorName, mentorEmail });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-head">
          <div className="modal-title">New development plan</div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.X />
          </button>
        </div>
        <div className="modal-body">
          <label className="fld">
            <span>Student-athlete</span>
            <select value={athleteId} onChange={(e) => setAthleteId(e.target.value)}>
              {athletes.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.firstName} {a.lastName} · {a.studentNumber}
                </option>
              ))}
            </select>
          </label>

          <label className="fld">
            <span>Mentor</span>
            <select value={mentorId} onChange={(e) => setMentorId(e.target.value)}>
              {mentors.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.email}
                </option>
              ))}
              <option value="__new">＋ New mentor…</option>
            </select>
          </label>
          {isNew && (
            <div className="fld-row">
              <label className="fld">
                <span>Mentor name</span>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
              </label>
              <label className="fld">
                <span>Mentor email</span>
                <input
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="mentor@example.com"
                />
              </label>
            </div>
          )}

          <div className="fld-row">
            <label className="fld">
              <span>Session date</span>
              <input
                type="date"
                value={sessionDate}
                onChange={(e) => setSessionDate(e.target.value)}
              />
            </label>
            <label className="fld">
              <span>Term</span>
              <div className="fld-static">{period}</div>
            </label>
            <label className="fld">
              <span>Next session (optional)</span>
              <input
                type="date"
                value={nextSession}
                onChange={(e) => setNextSession(e.target.value)}
              />
            </label>
          </div>

          <p className="muted" style={{ fontSize: 12.5 }}>
            The mentor gets a private link to complete the plan for this athlete — they don’t need a
            login. Or complete it in-house yourself.
          </p>

          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="modal-foot">
            <Btn type="button" onClick={completeNow}>
              Complete in-house
            </Btn>
            <Btn tone="primary" icon={Icon.Mail} onClick={assign} disabled={busy}>
              {busy ? 'Creating…' : 'Create & get link'}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

function MentorLinkModal({ checkIn, onClose, toast }) {
  const link = mentorLink(checkIn);
  const subject = encodeURIComponent(`Academic development plan — ${checkIn.athleteName}`);
  const body = encodeURIComponent(
    `Hi ${checkIn.mentor ?? 'there'},\n\n` +
      `Please complete the academic development plan for ${checkIn.athleteName} (${checkIn.period ?? ''}).\n` +
      `Open your private link, work through it with the student, and submit — no login needed:\n\n${link}\n\n` +
      `Thank you.`,
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copied to the clipboard.');
    } catch {
      toast('Could not copy — select and copy the link manually.', 'err');
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-head">
          <div className="modal-title">Mentor link — {checkIn.athleteName}</div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.X />
          </button>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ fontSize: 13 }}>
            Send this to <strong>{checkIn.mentor}</strong>
            {checkIn.mentorEmail ? ` (${checkIn.mentorEmail})` : ''}. They open it, complete the
            plan with the student and submit — all in isolation, no account needed.
          </p>
          <label className="fld">
            <span>Private link</span>
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
          </label>
          <div className="modal-foot">
            <a
              className="btn btn-outline"
              href={`mailto:${checkIn.mentorEmail ?? ''}?subject=${subject}&body=${body}`}
            >
              <Icon.Mail /> Email the mentor
            </a>
            <Btn tone="primary" icon={Icon.Doc} onClick={copy}>
              Copy link
            </Btn>
          </div>
          <p className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
            Automated email delivery is wired on deploy (AWS SES, af-south-1); for now, copy the
            link or use your own mail client.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── Mentors registry ─────────────────────────── */

function MentorsTab({ mentors, toast }) {
  const [adding, setAdding] = useState(false);
  const fileRef = useRef(null);

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const rows = parseMentorCsv(text);
    if (!rows.length) return toast('No mentor rows found in that file.', 'err');
    let ok = 0;
    for (const r of rows) {
      try {
        await api.createMentor(r);
        ok++;
      } catch {
        /* skip bad rows */
      }
    }
    invMentors();
    toast(`Imported ${ok} of ${rows.length} mentors.`);
  }

  async function remove(m) {
    if (!window.confirm(`Remove ${m.name}?`)) return;
    try {
      await api.deleteMentor(m.id);
      invMentors();
      toast('Mentor removed.');
    } catch (err) {
      toast(err.message || 'Could not remove.', 'err');
    }
  }

  return (
    <>
      {adding && <MentorForm onClose={() => setAdding(false)} toast={toast} />}
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: 'none' }}
        onChange={onFile}
      />
      <Card
        title="Mentors"
        sub="External mentors who complete development plans via a link — they never log in. Add them here or upload a spreadsheet."
        action={
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn icon={Icon.Upload} onClick={() => fileRef.current?.click()}>
              Upload CSV
            </Btn>
            <Btn tone="primary" icon={Icon.Plus} onClick={() => setAdding(true)}>
              Add mentor
            </Btn>
          </div>
        }
      >
        {mentors.length === 0 ? (
          <EmptyState
            icon={Icon.Users}
            title="No mentors yet"
            sub="Add a mentor, or upload a CSV with columns: name, email, phone, organisation."
          />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Organisation</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {mentors.map((m) => (
                <tr key={m.id}>
                  <td>
                    <div className="cell-id">
                      <Avatar name={m.name} size={26} />
                      <strong>{m.name}</strong>
                    </div>
                  </td>
                  <td>{m.email}</td>
                  <td>{m.phone || <span className="muted">—</span>}</td>
                  <td>{m.organisation || <span className="muted">—</span>}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="link-btn" onClick={() => remove(m)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

/** Parse a mentor CSV: header row with name/email(/phone/organisation), any order. */
function parseMentorCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const split = (l) => l.split(/[,;\t]/).map((s) => s.trim().replace(/^"|"$/g, ''));
  const header = split(lines[0]).map((h) => h.toLowerCase());
  const hasHeader = header.some((h) => /name|email|e-mail/.test(h));
  const idx = {
    name: header.findIndex((h) => /name/.test(h)),
    email: header.findIndex((h) => /email|e-mail/.test(h)),
    phone: header.findIndex((h) => /phone|cell|mobile/.test(h)),
    org: header.findIndex((h) => /org|company|school|institution/.test(h)),
  };
  const body = hasHeader ? lines.slice(1) : lines;
  const cols = hasHeader ? idx : { name: 0, email: 1, phone: 2, org: 3 };
  return body
    .map((l) => {
      const c = split(l);
      const name = (cols.name >= 0 ? c[cols.name] : '') || '';
      const email = (cols.email >= 0 ? c[cols.email] : '') || '';
      return {
        name,
        email,
        phone: cols.phone >= 0 ? c[cols.phone] || undefined : undefined,
        organisation: cols.org >= 0 ? c[cols.org] || undefined : undefined,
      };
    })
    .filter((r) => r.name && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email));
}

function MentorForm({ onClose, toast }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', organisation: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function submit(e) {
    e.preventDefault();
    if (!form.name.trim()) return setError('A name is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
      return setError('A valid email is required.');
    setBusy(true);
    setError(null);
    try {
      await api.createMentor({
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || undefined,
        organisation: form.organisation.trim() || undefined,
      });
      invMentors();
      toast('Mentor added.');
      onClose();
    } catch (err) {
      setError(err.message || 'Could not add the mentor.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="modal-head">
          <div className="modal-title">Add mentor</div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.X />
          </button>
        </div>
        <form onSubmit={submit} className="modal-body">
          <div className="fld-row">
            <label className="fld">
              <span>Name</span>
              <input value={form.name} onChange={(e) => set({ name: e.target.value })} autoFocus />
            </label>
            <label className="fld">
              <span>Email</span>
              <input
                type="email"
                value={form.email}
                onChange={(e) => set({ email: e.target.value })}
              />
            </label>
          </div>
          <div className="fld-row">
            <label className="fld">
              <span>Phone (optional)</span>
              <input value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
            </label>
            <label className="fld">
              <span>Organisation (optional)</span>
              <input
                value={form.organisation}
                onChange={(e) => set({ organisation: e.target.value })}
              />
            </label>
          </div>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="modal-foot">
            <Btn type="button" onClick={onClose}>
              Cancel
            </Btn>
            <Btn tone="primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Add mentor'}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─────────────────────────────── The ADP wizard ─────────────────────────── */

const ADP_STEPS = [
  { key: 'setup', label: 'Setup' },
  { key: 'screener', label: 'Screener' },
  { key: 'content', label: 'Content' },
  { key: 'assessments', label: 'Assessments' },
  { key: 'worklife', label: 'Work-life' },
  { key: 'careers', label: 'Careers' },
  { key: 'plan', label: 'Interventions' },
  { key: 'review', label: 'Review' },
];

const emptySections = () => ({
  content: { modules: {}, note: '' },
  assessments: { modules: {}, note: '' },
  worklife: { ratings: {}, note: '' },
  careers: { ratings: {}, note: '' },
});

/**
 * The plan wizard — completed by an external mentor on the public page, or by an
 * admin in-house. `athlete` is fixed (name + faculty + student number), `period`
 * is set at assignment, `initial` seeds a resumed plan, and `onSubmit(payload)`
 * does the actual save (public submit or admin create).
 */
export function AdpWizard({ athlete, period, initial, onSubmit, onClose }) {
  const idRef = useRef(0);
  const nextId = () => `l${(idRef.current += 1)}`;

  const [step, setStep] = useState(0);
  const [scheduledNext, setScheduledNext] = useState(initial?.scheduledNext ?? '');
  const [modules, setModules] = useState(() =>
    initial?.modules?.length
      ? initial.modules.map((m, i) => ({ _id: `l${i}`, ...m, screener: m.screener ?? {} }))
      : [{ _id: 'l0', code: '', name: '', screener: {} }],
  );
  const [sections, setSections] = useState(() => ({
    ...emptySections(),
    ...(initial?.sections ?? {}),
  }));
  const [plan, setPlan] = useState(() =>
    (initial?.plan ?? []).map((p, i) => ({ _id: `p${i}`, ...p })),
  );
  const [overallNote, setOverallNote] = useState(initial?.note ?? '');
  const [faqOpen, setFaqOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Live status per module + the flagged set that drives the module sections.
  const scored = modules
    .filter((m) => m.code.trim())
    .map((m) => ({ ...m, status: moduleScreenStatus(m.screener) }));
  const flagged = flaggedModules(scored);
  const screen = screenerSummary(scored);

  /* ── module edits ── */
  const addModule = () =>
    setModules((ms) => [...ms, { _id: nextId(), code: '', name: '', screener: {} }]);
  const removeModule = (id) => setModules((ms) => ms.filter((m) => m._id !== id));
  const setModuleField = (id, patch) =>
    setModules((ms) => ms.map((m) => (m._id === id ? { ...m, ...patch } : m)));

  // Typing a code looks it up in the UCT catalogue: auto-fills the title,
  // convener, credits and faculty, and auto-assigns an intrinsic difficulty —
  // which also pre-selects the "how hard" screener answer (mentor can override).
  const setModuleCode = (id, value) =>
    setModules((ms) =>
      ms.map((m) => {
        if (m._id !== id) return m;
        const course = lookupCourse(value);
        const diff = moduleDifficulty(value);
        const next = { ...m, code: value };
        if (course) {
          if (!m.name || m._auto) {
            next.name = course.title;
            next._auto = true;
          }
          next.convener = course.convener || undefined;
          next.credits = course.credits ?? undefined;
          next.faculty = course.faculty || undefined;
          next.nqf = course.nqf ?? undefined;
        } else {
          next.convener = next.credits = next.faculty = next.nqf = undefined;
          if (m._auto) {
            next.name = '';
            next._auto = false;
          }
        }
        next.difficulty = diff ? diff.level : undefined;
        if (diff && !m.screener?.difficulty) {
          next.screener = { ...m.screener, difficulty: diff.screener };
        }
        return next;
      }),
    );
  const setScreener = (id, key, val) =>
    setModules((ms) =>
      ms.map((m) => (m._id === id ? { ...m, screener: { ...m.screener, [key]: val } } : m)),
    );

  /* ── rating edits (one agreed rating per line) ── */
  const setStudentRating = (secKey, attrKey, val) =>
    setSections((s) => ({
      ...s,
      [secKey]: {
        ...s[secKey],
        ratings: { ...s[secKey].ratings, [attrKey]: val },
      },
    }));
  const setModuleRating = (secKey, code, attrKey, val) =>
    setSections((s) => ({
      ...s,
      [secKey]: {
        ...s[secKey],
        modules: {
          ...s[secKey].modules,
          [code]: { ...s[secKey].modules[code], [attrKey]: val },
        },
      },
    }));
  const setSectionNote = (secKey, note) =>
    setSections((s) => ({ ...s, [secKey]: { ...s[secKey], note } }));

  /* ── plan edits ── */
  const toggleIntervention = (type) =>
    setPlan((p) => {
      const existing = p.find((i) => i.type === type && !i.module);
      if (existing) return p.filter((i) => i !== existing);
      return [
        ...p,
        { _id: nextId(), type, module: '', referredTo: '', owner: '', dueDate: '', note: '' },
      ];
    });
  const setPlanField = (id, patch) =>
    setPlan((p) => p.map((i) => (i._id === id ? { ...i, ...patch } : i)));
  const removePlanItem = (id) => setPlan((p) => p.filter((i) => i._id !== id));

  const go = (i) => setStep(Math.max(0, Math.min(ADP_STEPS.length - 1, i)));

  async function save() {
    setBusy(true);
    setError(null);

    // Persist only real modules; prune section ratings to the flagged set.
    const flaggedCodes = new Set(flagged.map((m) => m.code));
    const cleanModules = scored.map((m) => ({
      code: m.code.trim(),
      name: m.name.trim() || undefined,
      status: m.status,
      screener: m.screener,
      convener: m.convener,
      credits: m.credits,
      faculty: m.faculty,
      nqf: m.nqf,
      difficulty: m.difficulty,
    }));
    const cleanSections = {};
    for (const sec of ADP_SECTIONS) {
      const block = sections[sec.key];
      if (sec.scope === 'module') {
        const mods = {};
        for (const [code, ratings] of Object.entries(block.modules)) {
          if (flaggedCodes.has(code)) mods[code] = ratings;
        }
        if (Object.keys(mods).length || block.note) {
          cleanSections[sec.key] = { modules: mods, note: block.note || undefined };
        }
      } else if (Object.keys(block.ratings).length || block.note) {
        cleanSections[sec.key] = { ratings: block.ratings, note: block.note || undefined };
      }
    }
    const cleanPlan = plan.map((i) => ({
      type: i.type,
      module: i.module || undefined,
      referredTo: i.referredTo || undefined,
      owner: i.owner || undefined,
      dueDate: i.dueDate || undefined,
      note: i.note || undefined,
    }));
    const followUpRequired =
      cleanPlan.length || scored.some((m) => m.status === 'at_risk') ? 'Yes' : 'No';

    try {
      await onSubmit({
        studentNumber: athlete.studentNumber,
        athleteName: `${athlete.firstName} ${athlete.lastName}`,
        followUpRequired,
        answers: {},
        note: overallNote || undefined,
        kind: ADP_KIND,
        period: period || undefined,
        modules: cleanModules,
        sections: cleanSections,
        plan: cleanPlan,
        scheduledNext: scheduledNext || undefined,
      });
    } catch (err) {
      setError(err.message || 'Could not submit the plan.');
      setBusy(false);
    }
  }

  const stepKey = ADP_STEPS[step].key;

  return (
    <div className="adp-wizard">
      <div className="adp-top">
        <div>
          <div className="adp-eyebrow">Academic Development Plan · {period}</div>
          <div className="adp-title">
            {athlete ? `${athlete.firstName} ${athlete.lastName}` : 'New plan'}
            {athlete && (
              <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>
                {' '}
                · {athlete.faculty || 'Faculty TBC'}
              </span>
            )}
          </div>
        </div>
        <div className="adp-top-actions">
          <button
            type="button"
            className={`adp-guide-btn ${faqOpen ? 'on' : ''}`}
            onClick={() => setFaqOpen((v) => !v)}
            aria-expanded={faqOpen}
          >
            <Icon.Mail /> Question bank
          </button>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.X />
          </button>
        </div>
      </div>

      {faqOpen && <QuestionBankPanel onClose={() => setFaqOpen(false)} />}

      <Stepper steps={ADP_STEPS} step={step} onJump={go} screen={screen} planCount={plan.length} />

      <div className="adp-stage">
        {stepKey === 'setup' && (
          <SetupStep
            athlete={athlete}
            period={period}
            scheduledNext={scheduledNext}
            setScheduledNext={setScheduledNext}
          />
        )}

        {stepKey === 'screener' && (
          <ScreenerStep
            modules={modules}
            scored={scored}
            screen={screen}
            onAdd={addModule}
            onRemove={removeModule}
            onField={setModuleField}
            onCode={setModuleCode}
            onScreener={setScreener}
          />
        )}

        {ADP_SECTION_META[stepKey]?.scope === 'module' && (
          <ModuleSectionStep
            section={ADP_SECTION_META[stepKey]}
            flagged={flagged}
            block={sections[stepKey]}
            onRate={setModuleRating}
            onNote={setSectionNote}
          />
        )}

        {ADP_SECTION_META[stepKey]?.scope === 'student' && (
          <StudentSectionStep
            section={ADP_SECTION_META[stepKey]}
            block={sections[stepKey]}
            onRate={setStudentRating}
            onNote={setSectionNote}
          />
        )}

        {stepKey === 'plan' && (
          <PlanStep
            plan={plan}
            flagged={flagged}
            onToggle={toggleIntervention}
            onField={setPlanField}
            onRemove={removePlanItem}
          />
        )}

        {stepKey === 'review' && (
          <ReviewStep
            athlete={athlete}
            period={period}
            screen={screen}
            flagged={flagged}
            sections={sections}
            plan={plan}
            note={overallNote}
            setNote={setOverallNote}
          />
        )}
      </div>

      {error && (
        <div className="form-error" role="alert" style={{ margin: '0 4px 12px' }}>
          {error}
        </div>
      )}

      <div className="adp-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <div className="adp-foot-nav">
          <Btn onClick={() => go(step - 1)} disabled={step === 0}>
            Back
          </Btn>
          {step < ADP_STEPS.length - 1 ? (
            <Btn tone="primary" icon={Icon.Arrow} onClick={() => go(step + 1)}>
              Next
            </Btn>
          ) : (
            <Btn tone="primary" icon={Icon.Check} onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save development plan'}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

function Stepper({ steps, step, onJump, screen, planCount }) {
  return (
    <div className="adp-stepper" role="tablist">
      {steps.map((s, i) => {
        const badge =
          s.key === 'screener' && screen.flagged
            ? screen.flagged
            : s.key === 'plan' && planCount
              ? planCount
              : null;
        return (
          <button
            key={s.key}
            type="button"
            className={`adp-step ${i === step ? 'on' : ''} ${i < step ? 'done' : ''}`}
            onClick={() => onJump(i)}
          >
            <span className="adp-step-n">{i < step ? '✓' : i + 1}</span>
            <span className="adp-step-l">{s.label}</span>
            {badge ? <span className="adp-step-badge">{badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function SetupStep({ athlete, period, scheduledNext, setScheduledNext }) {
  return (
    <Card
      title="Before you start"
      sub="This is a conversation with the student — screen their modules, talk through each area, rate it together, and agree the support. Use the question bank up top to draw them out."
    >
      <div className="fld-row">
        <label className="fld">
          <span>Student-athlete</span>
          <div className="fld-static">
            {athlete.firstName} {athlete.lastName} · {athlete.studentNumber}
          </div>
        </label>
        <label className="fld">
          <span>Term</span>
          <div className="fld-static">{period}</div>
        </label>
        <label className="fld">
          <span>Next session (optional)</span>
          <input
            type="date"
            value={scheduledNext}
            onChange={(e) => setScheduledNext(e.target.value)}
          />
        </label>
      </div>
      {athlete.faculty && (
        <p className="muted" style={{ marginTop: 4, fontSize: 12.5 }}>
          {athlete.faculty}
          {athlete.degree ? ` · ${athlete.degree}` : ''}
        </p>
      )}
    </Card>
  );
}

function ScreenerStep({ modules, scored, screen, onAdd, onRemove, onField, onCode, onScreener }) {
  const statusOf = (m) => (m.code.trim() ? moduleScreenStatus(m.screener) : null);
  return (
    <Card
      title="Module screener"
      sub={`List the modules they're taking this term and triage each. Type a UCT code and the title, convener and difficulty fill in from the ${CATALOGUE_SIZE.toLocaleString()} in the 2026 handbooks. Easy modules screen clear.`}
      action={
        <div className="screen-tally">
          <span className="dot tone-green" /> {screen.on_track} on track
          <span className="dot tone-amber" style={{ marginLeft: 12 }} /> {screen.watch} watch
          <span className="dot tone-red" style={{ marginLeft: 12 }} /> {screen.at_risk} at risk
        </div>
      }
    >
      <div className="module-list">
        {modules.map((m) => {
          const status = statusOf(m);
          const meta = status ? MODULE_STATUS_META[status] : null;
          const diff = m.difficulty ? DIFFICULTY_META[m.difficulty] : null;
          const listId = `courses-${m._id}`;
          const suggestions = courseSuggestions(m.code);
          return (
            <div key={m._id} className={`module-card ${meta ? `flag-${meta.tone}` : ''}`}>
              <div className="module-card-head">
                <input
                  className="module-code"
                  value={m.code}
                  list={listId}
                  onChange={(e) => onCode(m._id, e.target.value)}
                  placeholder="Code — e.g. ECO1010F"
                />
                <datalist id={listId}>
                  {suggestions.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.title}
                    </option>
                  ))}
                </datalist>
                <input
                  className="module-name"
                  value={m.name}
                  onChange={(e) => onField(m._id, { name: e.target.value, _auto: false })}
                  placeholder="Module name (optional)"
                />
                {diff && (
                  <Pill
                    tone={diff.tone}
                    title={`Auto-assigned · ${moduleDifficulty(m.code)?.reason ?? ''}`}
                  >
                    {diff.label}
                  </Pill>
                )}
                {meta && <Pill tone={meta.tone}>{meta.label}</Pill>}
                <button
                  className="icon-btn"
                  onClick={() => onRemove(m._id)}
                  aria-label="Remove module"
                  disabled={modules.length === 1}
                >
                  <Icon.X />
                </button>
              </div>
              {(m.convener || m.credits || m.faculty) && (
                <div className="module-meta">
                  {m.faculty && <span>{m.faculty}</span>}
                  {m.credits != null && <span>{m.credits} credits</span>}
                  {m.nqf != null && <span>NQF {m.nqf}</span>}
                  {m.convener && <span>Convener: {m.convener}</span>}
                </div>
              )}
              <div className="screen-grid">
                {SCREENER_QUESTIONS.map((q) => {
                  const auto = q.key === 'difficulty' && diff;
                  return (
                    <div key={q.key} className="screen-q">
                      <span className="screen-q-label">
                        {q.label}
                        {auto && (
                          <span className="auto-tag" title="Auto-assigned from the handbook">
                            auto
                          </span>
                        )}
                      </span>
                      <div className="opt-row">
                        {q.options.map((opt) => {
                          const on = m.screener[q.key] === opt;
                          const level = q.concern[opt];
                          return (
                            <button
                              key={opt}
                              type="button"
                              className={`opt ${on ? 'on' : ''} ${on && level ? `bad-${level === 'at_risk' ? 'red' : 'amber'}` : ''}`}
                              onClick={() => onScreener(m._id, q.key, opt)}
                            >
                              {opt}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <Btn icon={Icon.Plus} onClick={onAdd} style={{ marginTop: 12 }}>
        Add module
      </Btn>
      {scored.length > 0 && screen.flagged === 0 && (
        <p className="muted" style={{ marginTop: 12 }}>
          Nothing flagged — every module screened clear. You can skip straight to work-life balance
          and careers.
        </p>
      )}
    </Card>
  );
}

/**
 * One student-or-mentor rating on the 1–5 scale, as a slider. 0 means unset; the
 * band tag and the slider's accent colour reflect the current value.
 */
function RatingScale({ value, onChange, label, scale }) {
  const band = value ? scale[value - 1] : null;
  const accent = band
    ? { red: 'var(--coral)', amber: 'var(--gold-warm)', green: 'var(--green-bright)' }[band.tone]
    : 'var(--line2)';
  return (
    <div className="adp-scale">
      <input
        type="range"
        className="adp-slider"
        min="0"
        max="5"
        step="1"
        value={value ?? 0}
        style={{ accentColor: accent }}
        aria-label={label}
        title={band ? `${value} · ${band.tag} — ${band.desc}` : 'Not yet rated'}
        onChange={(e) => {
          const v = Number(e.target.value);
          onChange(v === 0 ? undefined : v);
        }}
      />
      <span className={`adp-scale-tag ${band ? `t-${band.tone}` : ''}`}>
        {band ? `${value} · ${band.tag}` : '—'}
      </span>
      {band && <span className="adp-scale-desc">{band.desc}</span>}
    </div>
  );
}

/**
 * The pop-up that explains what each rating means — tailored to this attribute
 * (so a 3 on "Grasp of core concepts" reads its own words), with a practical
 * "to improve" tip the mentor can act on.
 */
function ScaleLegend({ attr, scale }) {
  return (
    <div className="adp-legend" role="tooltip">
      <div className="adp-legend-title">{attr.label} — what the ratings mean</div>
      {scale.map((s) => (
        <div key={s.value} className="adp-legend-row">
          <span className={`adp-legend-dot tone-${s.tone}`}>{s.value}</span>
          <span>
            <strong>{s.tag}</strong> — {s.desc}
          </span>
        </div>
      ))}
      {attr.improve && (
        <div className="adp-legend-improve">
          <strong>To improve:</strong> {attr.improve}
        </div>
      )}
    </div>
  );
}

function RatingRow({ attr, rating, onChange }) {
  const [info, setInfo] = useState(false);
  const scale = attrScale(attr);
  const value = ratingValue(rating) ?? undefined;
  return (
    <div className="adp-attr">
      <div className="adp-attr-head">
        <div>
          <div className="adp-attr-name">{attr.label}</div>
          <div className="adp-attr-desc">{attr.desc}</div>
        </div>
        <div className="adp-info-wrap">
          <button
            type="button"
            className={`adp-info ${info ? 'on' : ''}`}
            aria-label="What do the ratings mean?"
            aria-expanded={info}
            onClick={() => setInfo((v) => !v)}
            onBlur={() => setTimeout(() => setInfo(false), 120)}
          >
            ?
          </button>
          {info && <ScaleLegend attr={attr} scale={scale} />}
        </div>
      </div>
      <div className="adp-scale-row">
        <RatingScale value={value} onChange={onChange} label={attr.label} scale={scale} />
      </div>
    </div>
  );
}

function SectionNote({ value, onChange, placeholder }) {
  return (
    <label className="adp-note">
      <span>Notes &amp; agreed actions</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function ModuleSectionStep({ section, flagged, block, onRate, onNote }) {
  const [activeCode, setActiveCode] = useState(flagged[0]?.code ?? null);
  // Keep the active tab valid if the flagged set changes between visits.
  const active = flagged.find((m) => m.code === activeCode) ?? flagged[0];

  return (
    <Card title={section.title} sub={section.what}>
      {flagged.length === 0 ? (
        <EmptyState
          icon={Icon.Check}
          title="No modules flagged"
          sub="Nothing screened into this section. Move on, or flag a module in the screener."
        />
      ) : (
        <>
          {flagged.length > 1 && (
            <div className="mod-switch" role="tablist" aria-label="Modules being assessed">
              {flagged.map((m) => {
                const on = m.code === active.code;
                return (
                  <button
                    key={m.code}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    className={`mod-switch-btn ${on ? 'on' : ''} flag-${MODULE_STATUS_META[m.status].tone}`}
                    onClick={() => setActiveCode(m.code)}
                  >
                    <span className="mod-switch-code">{m.code}</span>
                    <span className={`mod-switch-dot tone-${MODULE_STATUS_META[m.status].tone}`} />
                  </button>
                );
              })}
            </div>
          )}

          <div className="adp-modblock">
            <div className="adp-modblock-head">
              <strong>{active.code}</strong>
              {active.name && <span className="muted"> · {active.name}</span>}
              <Pill tone={MODULE_STATUS_META[active.status].tone}>
                {MODULE_STATUS_META[active.status].label}
              </Pill>
            </div>
            {section.attrs.map((attr) => (
              <RatingRow
                key={attr.key}
                attr={attr}
                rating={block.modules[active.code]?.[attr.key]}
                onChange={(v) => onRate(section.key, active.code, attr.key, v)}
              />
            ))}
          </div>

          <SectionNote
            value={block.note}
            onChange={(v) => onNote(section.key, v)}
            placeholder={`Anything to record on ${section.title.toLowerCase()}…`}
          />
        </>
      )}
    </Card>
  );
}

function StudentSectionStep({ section, block, onRate, onNote }) {
  return (
    <Card title={section.title} sub={section.what}>
      {section.attrs.map((attr) => (
        <RatingRow
          key={attr.key}
          attr={attr}
          rating={block.ratings[attr.key]}
          onChange={(v) => onRate(section.key, attr.key, v)}
        />
      ))}
      <SectionNote
        value={block.note}
        onChange={(v) => onNote(section.key, v)}
        placeholder={`Anything to record on ${section.title.toLowerCase()}…`}
      />
    </Card>
  );
}

function PlanStep({ plan, flagged, onToggle, onField, onRemove }) {
  return (
    <Card
      title="Intervention plan"
      sub="Choose the actions that come out of this plan. Each one is also logged in the intervention register."
    >
      <div className="int-list">
        {INTERVENTION_TYPES.map((t) => {
          const items = plan.filter((i) => i.type === t.key);
          const on = items.length > 0;
          return (
            <div key={t.key} className={`int-card ${on ? 'on' : ''}`}>
              <button type="button" className="int-toggle" onClick={() => onToggle(t.key)}>
                <span className={`int-check ${on ? 'on' : ''}`}>{on ? <Icon.Check /> : null}</span>
                <span>
                  <span className="int-name">{t.label}</span>
                  <span className="int-desc">{t.desc}</span>
                </span>
              </button>
              {items.map((item) => (
                <div key={item._id} className="int-fields">
                  {t.module && (
                    <label className="fld">
                      <span>Module</span>
                      <select
                        value={item.module}
                        onChange={(e) => onField(item._id, { module: e.target.value })}
                      >
                        <option value="">— whole plan —</option>
                        {flagged.map((m) => (
                          <option key={m.code} value={m.code}>
                            {m.code}
                            {m.name ? ` · ${m.name}` : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {t.referral && (
                    <label className="fld">
                      <span>Referred to</span>
                      <select
                        value={item.referredTo}
                        onChange={(e) => onField(item._id, { referredTo: e.target.value })}
                      >
                        <option value="">— choose service —</option>
                        {REFERRAL_TARGETS.map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="fld">
                    <span>Owner</span>
                    <input
                      value={item.owner}
                      onChange={(e) => onField(item._id, { owner: e.target.value })}
                      placeholder="Who drives this?"
                    />
                  </label>
                  <label className="fld">
                    <span>Due</span>
                    <input
                      type="date"
                      value={item.dueDate}
                      onChange={(e) => onField(item._id, { dueDate: e.target.value })}
                    />
                  </label>
                  <label className="fld" style={{ flexBasis: '100%' }}>
                    <span>Note</span>
                    <input
                      value={item.note}
                      onChange={(e) => onField(item._id, { note: e.target.value })}
                      placeholder="Optional detail"
                    />
                  </label>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => onRemove(item._id)}
                    style={{ alignSelf: 'center' }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ReviewStep({ athlete, period, screen, flagged, sections, plan, note, setNote }) {
  const sum = adpSummary({ modules: flagged, sections, plan });
  const axes = sectionAverages({ sections });
  return (
    <Card
      title="Review & save"
      sub={`${athlete ? `${athlete.firstName} ${athlete.lastName}` : 'Student'}${period ? ` · ${period}` : ''}`}
    >
      <div className="kpi-row">
        <KPI label="Modules screened" num={screen.total} sub={`${screen.flagged} flagged`} />
        <KPI
          label="Overall"
          num={sum.meanBand ? sum.meanBand.tag : '—'}
          sub={sum.mean ? `avg ${sum.mean.toFixed(1)} / 5` : 'not yet rated'}
          tone={sum.meanBand && sum.meanBand.tone !== 'green' ? 'amber' : ''}
        />
        <KPI
          label="Lowest rated area"
          num={sum.floorBand ? sum.floorBand.tag : '—'}
          tone={sum.floorBand && sum.floorBand.tone !== 'green' ? 'amber' : ''}
        />
        <KPI label="Interventions" num={plan.length} />
      </div>

      <Card title="How they’re doing overall" sub="Mean rating across the four development areas.">
        <RadarChart axes={axes} />
      </Card>

      {flagged.length > 0 && (
        <div className="review-block">
          <div className="sub-head">Flagged modules</div>
          <div className="chip-row">
            {flagged.map((m) => (
              <span key={m.code} className={`chip flag-${MODULE_STATUS_META[m.status].tone}`}>
                {m.code} · {MODULE_STATUS_META[m.status].label}
              </span>
            ))}
          </div>
        </div>
      )}

      {plan.length > 0 && (
        <div className="review-block">
          <div className="sub-head">Planned interventions</div>
          <ul className="review-list">
            {plan.map((i) => (
              <li key={i._id}>
                <strong>{interventionLabel(i)}</strong>
                {i.owner ? ` — ${i.owner}` : ''}
                {i.dueDate ? ` · due ${formatDeadlineLong(i.dueDate)}` : ''}
                {i.referredTo ? ` · → ${i.referredTo}` : ''}
              </li>
            ))}
          </ul>
          <p className="muted" style={{ fontSize: 12.5 }}>
            These will also be added to the intervention log.
          </p>
        </div>
      )}

      <SectionNote
        value={note}
        onChange={setNote}
        placeholder="Overall summary of the conversation and next steps…"
      />
    </Card>
  );
}

/* ─────────────────────── Question bank (ask the student) ────────────────── */

function QuestionBankPanel({ onClose }) {
  return (
    <div className="faq-panel" role="region" aria-label="Question bank">
      <div className="faq-head">
        <div className="faq-title">Question bank — what to ask the student</div>
        <button className="icon-btn" onClick={onClose} aria-label="Close question bank">
          <Icon.X />
        </button>
      </div>
      <div className="qbank-grid">
        {QUESTION_BANK.map((group) => (
          <div key={group.area} className="qbank-group">
            <div className="qbank-area">{group.area}</div>
            <ul className="qbank-list">
              {group.questions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ──────────────────────────────── Radar chart ───────────────────────────── */

/** A compact SVG radar over the four development areas (mean rating 1–5). */
function RadarChart({ axes }) {
  const rated = axes.filter((a) => a.value != null);
  if (rated.length < 3) {
    return (
      <p className="muted" style={{ fontSize: 13 }}>
        Rate at least three of the four areas to see the overall shape. So far:{' '}
        {rated.length
          ? rated.map((a) => `${a.title} ${a.value.toFixed(1)}`).join(', ')
          : 'nothing rated yet'}
        .
      </p>
    );
  }
  const size = 300;
  const c = size / 2;
  const R = 104;
  const N = axes.length;
  const SHORT = {
    content: 'Content',
    assessments: 'Assessments',
    worklife: 'Work-life',
    careers: 'Careers',
  };
  const ang = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / N;
  const pt = (i, r) => [c + Math.cos(ang(i)) * r, c + Math.sin(ang(i)) * r];

  const rings = [1, 2, 3, 4, 5].map((lvl) => {
    const pts = axes
      .map((_, i) =>
        pt(i, (R * lvl) / 5)
          .map((n) => n.toFixed(1))
          .join(','),
      )
      .join(' ');
    return <polygon key={lvl} points={pts} fill="none" stroke="var(--line)" strokeWidth="1" />;
  });
  const spokes = axes.map((a, i) => {
    const [x, y] = pt(i, R);
    return (
      <line
        key={a.key}
        x1={c}
        y1={c}
        x2={x.toFixed(1)}
        y2={y.toFixed(1)}
        stroke="var(--line)"
        strokeWidth="1"
      />
    );
  });
  const shape = axes
    .map((a, i) =>
      pt(i, (R * (a.value ?? 0)) / 5)
        .map((n) => n.toFixed(1))
        .join(','),
    )
    .join(' ');
  const dots = axes.map((a, i) => {
    const [x, y] = pt(i, (R * (a.value ?? 0)) / 5);
    return (
      <circle key={a.key} cx={x.toFixed(1)} cy={y.toFixed(1)} r="3.5" fill="var(--green-mid)" />
    );
  });
  const labels = axes.map((a, i) => {
    const [lx, ly] = pt(i, R + 20);
    const anchor = Math.abs(lx - c) < 8 ? 'middle' : lx > c ? 'start' : 'end';
    return (
      <text
        key={a.key}
        x={lx.toFixed(1)}
        y={(ly + 4).toFixed(1)}
        fontSize="12"
        fontWeight="600"
        fill="var(--ink)"
        textAnchor={anchor}
      >
        {SHORT[a.key] ?? a.title}
        <tspan fill="var(--muted)"> {a.value != null ? a.value.toFixed(1) : '—'}</tspan>
      </text>
    );
  });

  return (
    <div className="radar-wrap">
      <svg
        viewBox={`-46 -8 ${size + 92} ${size + 16}`}
        width="100%"
        style={{ maxWidth: 360, display: 'block', margin: '0 auto' }}
      >
        {rings}
        {spokes}
        <polygon
          points={shape}
          fill="var(--green-pale)"
          stroke="var(--green-mid)"
          strokeWidth="2"
          opacity="0.9"
        />
        {dots}
        {labels}
      </svg>
    </div>
  );
}

/* ──────────────────────── Development plan detail view ───────────────────── */

/** A read-only rating chip for the detail view (single agreed rating). */
function DetailRating({ attr, rating }) {
  const scale = attrScale(attr);
  const v = ratingValue(rating);
  const band = v ? scale[v - 1] : null;
  return (
    <div className="det-rating">
      <div className="det-rating-label">{attr.label}</div>
      <div className="det-rating-vals">
        <span className={`det-chip ${band ? `tone-${band.tone}` : 'muted'}`}>
          {band ? `${v} · ${band.tag}` : '—'}
        </span>
      </div>
    </div>
  );
}

export function AdpDetail({ checkIn, athletes, onClose }) {
  const isAdp = checkIn.kind === ADP_KIND;
  const sum = isAdp ? adpSummary(checkIn) : null;
  const athlete = athletes.find((a) => a.studentNumber === checkIn.studentNumber);
  const modules = checkIn.modules ?? [];
  const sections = checkIn.sections ?? {};
  const plan = checkIn.plan ?? [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal det-modal" onClick={(e) => e.stopPropagation()}>
        <div className="det-hero">
          <button className="icon-btn det-close" onClick={onClose} aria-label="Close">
            <Icon.X />
          </button>
          <div className="det-eyebrow">
            {isAdp ? 'Academic Development Plan' : 'Check-in'}
            {checkIn.period ? ` · ${checkIn.period}` : ''}
          </div>
          <div className="det-name">{checkIn.athleteName}</div>
          <div className="det-sub">
            {athlete?.faculty ? `${athlete.faculty} · ` : ''}
            {checkIn.studentNumber}
            {checkIn.mentor ? ` · Mentor: ${checkIn.mentor}` : ''}
            {` · ${formatDeadlineLong(checkIn.date)}`}
          </div>
          {isAdp && (
            <div className="det-hero-stats">
              <div className="det-stat">
                <span className="det-stat-n">
                  {sum.flaggedModules}/{sum.modules}
                </span>
                <span className="det-stat-l">modules flagged</span>
              </div>
              <div className="det-stat">
                <span className={`det-stat-n ${sum.meanBand ? `t-${sum.meanBand.tone}` : ''}`}>
                  {sum.meanBand ? sum.meanBand.tag : '—'}
                </span>
                <span className="det-stat-l">overall</span>
              </div>
              <div className="det-stat">
                <span className={`det-stat-n ${sum.floorBand ? `t-${sum.floorBand.tone}` : ''}`}>
                  {sum.floorBand ? sum.floorBand.tag : '—'}
                </span>
                <span className="det-stat-l">lowest area</span>
              </div>
              <div className="det-stat">
                <span className="det-stat-n">{sum.interventions}</span>
                <span className="det-stat-l">interventions</span>
              </div>
            </div>
          )}
        </div>

        <div className="det-body">
          {!isAdp && (
            <p className="muted">
              This is a legacy bi-weekly check-in. {checkInFlags(checkIn.answers)} of the 13 review
              questions flagged a concern.
            </p>
          )}

          {isAdp && modules.length > 0 && (
            <section className="det-sec">
              <div className="det-sec-title">Module screener</div>
              <div className="det-modrow">
                {modules.map((m) => (
                  <span
                    key={m.code}
                    className={`chip flag-${MODULE_STATUS_META[m.status]?.tone ?? 'muted'}`}
                  >
                    {m.code}
                    {m.difficulty ? ` · ${DIFFICULTY_META[m.difficulty].label}` : ''} ·{' '}
                    {MODULE_STATUS_META[m.status]?.label ?? '—'}
                  </span>
                ))}
              </div>
            </section>
          )}

          {isAdp && sum.rated > 0 && (
            <section className="det-sec">
              <div className="det-sec-title">How they’re doing overall</div>
              <RadarChart axes={sectionAverages(checkIn)} />
            </section>
          )}

          {isAdp &&
            ADP_SECTIONS.map((sec) => {
              const block = sections[sec.key];
              if (!block) return null;
              if (sec.scope === 'module') {
                const codes = Object.keys(block.modules ?? {});
                if (!codes.length && !block.note) return null;
                return (
                  <section key={sec.key} className="det-sec">
                    <div className="det-sec-title">{sec.title}</div>
                    {codes.map((code) => (
                      <div key={code} className="det-modblock">
                        <div className="det-modblock-head">{code}</div>
                        {sec.attrs.map((attr) => (
                          <DetailRating
                            key={attr.key}
                            attr={attr}
                            rating={block.modules[code]?.[attr.key]}
                          />
                        ))}
                      </div>
                    ))}
                    {block.note && <div className="det-note">{block.note}</div>}
                  </section>
                );
              }
              const rated = Object.keys(block.ratings ?? {});
              if (!rated.length && !block.note) return null;
              return (
                <section key={sec.key} className="det-sec">
                  <div className="det-sec-title">{sec.title}</div>
                  {sec.attrs.map((attr) =>
                    block.ratings?.[attr.key] ? (
                      <DetailRating key={attr.key} attr={attr} rating={block.ratings[attr.key]} />
                    ) : null,
                  )}
                  {block.note && <div className="det-note">{block.note}</div>}
                </section>
              );
            })}

          {isAdp && plan.length > 0 && (
            <section className="det-sec">
              <div className="det-sec-title">Intervention plan</div>
              <ul className="det-plan">
                {plan.map((i, idx) => (
                  <li key={idx}>
                    <strong>{interventionLabel(i)}</strong>
                    {i.owner ? ` — ${i.owner}` : ''}
                    {i.dueDate ? ` · due ${formatDeadlineLong(i.dueDate)}` : ''}
                    {i.referredTo ? ` · → ${i.referredTo}` : ''}
                    {i.note ? <div className="muted det-plan-note">{i.note}</div> : null}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {checkIn.note && (
            <section className="det-sec">
              <div className="det-sec-title">Summary</div>
              <div className="det-note">{checkIn.note}</div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════ Interventions ══════════════════════════════ */

function InterventionsTab({ athletes, interventions, toast }) {
  const [adding, setAdding] = useState(false);

  async function setStatus(iv, status) {
    try {
      await api.patchIntervention(iv.id, { status, version: iv.version });
      invInterventions();
      toast('Intervention updated.');
    } catch (err) {
      toast(err.message || 'Could not update.', 'err');
    }
  }

  return (
    <>
      {adding && (
        <InterventionForm athletes={athletes} onClose={() => setAdding(false)} toast={toast} />
      )}
      <Card
        title="Intervention log"
        sub="Concern → action → follow-up, per the SOP escalation procedure."
        action={
          <Btn
            tone="primary"
            icon={Icon.Plus}
            onClick={() => setAdding(true)}
            disabled={athletes.length === 0}
          >
            Raise intervention
          </Btn>
        }
      >
        {interventions.length === 0 ? (
          <EmptyState
            icon={Icon.Alert}
            title="No interventions"
            sub="Raise one when a concern needs action."
          />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Date</th>
                <th>Athlete</th>
                <th>Concern</th>
                <th>Action / referral</th>
                <th>Follow-up</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {interventions.map((i) => (
                <tr key={i.id}>
                  <td>{formatDeadlineLong(i.date)}</td>
                  <td>{i.athleteName}</td>
                  <td>{i.concern}</td>
                  <td>
                    {i.actionTaken || '—'}
                    {i.referredTo && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        → {i.referredTo}
                      </div>
                    )}
                  </td>
                  <td>{i.followUpDate ? formatDeadlineLong(i.followUpDate) : '—'}</td>
                  <td>
                    <Pill tone={statusMeta[i.status]?.tone}>{statusMeta[i.status]?.label}</Pill>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {i.status !== 'resolved' && (
                      <>
                        {i.status === 'open' && (
                          <Btn size="sm" onClick={() => setStatus(i, 'in_progress')}>
                            Start
                          </Btn>
                        )}{' '}
                        <Btn size="sm" tone="primary" onClick={() => setStatus(i, 'resolved')}>
                          Resolve
                        </Btn>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function InterventionForm({ athletes, onClose, toast }) {
  const [form, setForm] = useState({
    athleteId: athletes[0]?.id ?? '',
    date: new Date().toISOString().slice(0, 10),
    concern: '',
    actionTaken: '',
    referredTo: '',
    followUpDate: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const athlete = athletes.find((a) => a.id === form.athleteId);

  async function submit(e) {
    e.preventDefault();
    if (!athlete) return setError('Choose an athlete.');
    if (!form.concern.trim()) return setError('Describe the concern.');
    setBusy(true);
    setError(null);
    try {
      await api.createIntervention({
        athleteId: form.athleteId,
        studentNumber: athlete.studentNumber,
        athleteName: `${athlete.firstName} ${athlete.lastName}`,
        date: form.date,
        concern: form.concern.trim(),
        actionTaken: form.actionTaken.trim() || undefined,
        referredTo: form.referredTo || undefined,
        followUpDate: form.followUpDate || undefined,
      });
      invInterventions();
      toast('Intervention raised.');
      onClose();
    } catch (err) {
      setError(err.message || 'Could not raise the intervention.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-head">
          <div className="modal-title">Raise intervention</div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.X />
          </button>
        </div>
        <form onSubmit={submit} className="modal-body">
          <div className="fld-row">
            <label className="fld">
              <span>Athlete</span>
              <select value={form.athleteId} onChange={(e) => set({ athleteId: e.target.value })}>
                {athletes.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.firstName} {a.lastName} · {a.studentNumber}
                  </option>
                ))}
              </select>
            </label>
            <label className="fld">
              <span>Date</span>
              <input
                type="date"
                value={form.date}
                onChange={(e) => set({ date: e.target.value })}
              />
            </label>
          </div>
          <label className="fld">
            <span>Concern</span>
            <input
              value={form.concern}
              onChange={(e) => set({ concern: e.target.value })}
              placeholder="e.g. Missed three tutorials; failing Economics"
              autoFocus
            />
          </label>
          <label className="fld">
            <span>Action taken</span>
            <input
              value={form.actionTaken}
              onChange={(e) => set({ actionTaken: e.target.value })}
              placeholder="e.g. Met with student; arranged tutor"
            />
          </label>
          <div className="fld-row">
            <label className="fld">
              <span>Referred to</span>
              <select value={form.referredTo} onChange={(e) => set({ referredTo: e.target.value })}>
                <option value="">— none —</option>
                {REFERRAL_TARGETS.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <label className="fld">
              <span>Follow-up date</span>
              <input
                type="date"
                value={form.followUpDate}
                onChange={(e) => set({ followUpDate: e.target.value })}
              />
            </label>
          </div>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="modal-foot">
            <Btn type="button" onClick={onClose}>
              Cancel
            </Btn>
            <Btn tone="primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Raise intervention'}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  );
}

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
