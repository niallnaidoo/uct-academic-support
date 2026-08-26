/**
 * Anonymised demo squad for the public GitHub Pages build.
 *
 * These are SYNTHETIC student-athletes — invented names and numbers, no real
 * person — so the hosted demo carries no personal data. The metrics are spread
 * to exercise the full RAG range (green / amber / red / critical / unassessed).
 * The real course catalogue (public UCT handbook data) is used unchanged.
 */
import { FACULTIES, DEGREES_BY_FACULTY, SQUADS, YEARS_OF_STUDY } from './academic-model.js';

const FIRST = [
  'Sipho', 'Thabo', 'Liam', 'Aiden', 'Kagiso', 'Ethan', 'Lwazi', 'Daniel', 'Sizwe', 'Ryan',
  'Tumelo', 'James', 'Bongani', 'Connor', 'Anele', 'Joshua', 'Katlego', 'Michael', 'Themba', 'Luke',
  'Musa', 'Nathan', 'Kabelo', 'Jordan', 'Siyabonga', 'Cameron', 'Lungelo', 'Matthew', 'Oscar', 'Neo',
  'Farai', 'Sean', 'Andile', 'Blake', 'Tshepo', 'Dylan', 'Mpho', 'Reece', 'Zola', 'Aidan',
];
const LAST = [
  'Nkosi', 'Botha', 'Dlamini', 'Smith', 'Mahlangu', 'Naidoo', 'Khumalo', 'Van Wyk', 'Mbeki', 'Adams',
  'Zulu', 'Fourie', 'Mokoena', 'Peters', 'Ngcobo', 'Jacobs', 'Sithole', 'Meyer', 'Radebe', 'Hendricks',
  'Molefe', 'Steyn', 'Maseko', 'Daniels', 'Ndlovu', 'Coetzee', 'Mthembu', 'Isaacs', 'Buthelezi', 'Pretorius',
  'Mahlaba', 'Roberts', 'Nxumalo', 'Willemse', 'Modise', 'Abrahams', 'Cele', 'Fortuin', 'Gumede', 'Olivier',
];
const MENTORS_HINT = ['', '', '', '', '', '']; // mentors are assigned via the plan flow

// Cycle metric profiles so the squad shows a realistic mix.
const PROFILES = [
  { lec: 92, tut: 90, asg: 90, avg: 68, warn: 'No' }, // green
  { lec: 88, tut: 86, asg: 88, avg: 62, warn: 'No' }, // green
  { lec: 80, tut: 78, asg: 82, avg: 57, warn: 'No' }, // amber
  { lec: 76, tut: 82, asg: 80, avg: 55, warn: 'No' }, // amber
  { lec: 68, tut: 72, asg: 84, avg: 58, warn: 'No' }, // red (attendance)
  { lec: 84, tut: 80, asg: 84, avg: 48, warn: 'No' }, // red (avg)
  { lec: 90, tut: 88, asg: 90, avg: 65, warn: 'Yes' }, // red (warning)
  { lec: 62, tut: 60, asg: 70, avg: 44, warn: 'Yes' }, // critical
  null, // unassessed
];

// A few real course codes + relative assessment dates so the gradebook demo has
// content on first load: some marks already due (past 3 weeks), some awaiting,
// some still upcoming. Dates are computed once, at seed time.
const dayOffset = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const DEMO_MODULE_CODES = ['ECO1010F', 'CSC1015F', 'MAM1000W', 'STA1000S', 'BUS1004F', 'PSY1004F'];
function demoModulesFor(i) {
  const c1 = DEMO_MODULE_CODES[i % DEMO_MODULE_CODES.length];
  const c2 = DEMO_MODULE_CODES[(i + 3) % DEMO_MODULE_CODES.length];
  return [
    {
      code: c1,
      assessments: [
        { label: 'Class Test 1', date: dayOffset(-32) }, // marks due
        { label: 'Assignment 1', date: dayOffset(-9) }, // awaiting result
        { label: 'Class Test 2', date: dayOffset(18) }, // upcoming
      ],
    },
    {
      code: c2,
      assessments: [
        { label: 'Tutorial Test', date: dayOffset(-40) }, // marks due
        { label: 'Project', date: dayOffset(25) }, // upcoming
      ],
    },
  ];
}

/* ── A fully-populated showcase profile: Sipho Nkosi (ath-demo-1) ──
 * Modules with recorded marks, an assigned mentor, two completed development
 * plans (so the history + radar have content), and a matching intervention log.
 * Everything is keyed off these dates so the gradebook marks line up. */
