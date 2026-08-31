/**
 * Academic-support compute layer — for a university sports programme.
 *
 * Modelled directly on the UCT RFC (Ikey Tigers) Academic Mentorship Tracker and
 * Academic Assistance SOP: a Player Database, a Live Academic Tracker with a RAG
 * risk rule, bi-weekly check-ins, and an intervention log. The risk formula below
 * reproduces the tracker's exactly, so the platform's numbers reconcile with the
 * spreadsheet the sport office already trusts.
 *
 * Pure and DOM-free — mirrored server-side in packages/api/src/catalogue.ts for
 * the vocab, and unit-tested against the tracker's own worked criteria.
 */

/* ─────────────────────────── University vocabularies ────────────────────── */

/** Squad groupings, from the tracker's Lists sheet. */
export const SQUADS = ['1st Team', 'U20s', 'Both', 'General'];

/** UCT faculties (the six the tracker offers). */
export const FACULTIES = [
  'Commerce',
  'Engineering & the Built Environment',
  'Health Sciences',
  'Humanities',
  'Law',
  'Science',
];

/**
 * Degree programmes, grouped by faculty (the tracker lists them flat; grouping
 * lets the form narrow the degree once a faculty is chosen). UCT-specific.
 */
export const DEGREES_BY_FACULTY = {
  Commerce: [
    'BCom Accounting',
    'BCom Financial Accounting',
    'BCom Economics',
    'BCom Information Systems',
    'BCom Finance',
    'BCom Management Studies',
    'BCom Actuarial Science',
    'BBusSci',
    'PGDip Management (Accounting)',
    'PGDip Management (Marketing)',
    'PGDip Management (Entrepreneurship)',
    'PGDip Management (Sport Management)',
  ],
  'Engineering & the Built Environment': [
    'BSc Engineering Civil',
    'BSc Engineering Electrical',
    'BSc Engineering Mechanical',
    'BSc Engineering Chemical',
    'BSc Engineering Mechatronics',
    'BSc Construction Studies',
    'BSc Property Studies',
    'BSc Quantity Surveying',
  ],
  'Health Sciences': [
    'MBChB',
    'BSc Physiotherapy',
    'BSc Occupational Therapy',
    'BSc Audiology',
    'BSc Speech-Language Pathology',
  ],
  Humanities: [
    'BA',
    'BSocSci',
    'BMusic',
    'Diploma in Music Performance',
    'Bachelor of Social Work',
  ],
  Law: ['LLB'],
  Science: [
    'BSc Biological Sciences',
    'BSc Computer Science',
    'BSc Mathematics',
    'BSc Physics',
    'BSc Environmental Sciences',
    'BSc Geology',
    'BSc Applied Statistics',
  ],
};

/** Every degree, flat — for validation and the "all" picker. */
export const ALL_DEGREES = Object.values(DEGREES_BY_FACULTY).flat();

export const YEARS_OF_STUDY = ['1st Year', '2nd Year', '3rd Year', '4th Year', 'Postgraduate'];

/**
 * The SOP's manual risk categorisation (distinct from the computed RAG status):
 * the GM/Head of Performance flag who is academically vulnerable up front, which
 * decides who is folded into active mentorship vs periodic monitoring.
 */
export const RISK_CATEGORIES = [
  { key: 'high', label: 'High risk', tone: 'red' },
  { key: 'medium', label: 'Medium risk', tone: 'amber' },
  { key: 'low', label: 'Low risk', tone: 'green' },
];

/* ─────────────────────── Varsity Cup eligibility (SOP) ───────────────────── */

/**
 * Varsity Cup eligibility: a student-athlete must carry at least 60 academic
 * credits (roughly four 18-credit courses). Below that they can't play, whatever
 * the rugby merits — so it's surfaced everywhere the roster is.
 */
export const VARSITY_CUP_MIN_CREDITS = 60;

export function isVarsityCupEligible(athlete) {
  return (athlete?.creditsRegistered ?? 0) >= VARSITY_CUP_MIN_CREDITS;
}

/* ─────────────────────────── The RAG risk model ─────────────────────────── */

