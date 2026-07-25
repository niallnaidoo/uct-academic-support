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
      status: 'active',
      consentAt: i % 9 === 0 ? undefined : '2026-02-01T08:00:00.000Z',
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