const SIPHO_ASSESS = {
  ECO1010F: [
    { label: 'Class Test 1', date: dayOffset(-34) },
    { label: 'Assignment 1', date: dayOffset(-12) },
    { label: 'Class Test 2', date: dayOffset(16) },
    { label: 'Final Exam', date: dayOffset(42) },
  ],
  STA1000S: [
    { label: 'Tutorial Test', date: dayOffset(-40) },
    { label: 'Class Test 1', date: dayOffset(-7) },
    { label: 'Project', date: dayOffset(24) },
  ],
};
const SIPHO_MODULES = [
  { code: 'ECO1010F', name: 'Microeconomics', convener: 'A/Prof R Chetty', credits: 18, difficulty: 3, assessments: SIPHO_ASSESS.ECO1010F },
  { code: 'STA1000S', name: 'Statistics for Business', convener: 'Dr N Naidoo', credits: 18, difficulty: 3, assessments: SIPHO_ASSESS.STA1000S },
];
const SIPHO_GRADES = {
  [`ECO1010F|Class Test 1|${SIPHO_ASSESS.ECO1010F[0].date}`]: 54,
  [`ECO1010F|Assignment 1|${SIPHO_ASSESS.ECO1010F[1].date}`]: 61,
  [`STA1000S|Tutorial Test|${SIPHO_ASSESS.STA1000S[0].date}`]: 58,
  [`STA1000S|Class Test 1|${SIPHO_ASSESS.STA1000S[1].date}`]: 66,
};

export function demoAthletes() {
  const out = [];
  for (let i = 0; i < 40; i++) {
    const faculty = FACULTIES[i % FACULTIES.length];
    const degrees = DEGREES_BY_FACULTY[faculty];
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    const p = PROFILES[i % PROFILES.length];
    const num = `${last.slice(0, 3).toUpperCase().replace(/[^A-Z]/g, 'X')}${first.slice(0, 3).toUpperCase()}${String((i % 40) + 1).padStart(3, '0')}`;
    const credits = i % 11 === 0 ? 48 : 60 + (i % 4) * 12;
    out.push({
      id: `ath-demo-${i + 1}`,
      firstName: first,
      lastName: last,
      studentNumber: num,
      squad: SQUADS[i % SQUADS.length],
      faculty,
      degree: degrees[i % degrees.length],
      yearOfStudy: YEARS_OF_STUDY[i % 4],
      creditsRegistered: credits,
      mentor: MENTORS_HINT[i % MENTORS_HINT.length] || undefined,
      // Sipho Nkosi (i=0) is the fully-populated showcase profile; the next
      // eleven get generic modules + a stable gradebook token so their demo
      // links work for any visitor; the rest register their own.
      ...(i === 0
        ? {
            modules: SIPHO_MODULES,
            grades: SIPHO_GRADES,
            gradebookToken: 'demo-1',
            mentor: 'Dr Naledi Khumalo',
            creditsRegistered: 72,
          }
        : i < 12
          ? { modules: demoModulesFor(i), gradebookToken: `demo-${i + 1}` }
          : {}),
      status: 'active',
      consentAt: i % 9 === 0 && i !== 0 ? undefined : '2026-02-01T08:00:00.000Z',
      ...(p
        ? {
            lectureAttendance: p.lec,
            tutorialAttendance: p.tut,
            assignmentCompletion: p.asg,
            semesterAverage: p.avg,
            facultyWarning: p.warn,
            assessedAt: '2026-07-20T08:00:00.000Z',
          }
        : { facultyWarning: 'No' }),
      version: 1,
    });
  }
  return out;
}

export function demoMentors() {
  return [
    { id: 'mtr-demo-1', name: 'Dr Naledi Khumalo', email: 'naledi.khumalo@example.com', organisation: 'UCT Alumni', version: 1 },
    { id: 'mtr-demo-2', name: 'Mr David Petersen', email: 'david.petersen@example.com', phone: '082 555 0142', organisation: 'Ikey Tigers', version: 1 },
  ];
}

/* Sipho Nkosi's development-plan history — an older first-semester plan and the
 * current, richer second-semester plan (both completed). */