export const RISK_META = {
  green: { label: 'Green', tone: 'green', order: 0 },
  amber: { label: 'Amber', tone: 'amber', order: 1 },
  red: { label: 'Red', tone: 'red', order: 2 },
  critical: { label: 'Critical', tone: 'red', order: 3 },
  unassessed: { label: 'Not assessed', tone: 'muted', order: -1 },
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The four academic metrics that drive risk are all present. */
export function isAssessed(a) {
  return (
    !!a &&
    (a.facultyWarning === 'Yes' || a.facultyWarning === 'No') &&
    num(a.lectureAttendance) != null &&
    num(a.tutorialAttendance) != null &&
    num(a.assignmentCompletion) != null &&
    num(a.semesterAverage) != null
  );
}

/**
 * RAG risk status — reproduces the tracker's Live-Academic-Tracker formula
 * verbatim (see the Dashboard's own criteria notes):
 *
 *   CRITICAL  faculty warning AND lecture<70 AND tutorial<70 AND assign<80 AND avg<50
 *   RED       faculty warning OR  lecture<70 OR  tutorial<70 OR  assign<80 OR  avg<50
 *   GREEN     no warning AND lecture≥85 AND tutorial≥85 AND assign≥85 AND avg≥60
 *   AMBER     everything else (no warning, avg≥55, some metric below the Green bar)
 *
 * Returns 'unassessed' when the metrics haven't been captured yet — unlike the
 * spreadsheet, which reads a blank row as all-zeros and paints it RED.
 */
export function academicRisk(a) {
  // Prefer the development-plan-derived standing — objective (ratings + real
  // marks) and frictionless. Falls back to a manual snapshot only if no plan.
  const s = a?.standing?.risk;
  if (s && s !== 'unassessed') return s;
  if (!isAssessed(a)) return 'unassessed';
  const warn = a.facultyWarning === 'Yes';
  const lec = a.lectureAttendance;
  const tut = a.tutorialAttendance;
  const asg = a.assignmentCompletion;
  const avg = a.semesterAverage;

  if (warn && lec < 70 && tut < 70 && asg < 80 && avg < 50) return 'critical';
  if (warn || lec < 70 || tut < 70 || asg < 80 || avg < 50) return 'red';
  if (!warn && lec >= 85 && tut >= 85 && asg >= 85 && avg >= 60) return 'green';
  return 'amber';
}

/** Red or Critical — the SOP's "immediate attention" set. */
export const needsImmediateAttention = (a) => {
  const r = academicRisk(a);
  return r === 'red' || r === 'critical';
};

/**
 * Player Risk Score, 0–100 — the tracker's weighted composite:
 *   semester avg 40% · mean attendance 25% · assignments 20% · a fixed 15% base.
 *
 * The 15% term is a flat constant in the source spreadsheet (100 × 0.15); it is
 * reproduced here so the score matches theirs exactly. It reads as an engagement
 * baseline — a candidate to make check-in-driven in a later pass.
 */
export function academicRiskScore(a) {
  if (!isAssessed(a)) return null;
  const lec = a.lectureAttendance;
  const tut = a.tutorialAttendance;
  const asg = a.assignmentCompletion;
  const avg = a.semesterAverage;
  return Math.round(avg * 0.4 + ((lec + tut) / 2) * 0.25 + asg * 0.2 + 100 * 0.15);
}

/* ─────────────────────── Bi-weekly check-in schema ──────────────────────── */

/**
 * The 18-field bi-weekly check-in from the tracker. Date/Player/Mentor/Risk/
 * Follow-up are captured as their own fields; these are the 13 review questions.
 * `concernIf` marks the answer that flags a problem — 'no' for most, but 'yes'
 * for overdue submissions and needing support — so a check-in can score itself.
 */
export const CHECKIN_QUESTIONS = [
  { key: 'fullyRegistered', label: 'Fully registered?', concernIf: 'no' },
  { key: 'correctCourses', label: 'Correct courses registered?', concernIf: 'no' },
  { key: 'tutorialsRegistered', label: 'Tutorials registered?', concernIf: 'no' },
  { key: 'noTutorialClashes', label: 'No tutorial clashes?', concernIf: 'no' },
  { key: 'lectureAttendanceOk', label: 'Lecture attendance satisfactory?', concernIf: 'no' },
  { key: 'tutorialAttendanceOk', label: 'Tutorial attendance satisfactory?', concernIf: 'no' },
  { key: 'knowsAssignmentDeadlines', label: 'Knows assignment deadlines?', concernIf: 'no' },
  { key: 'knowsTestDates', label: 'Knows test dates?', concernIf: 'no' },
  { key: 'overdueSubmissions', label: 'Any overdue submissions?', concernIf: 'yes' },
  { key: 'knowsExamTimetable', label: 'Knows exam timetable?', concernIf: 'no' },
  { key: 'examPrepPlan', label: 'Exam preparation plan?', concernIf: 'no' },
  { key: 'copingAcademically', label: 'Coping academically?', concernIf: 'no' },
  { key: 'supportRequired', label: 'Support required?', concernIf: 'yes' },
];

/**
 * How many check-in answers landed in the concerning direction. The stored
 * answers are "Yes"/"No" while `concernIf` is lower-case, so compare case-folded
 * — otherwise every flag reads as clear.
 */
export function checkInFlags(answers) {
  return CHECKIN_QUESTIONS.filter(
    (q) => String(answers?.[q.key] ?? '').toLowerCase() === q.concernIf,
  ).length;
}

export const INTERVENTION_STATUSES = [
  { key: 'open', label: 'Open', tone: 'red' },
  { key: 'in_progress', label: 'In progress', tone: 'amber' },
  { key: 'resolved', label: 'Resolved', tone: 'green' },
];

/**
 * University support structures the SOP refers students to — the intervention
 * form's "referred to" picker.
 */
export const REFERRAL_TARGETS = [
  'Faculty advisor',
  'Student Wellness Service',
  'Academic Development Programme',
  'Counselling',
  'Residence support',
  'Financial aid',
  'External tutor',
];

/* ───────────────────────────── Aggregations ─────────────────────────────── */

/** RAG counts across the squad, plus the immediate-attention total. */
export function riskSummary(athletes) {
  const counts = { green: 0, amber: 0, red: 0, critical: 0, unassessed: 0 };
  for (const a of athletes ?? []) counts[academicRisk(a)]++;
  return {
    ...counts,
    total: (athletes ?? []).length,
    immediate: counts.red + counts.critical,
    eligible: (athletes ?? []).filter(isVarsityCupEligible).length,
  };
}

/** At-risk (red + critical) players per faculty, worst first — the SOP question. */
export function facultyRiskAnalysis(athletes) {
  const byFaculty = {};
  for (const a of athletes ?? []) {
    const f = a.faculty || 'Unassigned';
    byFaculty[f] ??= { faculty: f, total: 0, atRisk: 0 };
    byFaculty[f].total++;
    if (needsImmediateAttention(a)) byFaculty[f].atRisk++;
  }
  return Object.values(byFaculty).sort((x, y) => y.atRisk - x.atRisk || y.total - x.total);
}

/**
 * Outstanding follow-ups per mentor — from open interventions (joined to the
 * athlete's mentor) plus check-ins flagged as needing follow-up. Answers the
 * SOP's "which mentor has outstanding follow-ups?".
 */
export function mentorFollowUps(athletes, interventions, checkIns) {
  const mentorOf = new Map((athletes ?? []).map((a) => [a.studentNumber, a.mentor]));
  const tally = {};
  const bump = (mentor, kind) => {
    const m = mentor || 'Unassigned';
    tally[m] ??= { mentor: m, interventions: 0, checkIns: 0 };
    tally[m][kind]++;
  };
  for (const iv of interventions ?? []) {
    if (iv.status !== 'resolved') bump(mentorOf.get(iv.studentNumber), 'interventions');
  }
  for (const c of checkIns ?? []) {
    if (c.followUpRequired === 'Yes') bump(c.mentor, 'checkIns');
  }
  return Object.values(tally)
    .map((t) => ({ ...t, total: t.interventions + t.checkIns }))
    .filter((t) => t.total > 0)
    .sort((x, y) => y.total - x.total);
}

/** Distinct mentors currently assigned — for the mentor picker. */
export function mentorList(athletes) {
  return [...new Set((athletes ?? []).map((a) => a.mentor).filter(Boolean))].sort();
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Academic Development Plan (ADP)
 *
 * A richer, PDP-style development conversation that replaces the flat 13-question
 * check-in. It is anchored to the student's MODULES: a quick screener triages
 * every registered module (some are easy and screen clear), and only the flagged
 * ones are taken through the deep sections. Every rated line carries two views —
 * the student's own (self) and the mentor's — so the gap is the talking point,
 * exactly as the employee PDP scorecard does.
 *
 * Four development areas plus an intervention plan:
 *   1. Academic content understanding   (per flagged module)
 *   2. Assessments                       (per flagged module)
 *   3. Work-life balance                 (whole student)
 *   4. Careers                           (whole student)
 *   5. Intervention plan                 (LMS-style action set)
 * ═══════════════════════════════════════════════════════════════════════════ */

/** A full ADP check-in is stamped with this kind; legacy check-ins have none. */
export const ADP_KIND = 'adp';

/* ───────────────────────────── The 1–5 rating scale ─────────────────────── */

/**
 * A five-point development scale, RAG-aligned so a plan reconciles with the
 * tracker's Green/Amber/Red language. 1–2 read Red, 3 Amber, 4–5 Green.
 */
export const ADP_SCALE = [
  { value: 1, tag: 'Critical', tone: 'red', hint: 'Serious concern — failing or not coping here.' },
  { value: 2, tag: 'At risk', tone: 'red', hint: 'Below par — likely to slip without support.' },
  { value: 3, tag: 'Fair', tone: 'amber', hint: 'Coping, but not comfortable — room to grow.' },
  { value: 4, tag: 'Good', tone: 'green', hint: 'Solid — on track and steady.' },
  { value: 5, tag: 'Strong', tone: 'green', hint: 'Excelling — a genuine strength.' },
];

export const ADP_SCALE_MAX = 5;

export function adpBand(v) {
  const n = Math.max(1, Math.min(ADP_SCALE_MAX, Math.round(v || 0)));
  return ADP_SCALE[n - 1];
}

/* ───────────────────────────── Module screener ──────────────────────────── */

/**
 * The quick per-module triage. Kept deliberately short — four signals — because
 * its whole job is to let easy modules screen clear so the mentor's time goes to
 * the ones that need it. `concern` marks the options that raise a flag.
 */
export const SCREENER_QUESTIONS = [
  {
    key: 'attending',
    label: 'Attending lectures & tutorials?',
    options: ['Yes', 'Patchy', 'No'],
    concern: { Patchy: 'watch', No: 'at_risk' },
  },
  {
    key: 'understanding',
    label: 'Following the material?',
    options: ['Comfortably', 'Getting by', 'Struggling'],
    concern: { 'Getting by': 'watch', Struggling: 'at_risk' },
  },
  {
    key: 'assessments',
    label: 'Assessments on track?',
    options: ['On track', 'Slightly behind', 'Behind'],
    concern: { 'Slightly behind': 'watch', Behind: 'at_risk' },
  },
  {
    key: 'difficulty',
    label: 'How hard is this module for them?',
    options: ['Easy', 'Manageable', 'Hard'],
    concern: { Hard: 'watch' },
  },
];

export const MODULE_STATUS_META = {
  on_track: { key: 'on_track', label: 'On track', tone: 'green', order: 0, flagged: false },
  watch: { key: 'watch', label: 'Watch', tone: 'amber', order: 1, flagged: true },
  at_risk: { key: 'at_risk', label: 'At risk', tone: 'red', order: 2, flagged: true },
};

/**
 * Roll a module's screener answers up to a status. Any 'at_risk' signal wins;
 * otherwise any 'watch' signal makes it a watch; a clean sweep is on track. A
 * module with no answers yet is treated as on track (nothing to flag).
 */
export function moduleScreenStatus(screener) {
  let worst = 'on_track';
  for (const q of SCREENER_QUESTIONS) {
    const level = q.concern[screener?.[q.key]];
    if (level === 'at_risk') return 'at_risk';
    if (level === 'watch') worst = 'watch';
  }
  return worst;
}

/** True when a module's status pulls it into the deep sections. */
export function isModuleFlagged(mod) {
  return MODULE_STATUS_META[mod?.status ?? moduleScreenStatus(mod?.screener)]?.flagged ?? false;
}

/** The modules a plan should take through content + assessments, worst first. */
export function flaggedModules(modules) {
  return (modules ?? [])
    .filter(isModuleFlagged)
    .sort(
      (a, b) =>
        (MODULE_STATUS_META[b.status]?.order ?? 0) - (MODULE_STATUS_META[a.status]?.order ?? 0),
    );
}

/** Screener roll-up for a whole plan — counts per status. */
export function screenerSummary(modules) {
  const counts = { on_track: 0, watch: 0, at_risk: 0 };
  for (const m of modules ?? []) counts[m.status ?? moduleScreenStatus(m.screener)]++;
  return { ...counts, total: (modules ?? []).length, flagged: counts.watch + counts.at_risk };
}

/* ─────────────────────────── The four dev sections ──────────────────────── */

/**
 * The development areas, each with a handful of attributes rated student-vs-
 * mentor. `scope: 'module'` sections are rated once per flagged module; `scope:
 * 'student'` sections are rated once for the whole person.
 */
/**
 * Each attribute carries a `levels` array — a tailored one-line descriptor for
 * each point on the 1–5 scale, in this category's own words — plus an `improve`
 * tip the mentor can act on. This is what makes a "3" on "Grasp of core concepts"
 * mean something concrete rather than a bare number. `attrScale()` merges these
 * with the generic tag/tone from ADP_SCALE for the rating pop-up.
 */
export const ADP_SECTIONS = [
  {
    key: 'content',
    title: 'Academic content understanding',
    what: 'Do they actually understand the material in this module?',
    scope: 'module',
    attrs: [
      {
        key: 'concepts',
        label: 'Grasp of core concepts',
        desc: 'Understands the key ideas, not just memorising them.',
        levels: [
          'Lost on the foundational theory.',
          'Shaky on the basics; clear gaps.',
          'Gets the basics, not the harder ideas.',
          'Solid grasp of the core ideas.',
          'Masters and connects concepts confidently.',
        ],
        improve:
          'Rebuild the fundamentals — SI sessions, the textbook basics, a tutor for first principles.',
      },
      {
        key: 'pace',
        label: 'Keeping pace with the syllabus',
        desc: 'Staying with the week-to-week workload.',
        levels: [
          'Weeks behind and falling further.',
          'Behind and struggling to catch up.',
          'Keeping up, but with no buffer.',
          'On pace with the weekly load.',
          'Working ahead of the syllabus.',
        ],
        improve: 'Map the term’s topics to a weekly catch-up plan; protect fixed study blocks.',
      },
      {
        key: 'engagement',
        label: 'Lecture & tutorial engagement',
        desc: 'Attends, participates, asks questions.',
        levels: [
          'Rarely attends or engages.',
          'Attends but passive and disengaged.',
          'Attends; participates occasionally.',
          'Engaged; asks and answers questions.',
          'Actively drives tutorials and discussion.',
        ],
        improve: 'Set an attendance routine; prep one question to ask per lecture.',
      },
      {
        key: 'resources',
        label: 'Using course resources',
        desc: 'Textbooks, past papers, online material, SI sessions.',
        levels: [
          'Using no course resources.',
          'Aware of resources but rarely uses them.',
          'Uses the basics (slides, textbook).',
          'Uses past papers, SI and support well.',
          'Resourceful — seeks out extra material.',
        ],
        improve: 'Book SI / hot-seat sessions and work through past papers each week.',
      },
    ],
  },
  {
    key: 'assessments',
    title: 'Assessments',
    what: 'Are they on top of the tests, assignments and exams in this module?',
    scope: 'module',
    attrs: [
      {
        key: 'planning',
        label: 'On top of dates & deadlines',
        desc: 'Knows when tests, assignments and exams fall.',
        levels: [
          'Unaware of test and assignment dates.',
          'Vague on deadlines; often caught out.',
          'Knows most dates, not all.',
          'Tracks every date with time to spare.',
          'Plans backwards from every deadline.',
        ],
        improve: 'Put every due date in one calendar with a reminder a week ahead.',
      },
      {
        key: 'submissions',
        label: 'Assignment & submission quality',
        desc: 'Work handed in on time and to standard.',
        levels: [
          'Missing or failing submissions.',
          'Late or below standard.',
          'On time, but average quality.',
          'On time and to a good standard.',
          'Polished, submitted early.',
        ],
        improve: 'Start assignments early; work to the rubric and add a proofread pass.',
      },
      {
        key: 'marks',
        label: 'Test & assignment marks',
        desc: 'Current results in this module.',
        levels: [
          'Failing — below 50%.',
          'Borderline — 50–54%.',
          'Passing but modest — 55–59%.',
          'Solid marks — 60–69%.',
          'Strong marks — 70%+.',
        ],
        improve: 'Review every returned test; drill the recurring mistakes.',
      },
      {
        key: 'examReady',
        label: 'Exam preparation & readiness',
        desc: 'A realistic, started plan for the exam.',
        levels: [
          'No plan, and not coping.',
          'A vague plan, not started.',
          'Has a plan but is behind on it.',
          'On track with a realistic plan.',
          'Well prepared and rehearsed.',
        ],
        improve: 'Build a topic-by-topic revision timetable; do timed past papers.',
      },
    ],
  },
  {
    key: 'worklife',
    title: 'Work-life balance',
    what: 'Can they sustain sport and study without one breaking the other?',
    scope: 'student',
    attrs: [
      {
        key: 'load',
        label: 'Training + academic load',
        desc: 'Balancing rugby commitments with study.',
        levels: [
          'One is breaking the other.',
          'Struggling to carry both.',
          'Managing, but stretched thin.',
          'Balancing sport and study well.',
          'Thriving in both.',
        ],
        improve: 'Map training and study into one weekly plan; flag clashes early.',
      },
      {
        key: 'time',
        label: 'Time management & routine',
        desc: 'A workable weekly structure.',
        levels: [
          'No routine; reactive and chaotic.',
          'Inconsistent, easily derailed.',
          'Some structure, but fragile.',
          'A workable weekly routine.',
          'Disciplined and reliable.',
        ],
        improve: 'Set fixed daily study blocks around training and protect them.',
      },
      {
        key: 'wellbeing',
        label: 'Rest, sleep & wellbeing',
        desc: 'Recovery, sleep and mental health.',
        levels: [
          'Burning out; not coping.',
          'Run down, sleeping poorly.',
          'Coping, but often tired.',
          'Rested and well.',
          'Recovering well, in good shape.',
        ],
        improve: 'Prioritise 7–8h sleep; refer to Student Wellness if the strain persists.',
      },
      {
        key: 'finance',
        label: 'Financial & living stability',
        desc: 'Fees, accommodation, day-to-day means.',
        levels: [
          'In crisis — fees or living at risk.',
          'Financially strained.',
          'Getting by, but tight.',
          'Financially stable.',
          'Secure.',
        ],
        improve: 'Refer to financial aid early; check bursary and hardship options.',
      },
      {
        key: 'support',
        label: 'Support network',
        desc: 'Family, teammates and mentors to lean on.',
        levels: [
          'Isolated; no one to lean on.',
          'Thin support around them.',
          'Some support, not really used.',
          'Good support around them.',
          'A strong, active support network.',
        ],
        improve: 'Connect them to teammates, a mentor and regular family check-ins.',
      },
    ],
  },
  {
    key: 'careers',
    title: 'Careers',
    what: 'Is the degree taking them somewhere they want to go?',
    scope: 'student',
    attrs: [
      {
        key: 'direction',
        label: 'Career direction & clarity',
        desc: 'A sense of where the degree leads.',
        levels: [
          'No sense of direction.',
          'Unsure and drifting.',
          'A rough idea, nothing concrete.',
          'A clear direction.',
          'A clear plan they own.',
        ],
        improve: 'Book a careers-service session; explore two concrete paths.',
      },
      {
        key: 'alignment',
        label: 'Degree ↔ goal alignment',
        desc: 'Studying toward the intended path.',
        levels: [
          'The degree doesn’t fit their goal.',
          'Real doubts about the fit.',
          'Mostly aligned, some doubt.',
          'The degree fits the goal.',
          'Degree and goal tightly aligned.',
        ],
        improve: 'Sanity-check the curriculum against the target career; adjust electives.',
      },
      {
        key: 'experience',
        label: 'Work experience / internships',
        desc: 'Vac work, internships, practical exposure.',
        levels: [
          'None, and none planned.',
          'Aware of it, nothing lined up.',
          'A little exposure.',
          'Relevant vac or internship experience.',
          'Strong, repeated experience.',
        ],
        improve: 'Target one vac-work or internship application this term.',
      },
      {
        key: 'network',
        label: 'Networking & alumni links',
        desc: 'Building professional and alumni connections.',
        levels: [
          'No professional network.',
          'Very few connections.',
          'A handful of contacts.',
          'Building useful connections.',
          'An active, growing network.',
        ],
        improve: 'Introduce them to an Ikey alum working in their field.',
      },
    ],
  },
];

export const ADP_SECTION_META = Object.fromEntries(ADP_SECTIONS.map((s) => [s.key, s]));
export const MODULE_SECTIONS = ADP_SECTIONS.filter((s) => s.scope === 'module');
export const STUDENT_SECTIONS = ADP_SECTIONS.filter((s) => s.scope === 'student');

const ATTR_INDEX = Object.fromEntries(ADP_SECTIONS.flatMap((s) => s.attrs.map((a) => [a.key, a])));

/** Look an attribute up by key (across all sections). */
export function findAttr(key) {
  return ATTR_INDEX[key] ?? null;
}

/**
 * The rating scale for a specific attribute: the generic 1–5 tag/tone merged with
 * this category's tailored one-line descriptor. Feeds the rating pop-up so a "3"
 * on "Grasp of core concepts" reads "Gets the basics, not the harder ideas."
 */
export function attrScale(attr) {
  return ADP_SCALE.map((s, i) => ({
    ...s,
    desc: attr?.levels?.[i] ?? s.hint,
  }));
}

/* ────────────────────────── Semester from the date ──────────────────────── */

/**
 * Which UCT semester a date falls in — so the mentor never types a term by hand.
 * January–June is the first semester; July–December is the second.
 */
export function semesterOf(dateISO) {
  const d = dateISO ? new Date(`${dateISO}T00:00:00Z`) : new Date();
  const month = d.getUTCMonth(); // 0 = Jan
  const year = d.getUTCFullYear();
  const half = month <= 5 ? 'First' : 'Second';
  return { key: month <= 5 ? 's1' : 's2', label: `${half} semester ${year}`, year };
}

/* ─────────────────────────── Mentor guidance (FAQ) ──────────────────────── */

/**
 * A question bank the mentor works from during the conversation — not an FAQ for
 * the mentor, but prompts to draw the student out, grouped by area. Young mentors
 * can lean on these to get past "yes, fine" answers into something real.
 */
export const QUESTION_BANK = [
  {
    area: 'Opening up',
    questions: [
      'How’s the term going, honestly — out of 10?',
      'What’s the one thing stressing you most right now?',
      'If we fixed just one thing today, what should it be?',
    ],
  },
  {
    area: 'Academic content understanding',
    questions: [
      'Which topics are clicking, and which feel like a fog?',
      'When you get stuck, what do you actually do next?',
      'Are the lectures and tuts helping, or are you learning it some other way?',
      'If you had to teach me last week’s topic, how would that go?',
    ],
  },
  {
    area: 'Assessments',
    questions: [
      'Walk me through your next three deadlines — what’s coming up?',
      'How did the last test go, and what happened in the run-up to it?',
      'What’s your plan for the exam, and have you started it?',
      'Is anything overdue or hanging over you right now?',
    ],
  },
  {
    area: 'Work-life balance',
    questions: [
      'How are you fitting study around training and matches?',
      'What does a normal week look like — when do you actually study?',
      'How’s the sleep and the general tank — full, or running empty?',
      'Is money or accommodation adding any stress right now?',
      'Who do you lean on when it gets heavy?',
    ],
  },
  {
    area: 'Careers',
    questions: [
      'Where do you picture this degree taking you?',
      'Does what you’re studying still feel like the right path?',
      'Have you done any work experience, or thought about it?',
      'Would it help to meet an Ikey alum doing what you’re aiming for?',
    ],
  },
];

/**
 * The numeric value of a rating. Ratings are stored as a plain 1–5 number; older
 * plans stored a {self, mentor} pair, so coerce those to the mentor's (then the
 * student's) value for display.
 */
export function ratingValue(r) {
  if (typeof r === 'number') return r;
  if (r && typeof r === 'object') {
    if (typeof r.mentor === 'number') return r.mentor;
    if (typeof r.self === 'number') return r.self;
  }
  return null;
}

/** Mean of a rating map (attrKey → 1–5), ignoring un-rated attributes. */
export function ratingsAverage(ratings) {
  const vals = Object.values(ratings ?? {})
    .map(ratingValue)
    .filter((v) => v != null);
  if (!vals.length) return null;
  return vals.reduce((t, v) => t + v, 0) / vals.length;
}

/**
 * A mean rating per development area — the radar's spokes. Module sections average
 * across every flagged module's ratings; student sections average their own. An
 * area with nothing rated comes back null.
 */
export function sectionAverages(checkIn) {
  const sections = checkIn?.sections ?? {};
  return ADP_SECTIONS.map((sec) => {
    const block = sections[sec.key];
    const vals = [];
    if (block) {
      if (sec.scope === 'module') {
        for (const perMod of Object.values(block.modules ?? {})) {
          for (const r of Object.values(perMod ?? {})) {
            const v = ratingValue(r);
            if (v != null) vals.push(v);
          }
        }
      } else {
        for (const r of Object.values(block.ratings ?? {})) {
          const v = ratingValue(r);
          if (v != null) vals.push(v);
        }
      }
    }
    const value = vals.length ? vals.reduce((t, v) => t + v, 0) / vals.length : null;
    return { key: sec.key, title: sec.title, value };
  });
}

/**
 * The squad-wide radar spokes: pool every rating from every development plan and
 * average per area, so the dashboard shows how the whole squad sits across the
 * four areas. Returns per-area {value, n}, value null where nothing is rated.
 */
export function squadSectionAverages(checkIns) {
  const adp = (checkIns ?? []).filter((c) => c.kind === ADP_KIND);
  return ADP_SECTIONS.map((sec) => {
    const vals = [];
    for (const c of adp) {
      const block = c.sections?.[sec.key];
      if (!block) continue;
      if (sec.scope === 'module') {
        for (const perMod of Object.values(block.modules ?? {})) {
          for (const r of Object.values(perMod ?? {})) {
            const v = ratingValue(r);
            if (v != null) vals.push(v);
          }
        }
      } else {
        for (const r of Object.values(block.ratings ?? {})) {
          const v = ratingValue(r);
          if (v != null) vals.push(v);
        }
      }
    }
    const value = vals.length ? vals.reduce((t, v) => t + v, 0) / vals.length : null;
    return { key: sec.key, title: sec.title, value, n: vals.length };
  });
}

/**
 * A dashboard roll-up of every development plan: how many were run, how many
 * athletes they cover, flagged modules and planned interventions across them all,
 * the squad's overall mean rating, and its weakest and strongest areas.
 */
export function developmentPlanSummary(checkIns) {
  const adp = (checkIns ?? []).filter((c) => c.kind === ADP_KIND);
  let flaggedModules = 0;
  let interventions = 0;
  let followUps = 0;
  for (const c of adp) {
    const s = adpSummary(c);
    flaggedModules += s.flaggedModules;
    interventions += s.interventions;
    if (c.followUpRequired === 'Yes') followUps++;
  }
  const axes = squadSectionAverages(checkIns);
  const rated = axes.filter((a) => a.value != null);
  const totalN = rated.reduce((t, a) => t + a.n, 0);
  const mean = totalN ? rated.reduce((t, a) => t + a.value * a.n, 0) / totalN : null;
  const sorted = [...rated].sort((a, b) => a.value - b.value);
  return {
    plans: adp.length,
    athletes: new Set(adp.map((c) => c.studentNumber)).size,
    flaggedModules,
    interventions,
    followUps,
    axes,
    mean,
    meanBand: mean == null ? null : adpBand(Math.round(mean)),
    weakest: sorted[0] ?? null,
    strongest: sorted[sorted.length - 1] ?? null,
  };
}

/* ───────────────────────────── Intervention plan ────────────────────────── */

/**
 * The LMS-style intervention catalogue. The five the sport office asked for,
 * plus the academic-support standards a university plan reaches for. `module`
 * interventions attach to a specific flagged module; `referral` opens the
 * existing REFERRAL_TARGETS picker.
 */
export const INTERVENTION_TYPES = [
  {
    key: 'one_on_ones',
    label: 'Frequent one-on-ones',
    desc: 'Schedule regular mentor check-ins — weekly or fortnightly.',
    module: false,
  },
  {
    key: 'course_tutor',
    label: 'Course-specific tutor',
    desc: 'Assign a paid tutor for a module they are behind in.',
    module: true,
  },
  {
    key: 'supplemental_instruction',
    label: 'Supplemental instruction (SI)',
    desc: 'Enrol in the faculty SI / hot-seat sessions for the module.',
    module: true,
  },
  {
    key: 'study_group',
    label: 'Study group',
    desc: 'Pair with teammates or classmates taking the same module.',
    module: true,
  },
  {
    key: 'alumni_mentor',
    label: 'Alumni mentor',
    desc: 'Pair with an Ikey alum working in their field of study.',
    module: false,
  },
  {
    key: 'referral',
    label: 'Referral to a support service',
    desc: 'Refer to a university support structure.',
    module: false,
    referral: true,
  },
  {
    key: 'concession',
    label: 'DP / deadline concession support',
    desc: 'Help with DP appeals, extensions or deferred tests.',
    module: true,
  },
  {
    key: 'financial_support',
    label: 'Financial aid support',
    desc: 'Route to financial aid, bursary or hardship funding.',
    module: false,
  },
  {
    key: 'reduced_load',
    label: 'Reduced course load',
    desc: 'Drop or defer a course to protect the rest of the year.',
    module: true,
  },
  {
    key: 'leave_of_absence',
    label: 'Leave of absence',
    desc: 'Formal leave of absence / deferral for the term or year.',
    module: false,
  },
];

export const INTERVENTION_TYPE_META = Object.fromEntries(INTERVENTION_TYPES.map((t) => [t.key, t]));

/** A short human label for a planned action (checklist text, or legacy type). */
export function interventionLabel(item) {
  if (item?.text) return item.text;
  const meta = INTERVENTION_TYPE_META[item?.type];
  if (!meta) return item?.type ?? 'Action';
  return item.module ? `${meta.label} · ${item.module}` : meta.label;
}

/* ─────────────────────── Student action checklists ──────────────────────── */

/**
 * Instead of dated interventions, the mentor builds the student a CHECKLIST of
 * concrete actions — grouped by development area — that the student then ticks
 * off. Each item is stored as { section, text, done }, so we can monitor what's
 * been done. These are suggestions the mentor selects from (they can add their
 * own too).
 */
export const ACTION_SECTIONS = [
  {
    key: 'content',
    title: 'Understanding the content',
    items: [
      'Attend every lecture and tutorial this week',
      'Book weekly sessions with a course tutor',
      'Go to the SI / hot-seat sessions each week',
      'Work through the textbook chapters I’m behind on',
      'Join or start a study group for this module',
      'See the lecturer in consultation once this week',
    ],
  },
  {
    key: 'assessments',
    title: 'Assessments & exams',
    items: [
      'Put every test, assignment and exam date in one calendar',
      'Start each assignment at least a week early',
      'Do a timed past paper before the next test',
      'Review the last returned test and fix the mistakes',
      'Build a topic-by-topic exam revision timetable',
      'Hand in the next assignment on time',
    ],
  },
  {
    key: 'worklife',
    title: 'Work-life balance',
    items: [
      'Map training and study into one weekly plan',
      'Protect two fixed study blocks a day',
      'Aim for 7–8 hours of sleep on weeknights',
      'Book a Student Wellness session',
      'Speak to financial aid about my options',
    ],
  },
  {
    key: 'careers',
    title: 'Careers',
    items: [
      'Book a session with the careers service',
      'Apply for one vac-work or internship this term',
      'Update my CV',
      'Meet an alumnus working in my target field',
      'Attend one networking or industry event',
    ],
  },
];

export const ACTION_SECTION_META = Object.fromEntries(ACTION_SECTIONS.map((s) => [s.key, s]));

/** The area a checklist item belongs to — new items carry `section`; migrate old ones. */
export function actionSection(item) {
  if (item?.section) return item.section;
  // Legacy intervention types → nearest development area.
  const map = {
    course_tutor: 'content',
    supplemental_instruction: 'content',
    study_group: 'content',
    concession: 'assessments',
    reduced_load: 'assessments',
    financial_support: 'worklife',
    leave_of_absence: 'worklife',
    one_on_ones: 'worklife',
    referral: 'worklife',
    alumni_mentor: 'careers',
  };
  return map[item?.type] ?? 'content';
}

/** Progress across a plan's checklist: how many actions are ticked done. */
export function planChecklistSummary(plan) {
  const items = (plan ?? []).filter((i) => i && (i.text || i.type));
  const done = items.filter((i) => i.done).length;
  return { total: items.length, done, pct: items.length ? Math.round((done / items.length) * 100) : 0 };
}

/* ───────────────── Marks + plan-derived academic standing ────────────────── */

/** The student's average recorded mark (from the gradebook), or null. */
export function markAverage(grades) {
  const vals = Object.values(grades ?? {})
    .map(Number)
    .filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return Math.round(vals.reduce((t, v) => t + v, 0) / vals.length);
}

const RISK_ORDER = { green: 0, amber: 1, red: 2, critical: 3 };
const worseRisk = (a, b) => (a == null ? b : b == null ? a : RISK_ORDER[b] > RISK_ORDER[a] ? b : a);

/**
 * A frictionless academic standing derived from the DEVELOPMENT PLAN (the mentor's
 * 1–5 ratings) and the student's REAL recorded marks — no subjective, manually
 * captured attendance percentages. Real marks can only pull the standing down (an
 * objective floor). Returns null risk when there's no plan to read.
 */
export function standingFromPlan(checkIn, avgMark) {
  const sum = adpSummary(checkIn);
  const mean = sum.mean;
  let risk = mean == null ? null : mean >= 4 ? 'green' : mean >= 3 ? 'amber' : mean >= 2 ? 'red' : 'critical';
  if (avgMark != null) {
    const markRisk = avgMark >= 60 ? 'green' : avgMark >= 50 ? 'amber' : avgMark >= 45 ? 'red' : 'critical';
    risk = worseRisk(risk, markRisk);
  }
  return {
    risk: risk ?? 'unassessed',
    mean,
    meanBand: mean == null ? null : adpBand(Math.round(mean)),
    avgMark: avgMark ?? null,
    flaggedModules: sum.flaggedModules,
    interventions: sum.interventions,
    period: checkIn?.period,
    updatedAt: checkIn?.completedAt ?? checkIn?.date,
  };
}

/* ──────────────────────────────── Plan roll-ups ─────────────────────────── */

/**
 * A whole-plan summary the check-in list and detail view read: the lowest rating
 * across everything scored (the plan's floor), the overall mean rating, and the
 * flagged-module and intervention counts. Pure — safe to call on a half-finished
 * plan, and tolerant of the older {self, mentor} rating shape.
 */
export function adpSummary(checkIn) {
  const modules = checkIn?.modules ?? [];
  const sections = checkIn?.sections ?? {};
  const plan = checkIn?.plan ?? [];

  const values = [];
  for (const sec of ADP_SECTIONS) {
    const block = sections[sec.key];
    if (!block) continue;
    if (sec.scope === 'module') {
      for (const perMod of Object.values(block.modules ?? {})) {
        for (const r of Object.values(perMod ?? {})) {
          const v = ratingValue(r);
          if (v != null) values.push(v);
        }
      }
    } else {
      for (const r of Object.values(block.ratings ?? {})) {
        const v = ratingValue(r);
        if (v != null) values.push(v);
      }
    }
  }
  const floor = values.length ? Math.min(...values) : null;
  const mean = values.length ? values.reduce((t, v) => t + v, 0) / values.length : null;

  const screen = screenerSummary(modules);
  return {
    modules: screen.total,
    flaggedModules: screen.flagged,
    rated: values.length,
    floor,
    floorBand: floor == null ? null : adpBand(floor),
    mean,
    meanBand: mean == null ? null : adpBand(Math.round(mean)),
    interventions: plan.length,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Student gradebook
 *
 * Assessment dates are captured at onboarding (or seeded from any teammate who
 * has taken the same module — the shared module profile). Three weeks after an
 * assessment's date, marks are usually out, so the student is prompted to record
 * theirs. The gradebook is the table where they add and update those marks.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Marks are usually released within three weeks — after that we prompt. */
export const MARK_READY_DAYS = 21;

export const GRADE_STATUS_META = {
  recorded: { key: 'recorded', label: 'Recorded', tone: 'green' },
  due: { key: 'due', label: 'Add your mark', tone: 'amber' },
  awaiting: { key: 'awaiting', label: 'Awaiting result', tone: 'muted' },
  upcoming: { key: 'upcoming', label: 'Upcoming', tone: 'muted' },
};

/** Stable identity for one assessment's mark: module + label + date. */
export function gradeKey(code, label, date) {
  return `${code ?? ''}|${label ?? ''}|${date ?? ''}`;
}

const hasMark = (mark) => mark != null && mark !== '' && !Number.isNaN(Number(mark));

/**
 * Where an assessment sits: already recorded, due for a mark (≥ 3 weeks past),
 * done-but-awaiting (past, not yet 3 weeks), or still upcoming.
 */
export function assessmentStatus(date, mark, today = new Date()) {
  if (hasMark(mark)) return GRADE_STATUS_META.recorded;
  if (!date) return GRADE_STATUS_META.due; // no date — safe to ask for it now
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return GRADE_STATUS_META.due;
  const ready = new Date(d.getTime() + MARK_READY_DAYS * 86400000);
  if (today < d) return GRADE_STATUS_META.upcoming;
  if (today < ready) return GRADE_STATUS_META.awaiting;
  return GRADE_STATUS_META.due;
}

/** Union a student's own assessments with the shared module-profile ones. */
export function mergeAssessments(own, profile) {
  const map = new Map();
  for (const a of [...(profile ?? []), ...(own ?? [])]) {
    if (!a || (!a.date && !a.label)) continue;
    const key = `${a.label ?? ''}|${a.date ?? ''}`;
    map.set(key, { label: a.label ?? '', date: a.date ?? '' });
  }
  return [...map.values()].sort((x, y) => String(x.date).localeCompare(String(y.date)));
}

/**
 * The student's gradebook: every module they take, its assessments (own +
 * shared), each with the mark they've recorded and a status. Counts drive the
 * "you have marks to add" prompt.
 */
export function buildGradebook(athlete, profiles = {}, today = new Date()) {
  const grades = athlete?.grades ?? {};
  const modules = (athlete?.modules ?? [])
    .map((m) => {
      const merged = mergeAssessments(m.assessments, profiles[m.code]?.assessments);
      const assessments = merged.map((a) => {
        const key = gradeKey(m.code, a.label, a.date);
        const mark = grades[key];
        return { ...a, key, mark: hasMark(mark) ? Number(mark) : '', status: assessmentStatus(a.date, mark, today) };
      });
      return { code: m.code, name: m.name, assessments };
    })
    .filter((m) => m.assessments.length);
  const all = modules.flatMap((m) => m.assessments);
  return {
    modules,
    total: all.length,
    recorded: all.filter((a) => a.status.key === 'recorded').length,
    due: all.filter((a) => a.status.key === 'due').length,
  };
}
