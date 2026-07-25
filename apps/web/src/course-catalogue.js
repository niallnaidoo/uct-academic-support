/**
 * UCT course catalogue lookup + auto-difficulty.
 *
 * The raw data lives in course-catalogue.data.json (auto-extracted from the ten
 * 2026 faculty handbooks — code, title, faculty, credits, NQF level, convener
 * and entry requirements). This module wraps it in a friendly lookup and derives
 * an intrinsic difficulty for each course so the screener can pre-fill it.
 *
 * Difficulty is a heuristic — it reads the year-level from the code, the NQF
 * level and whether the subject is quantitatively heavy — and is always a
 * starting point the mentor can override, never the final word.
 */
import catalogueData from './course-catalogue.data.json';

export const CAT_FACULTIES = catalogueData.faculties;
const COURSE_CATALOGUE = catalogueData.courses;

/** Normalise a typed code: upper-case, strip spaces, drop a trailing /X. */
export function normaliseCode(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/\/[A-Z]$/, '');
}

/** Look a course up by code. Returns a friendly record, or null if unknown. */
export function lookupCourse(raw) {
  const code = normaliseCode(raw);
  const r = COURSE_CATALOGUE[code];
  if (!r) return null;
  return {
    code,
    title: r.t,
    faculty: CAT_FACULTIES[r.f],
    credits: r.cr ?? null,
    nqf: r.n ?? null,
    convener: r.cv ?? '',
    prerequisites: r.p ?? '',
  };
}

export const CATALOGUE_SIZE = Object.keys(COURSE_CATALOGUE).length;

/**
 * Type-ahead suggestions for the screener's code box. Matches on code prefix
 * first, then title substring. Capped for a tidy dropdown.
 */
export function courseSuggestions(query, limit = 8) {
  const q = normaliseCode(query);
  if (q.length < 2) return [];
  const titleQ = String(query ?? '')
    .trim()
    .toLowerCase();
  const byCode = [];
  const byTitle = [];
  for (const code in COURSE_CATALOGUE) {
    if (code.startsWith(q)) byCode.push(code);
    else if (titleQ.length >= 3 && COURSE_CATALOGUE[code].t.toLowerCase().includes(titleQ))
      byTitle.push(code);
    if (byCode.length >= limit) break;
  }
  return [...byCode, ...byTitle].slice(0, limit).map((code) => ({
    code,
    title: COURSE_CATALOGUE[code].t,
  }));
}

/* ─────────────────────────── Auto-difficulty ─────────────────────────────── */

/**
 * Subjects that are quantitatively demanding — maths, the physical sciences,
 * engineering, and the number-heavy Commerce subjects. A course in one of these
 * carries a difficulty bump over a same-year course in an essay-based subject.
 */
const QUANT_SUBJECTS = new Set([
  // Maths, stats, physical & computer sciences
  'MAM',
  'APM',
  'MTX',
  'STA',
  'PHY',
  'AST',
  'CEM',
  'CHE',
  'CSC',
  'GEO',
  // Engineering
  'EEE',
  'ELE',
  'MEC',
  'MEG',
  'CIV',
  'CON',
  'CHE',
  'MYG',
  'APG',
  'EGS',
  // Number-heavy Commerce
  'ACC',
  'FTX',
  'ECO',
  'FIN',
  'ACT',
  'BUS',
  'INF',
  'MAM',
]);

export const DIFFICULTY_META = {
  1: { level: 1, label: 'Gentle', tone: 'green', screener: 'Easy' },
  2: { level: 2, label: 'Manageable', tone: 'green', screener: 'Easy' },
  3: { level: 3, label: 'Demanding', tone: 'amber', screener: 'Manageable' },
  4: { level: 4, label: 'Hard', tone: 'red', screener: 'Hard' },
  5: { level: 5, label: 'Very hard', tone: 'red', screener: 'Hard' },
};

/**
 * An intrinsic 1–5 difficulty for a course. Reads the year-level from the code
 * (1st-year is gentler than a senior course), the NQF level (honours and above
 * can't be gentle), and whether the subject is quantitatively heavy. Returns
 * null for an unrecognisable code.
 */
export function moduleDifficulty(raw, nqfHint = null) {
  const code = normaliseCode(raw);
  const m = code.match(/^([A-Z]{3})(\d)/);
  if (!m) return null;
  const subject = m[1];
  const year = Number(m[2]);
  const nqf = nqfHint ?? lookupCourse(code)?.nqf ?? null;

  // Year-level base: 1 → 2, 2 → 3, 3 → 4, postgraduate (4/5/6) → 5.
  let level = year <= 1 ? 2 : year === 2 ? 3 : year === 3 ? 4 : 5;
  const quant = QUANT_SUBJECTS.has(subject);
  if (quant) level = Math.min(5, level + 1);
  // Honours-and-up can't read as gentle.
  if (nqf != null) {
    if (nqf >= 8) level = Math.max(level, 4);
    if (nqf >= 9) level = 5;
  }
  level = Math.max(1, Math.min(5, level));

  const reasonBits = [`Year ${year}`];
  if (nqf != null) reasonBits.push(`NQF ${nqf}`);
  if (quant) reasonBits.push('quantitative');
  return { ...DIFFICULTY_META[level], reason: reasonBits.join(' · '), auto: true };
}