export function demoCheckIns() {
  const SIPHO = { studentNumber: 'NKOSIP001', athleteName: 'Sipho Nkosi', mentor: 'Dr Naledi Khumalo', mentorEmail: 'naledi.khumalo@example.com' };
  return [
    {
      ...SIPHO,
      id: 'chk-demo-sipho-s1',
      token: 'demo-report-sipho-s1',
      date: '2026-05-06',
      completedAt: '2026-05-06T10:00:00.000Z',
      kind: 'adp',
      period: 'First semester 2026',
      planStatus: 'completed',
      scheduledNext: '2026-08-06',
      modules: [
        { code: 'ECO1010F', name: 'Microeconomics', status: 'watch', difficulty: 3, screener: { attending: 'Yes', understanding: 'Getting by', assessments: 'On track', difficulty: 'Manageable' } },
      ],
      sections: {
        content: { modules: { ECO1010F: { concepts: 3, pace: 3, engagement: 4, resources: 3 } }, note: 'Settling in well; keep an eye on Micro.' },
        worklife: { ratings: { load: 4, time: 3, wellbeing: 4, finance: 4, support: 4 }, note: '' },
      },
      plan: [{ type: 'one_on_ones', note: 'Fortnightly check-ins' }],
      note: 'Solid first-semester start. Watch Microeconomics into the mid-year.',
      followUpRequired: 'No',
      version: 1,
    },
    {
      ...SIPHO,
      id: 'chk-demo-sipho',
      token: 'demo-report-sipho',
      date: dayOffset(-14),
      completedAt: `${dayOffset(-14)}T10:00:00.000Z`,
      kind: 'adp',
      period: 'Second semester 2026',
      planStatus: 'completed',
      scheduledNext: dayOffset(21),
      modules: [
        { code: 'ECO1010F', name: 'Microeconomics', convener: 'A/Prof R Chetty', credits: 18, status: 'at_risk', difficulty: 3, screener: { attending: 'Yes', understanding: 'Struggling', assessments: 'Slightly behind', difficulty: 'Manageable' } },
        { code: 'STA1000S', name: 'Statistics for Business', convener: 'Dr N Naidoo', credits: 18, status: 'watch', difficulty: 3, screener: { attending: 'Yes', understanding: 'Getting by', assessments: 'On track', difficulty: 'Manageable' } },
      ],
      sections: {
        content: {
          modules: {
            ECO1010F: { concepts: 2, pace: 2, engagement: 4, resources: 3 },
            STA1000S: { concepts: 3, pace: 3, engagement: 4, resources: 4 },
          },
          note: 'Micro theory is the main gap — SI and a course tutor booked.',
        },
        assessments: {
          modules: {
            ECO1010F: { planning: 3, submissions: 3, marks: 2, examReady: 2 },
            STA1000S: { planning: 4, submissions: 4, marks: 3, examReady: 3 },
          },
          note: 'Prioritise the next Micro class test.',
        },
        worklife: { ratings: { load: 3, time: 3, wellbeing: 4, finance: 4, support: 5 }, note: 'Balancing rugby and study reasonably well; strong support network.' },
        careers: { ratings: { direction: 4, alignment: 4, experience: 2, network: 3 }, note: 'Keen on finance — line up vac work.' },
      },
      plan: [
        { type: 'course_tutor', module: 'ECO1010F', owner: 'Dr Naledi Khumalo', dueDate: dayOffset(7), note: 'Weekly Microeconomics tutor' },
        { type: 'supplemental_instruction', module: 'ECO1010F' },
        { type: 'one_on_ones', note: 'Fortnightly mentor check-ins' },
        { type: 'alumni_mentor', note: 'Introduce to an Ikey alum working in finance' },
      ],
      note: 'Strong, engaged student. Targeted support for Microeconomics; review after the next class test. Careers: arrange finance vac-work.',
      followUpRequired: 'Yes',
      version: 2,
    },
  ];
}

/** The interventions logged from Sipho's current plan. */
export function demoInterventions() {
  const base = { studentNumber: 'NKOSIP001', athleteName: 'Sipho Nkosi', date: dayOffset(-14), version: 1 };
  return [
    { ...base, id: 'int-demo-1', concern: 'Course-specific tutor · ECO1010F · Second semester 2026', actionTaken: 'Course-specific tutor', followUpDate: dayOffset(7), status: 'in_progress' },
    { ...base, id: 'int-demo-2', concern: 'Supplemental instruction (SI) · ECO1010F', actionTaken: 'Supplemental instruction (SI)', status: 'open' },
    { ...base, id: 'int-demo-3', concern: 'Frequent one-on-ones', actionTaken: 'Frequent one-on-ones', status: 'open' },
    { ...base, id: 'int-demo-4', concern: 'Alumni mentor', actionTaken: 'Alumni mentor', status: 'open' },
  ];
}
