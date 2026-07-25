/**
 * Server-side domain catalogue and input validation.
 *
 * The SPA computes; the API validates. These constants mirror the frontend's
 * `src/sports.js` / `src/data.jsx` so the API can reject a malformed tournament,
 * entry or result without importing the SPA bundle. Keep the two in sync — the
 * unit tests in test/ assert the overlap that matters (sport keys, doc keys,
 * squad bounds).
 */

/* ─────────────────────────────── Sports ─────────────────────────────────── */

/** Mirror of SPORT_KEYS in src/sports.js. */
export const SPORT_KEYS = new Set([
  'cricket',
  'rugby',
  'hockey',
  'netball',
  'football',
  'basketball',
  'waterpolo',
  'tennis',
  'athletics',
  'swimming',
]);

/** Mirror of each sport's `squad` bounds — the server gate on squad size. */
export const SQUAD_LIMITS: Record<string, { min: number; max: number }> = {
  cricket: { min: 11, max: 16 },
  rugby: { min: 15, max: 23 },
  hockey: { min: 11, max: 18 },
  netball: { min: 7, max: 12 },
  football: { min: 11, max: 18 },
  basketball: { min: 5, max: 12 },
  waterpolo: { min: 7, max: 13 },
  tennis: { min: 4, max: 10 },
  athletics: { min: 1, max: 60 },
  swimming: { min: 1, max: 40 },
};

/** Meet-style codes score individuals across events and get no fixture draw. */
export const MEET_SPORTS = new Set(['athletics', 'swimming']);

export const TOURNAMENT_FORMATS = new Set(['pool_playoff', 'round_robin', 'knockout', 'meet']);

export const TOURNAMENT_STATUSES = new Set(['draft', 'open', 'closed', 'live', 'complete']);

export const ENTRY_STATUSES = new Set([
  'pending',
  'accepted',
  'waitlisted',
  'declined',
  'withdrawn',
]);

export const RESULT_STATUSES = new Set(['played', 'forfeit', 'abandoned']);

/* ────────────────────────── Entry-pack documents ────────────────────────── */

/**
 * Server-side mirror of ENTRY_DOCS in src/data.jsx — the only entry-pack doc
 * keys the API accepts. Without this gate any authenticated client (e.g. a stale
 * pre-deploy SPA tab) can write retired or arbitrary keys, recreating the
 * orphaned-PII state the cleanup scripts exist to remove (see
 * docs/guides/popia-compliance.md). Keep in sync when ENTRY_DOCS changes.
 */
export const DOC_KEYS = new Set([
  'indemnity',
  'teamList',
  'ageProof',
  'medical',
  'codeOfConduct',
  'safeguarding',
  'insurance',
  'weightForAge',
  'travel',
]);

/**
 * Docs where one file is never enough, and the minimum that satisfies them.
 * Mirror of the `multi` field on ENTRY_DOCS.
 */
export const MULTI_FILE_DOCS: Record<string, number> = {
  safeguarding: 2,
  medical: 2,
};

/** Upper bound on stored files per document — a runaway-append backstop. */
export const MAX_DOC_FILES = 60;

/**
 * Accepted upload content types → stored object-key extension.
 * Mirror of DOC_MIME_TYPES in src/data.jsx. Word covers Google Docs (which
 * exports .docx/.pdf). The presigned PUT is minted with exactly one of these,
 * so S3 rejects anything else at upload time.
 */
export const DOC_CONTENT_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

/* ───────────────────────────── Validation ───────────────────────────────── */

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate a tournament create/patch. Returns an error message (callers map to
 * HTTP 400) or null. Only checks fields present in the patch, so a partial
 * update never trips on an absent field.
 */
export function validateTournamentPatch(patch: {
  sport?: string;
  format?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  entryDeadline?: string;
  poolCount?: number;
  maxEntrants?: number;
  entryFee?: number;
  entryDocs?: string[];
  venues?: Array<{ id?: string; name?: string }>;
}): string | null {
  if (patch.sport && !SPORT_KEYS.has(patch.sport)) {
    return `unknown sport: ${patch.sport}`;
  }
  if (patch.format && !TOURNAMENT_FORMATS.has(patch.format)) {
    return `unknown format: ${patch.format}`;
  }
  if (patch.status && !TOURNAMENT_STATUSES.has(patch.status)) {
    return `unknown status: ${patch.status}`;
  }
  // A meet has no fixture draw, so pairing it with a bracket format is a
  // contradiction the organiser would only discover when the draw came back empty.
  if (patch.sport && MEET_SPORTS.has(patch.sport) && patch.format && patch.format !== 'meet') {
    return `${patch.sport} is a meet — format must be "meet"`;
  }
  for (const field of ['startDate', 'endDate', 'entryDeadline'] as const) {
    const v = patch[field];
    if (v !== undefined && v !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return `${field} must be an ISO date (YYYY-MM-DD)`;
    }
  }
  if (patch.startDate && patch.endDate && patch.endDate < patch.startDate) {
    return 'endDate is before startDate';
  }
  // Entries must close before the first ball, or a school could enter mid-event.
  if (patch.entryDeadline && patch.startDate && patch.entryDeadline > patch.startDate) {
    return 'entryDeadline is after startDate';
  }
  if (
    patch.poolCount !== undefined &&
    (!isFiniteNum(patch.poolCount) || patch.poolCount < 1 || patch.poolCount > 16)
  ) {
    return 'poolCount must be between 1 and 16';
  }
  if (
    patch.maxEntrants !== undefined &&
    (!isFiniteNum(patch.maxEntrants) || patch.maxEntrants < 2 || patch.maxEntrants > 128)
  ) {
    return 'maxEntrants must be between 2 and 128';
  }
  if (patch.entryFee !== undefined && (!isFiniteNum(patch.entryFee) || patch.entryFee < 0)) {
    return 'entryFee must be zero or positive';
  }
  if (patch.entryDocs) {
    const bad = patch.entryDocs.filter((k) => !DOC_KEYS.has(k));
    if (bad.length) return `unknown document keys: ${bad.join(', ')}`;
  }
  if (patch.venues) {
    const ids = patch.venues.map((v) => v.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) return 'duplicate venue ids';
    if (patch.venues.some((v) => !v.name)) return 'every venue needs a name';
  }
  return null;
}

/**
 * Validate an entry patch. `validDocKeys` is DOC_KEYS plus any key already on
 * the entry, so a patch can still carry or clear a retired key that predates a
 * catalogue change, but can never introduce one.
 */
export function validateEntryPatch(
  patch: {
    status?: string;
    docs?: Record<string, unknown>;
    docMeta?: Record<string, unknown>;
    pool?: string | null;
    seed?: number | null;
    entryFeePaid?: boolean;
    contact?: { email?: string; cell?: string };
  },
  validDocKeys: Set<string>,
): string | null {
  if (patch.status && !ENTRY_STATUSES.has(patch.status)) {
    return `unknown entry status: ${patch.status}`;
  }
  const docKeys = [...Object.keys(patch.docs ?? {}), ...Object.keys(patch.docMeta ?? {})];
  const badDocs = [...new Set(docKeys.filter((k) => !validDocKeys.has(k)))];
  if (badDocs.length) return `unknown document keys: ${badDocs.join(', ')}`;
  if (patch.pool !== undefined && patch.pool !== null && !/^[A-P]$/.test(patch.pool)) {
    return 'pool must be a single letter A–P';
  }
  if (
    patch.seed !== undefined &&
    patch.seed !== null &&
    (!isFiniteNum(patch.seed) || patch.seed < 1)
  ) {
    return 'seed must be a positive number';
  }
  if (patch.contact?.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.contact.email)) {
    return 'contact email is not a valid address';
  }
  // South African mobile numbers, with or without the +27 country code.
  if (
    patch.contact?.cell &&
    !/^(\+?27|0)[6-8]\d{8}$/.test(patch.contact.cell.replace(/[\s-]/g, ''))
  ) {
    return 'contact cell is not a valid South African mobile number';
  }
  return null;
}

/**
 * Validate a squad against the sport's bounds. Called on submission, not on
 * every individual registration — a squad is legitimately under-strength while
 * it's being filled in.
 */
export function validateSquadSize(sportKey: string, count: number): string | null {
  const limits = SQUAD_LIMITS[sportKey];
  if (!limits) return `unknown sport: ${sportKey}`;
  if (count < limits.min) return `squad has ${count} players, minimum is ${limits.min}`;
  if (count > limits.max) return `squad has ${count} players, maximum is ${limits.max}`;
  return null;
}

/**
 * Validate a captured result. Scores must be present and sane for a played
 * match; a forfeit needs to name the side that forfeited, and that side must
 * actually be in the fixture.
 */
export function validateResult(
  result: {
    status?: string;
    homeScore?: number;
    awayScore?: number;
    forfeitBy?: string;
    bonusHome?: number;
    bonusAway?: number;
  },
  fixture: { home?: string; away?: string },
): string | null {
  const status = result.status ?? 'played';
  if (!RESULT_STATUSES.has(status)) return `unknown result status: ${status}`;

  if (status === 'forfeit') {
    if (!result.forfeitBy) return 'a forfeit must name the forfeiting team';
    if (result.forfeitBy !== fixture.home && result.forfeitBy !== fixture.away) {
      return 'forfeitBy is not one of the teams in this fixture';
    }
    return null;
  }

  for (const side of ['homeScore', 'awayScore'] as const) {
    const v = result[side];
    if (!isFiniteNum(v)) return `${side} is required for a ${status} match`;
    if (v < 0) return `${side} cannot be negative`;
    if (!Number.isInteger(v)) return `${side} must be a whole number`;
    if (v > 10000) return `${side} is implausibly large`;
  }
  for (const side of ['bonusHome', 'bonusAway'] as const) {
    const v = result[side];
    if (v !== undefined && (!isFiniteNum(v) || v < 0 || v > 5)) {
      return `${side} must be between 0 and 5`;
    }
  }
  return null;
}

/**
 * Validate a school directory record. Name is the only hard requirement — a
 * school can be added from a phone call with nothing else known yet.
 */
export function validateSchoolPatch(patch: {
  name?: string;
  province?: string;
  location?: { lat?: number; lon?: number };
}): string | null {
  if (patch.name !== undefined && !String(patch.name).trim()) return 'school name is required';
  if (patch.location) {
    const { lat, lon } = patch.location;
    if (lat !== undefined && (!isFiniteNum(lat) || lat < -90 || lat > 90))
      return 'invalid latitude';
    if (lon !== undefined && (!isFiniteNum(lon) || lon < -180 || lon > 180)) {
      return 'invalid longitude';
    }
  }
  return null;
}

/* ═══════════════════════ Venue assessment (facilities) ═══════════════════ */

/**
 * The scored categories of a facility audit. Mirror of ASSESSMENT_CATEGORIES in
 * src/facilities.js. Each is scored 0–5 (0 = not present / unusable).
 */
export const ASSESSMENT_CATEGORIES = new Set([
  'surface',
  'markings',
  'safety',
  'changing',
  'ablutions',
  'floodlights',
  'spectator',
  'accessibility',
  'medical',
  'signage',
]);

/** ready | conditional | not_ready — the headline verdict. */
export const ASSESSMENT_VERDICTS = new Set(['ready', 'conditional', 'not_ready']);

export function validateAssessmentPatch(patch: {
  venueId?: string;
  assessedAt?: string;
  verdict?: string;
  scores?: Array<{ key?: string; score?: number }>;
  actions?: Array<{ text?: string; priority?: string }>;
}): string | null {
  if (patch.assessedAt !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(patch.assessedAt)) {
    return 'assessedAt must be an ISO date (YYYY-MM-DD)';
  }
  if (patch.verdict && !ASSESSMENT_VERDICTS.has(patch.verdict)) {
    return `unknown verdict: ${patch.verdict}`;
  }
  if (patch.scores) {
    for (const s of patch.scores) {
      if (!s.key || !ASSESSMENT_CATEGORIES.has(s.key)) return `unknown score category: ${s.key}`;
      if (!isFiniteNum(s.score) || (s.score as number) < 0 || (s.score as number) > 5) {
        return 'each score must be between 0 and 5';
      }
    }
  }
  if (patch.actions) {
    for (const a of patch.actions) {
      if (!a.text || !String(a.text).trim()) return 'every action needs a description';
      if (a.priority && !['low', 'medium', 'high'].includes(a.priority)) {
        return `unknown action priority: ${a.priority}`;
      }
    }
  }
  return null;
}

/* ═══════════════════════════════ Ticketing ══════════════════════════════ */

export const PAYMENT_STATUSES = new Set(['unpaid', 'paid', 'comp', 'refunded']);
export const TICKET_STATUSES = new Set(['valid', 'checked_in', 'void']);

export function validateTicketTypePatch(patch: {
  name?: string;
  priceCents?: number;
  capacity?: number;
  eventName?: string;
}): string | null {
  if (patch.name !== undefined && !String(patch.name).trim()) return 'ticket type needs a name';
  if (
    patch.priceCents !== undefined &&
    (!isFiniteNum(patch.priceCents) || patch.priceCents < 0 || !Number.isInteger(patch.priceCents))
  ) {
    return 'priceCents must be a whole, non-negative number of cents';
  }
  if (
    patch.capacity !== undefined &&
    (!isFiniteNum(patch.capacity) || patch.capacity < 0 || patch.capacity > 200000)
  ) {
    return 'capacity must be between 0 and 200000';
  }
  return null;
}

export function validateTicketPatch(patch: {
  buyerName?: string;
  buyerEmail?: string;
  quantity?: number;
  status?: string;
  payment?: string;
}): string | null {
  if (patch.buyerName !== undefined && !String(patch.buyerName).trim()) {
    return 'a ticket needs a buyer name';
  }
  if (patch.buyerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.buyerEmail)) {
    return 'buyer email is not a valid address';
  }
  if (
    patch.quantity !== undefined &&
    (!isFiniteNum(patch.quantity) || patch.quantity < 1 || patch.quantity > 500)
  ) {
    return 'quantity must be between 1 and 500';
  }
  if (patch.status && !TICKET_STATUSES.has(patch.status))
    return `unknown ticket status: ${patch.status}`;
  if (patch.payment && !PAYMENT_STATUSES.has(patch.payment)) {
    return `unknown payment status: ${patch.payment}`;
  }
  return null;
}

/* ═══════════════════════════════ Parking ════════════════════════════════ */

export const PARKING_ZONE_KINDS = new Set([
  'visiting_school',
  'vip',
  'bus',
  'general',
  'staff',
  'disabled',
]);
export const PARKING_PASS_STATUSES = new Set(['allocated', 'arrived', 'void']);

export function validateParkingZonePatch(patch: {
  name?: string;
  kind?: string;
  capacity?: number;
}): string | null {
  if (patch.name !== undefined && !String(patch.name).trim()) return 'a zone needs a name';
  if (patch.kind && !PARKING_ZONE_KINDS.has(patch.kind)) return `unknown zone kind: ${patch.kind}`;
  if (
    patch.capacity !== undefined &&
    (!isFiniteNum(patch.capacity) || patch.capacity < 0 || patch.capacity > 100000)
  ) {
    return 'capacity must be between 0 and 100000';
  }
  return null;
}

export function validateParkingPassPatch(patch: {
  allocatedTo?: string;
  bays?: number;
  status?: string;
}): string | null {
  if (patch.allocatedTo !== undefined && !String(patch.allocatedTo).trim()) {
    return 'a pass needs an allocatee';
  }
  if (
    patch.bays !== undefined &&
    (!isFiniteNum(patch.bays) || patch.bays < 1 || patch.bays > 200)
  ) {
    return 'bays must be between 1 and 200';
  }
  if (patch.status && !PARKING_PASS_STATUSES.has(patch.status)) {
    return `unknown pass status: ${patch.status}`;
  }
  return null;
}

/* ═══════════════════ Academic support (university module) ════════════════ */

/** Mirror of SQUADS in src/academic-model.js. */
export const ACADEMIC_SQUADS = new Set(['1st Team', 'U20s', 'Both', 'General']);

/** Mirror of FACULTIES. */
export const ACADEMIC_FACULTIES = new Set([
  'Commerce',
  'Engineering & the Built Environment',
  'Health Sciences',
  'Humanities',
  'Law',
  'Science',
]);

export const ATHLETE_STATUSES = new Set(['active', 'graduated', 'withdrawn']);
export const RISK_CATEGORIES = new Set(['high', 'medium', 'low']);
export const INTERVENTION_STATUSES = new Set(['open', 'in_progress', 'resolved']);

/* Academic Development Plan vocab (mirrors src/academic-model.js). */
export const MODULE_STATUSES = new Set(['on_track', 'watch', 'at_risk']);
export const ADP_SECTION_KEYS = new Set(['content', 'assessments', 'worklife', 'careers']);
export const INTERVENTION_TYPES = new Set([
  'one_on_ones',
  'course_tutor',
  'supplemental_instruction',
  'study_group',
  'alumni_mentor',
  'referral',
  'concession',
  'financial_support',
  'reduced_load',
  'leave_of_absence',
]);
export const PLAN_STATUSES = new Set(['draft', 'sent', 'completed']);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate an external mentor: a name and a well-formed email are required. */
export function validateMentor(patch: {
  name?: string;
  email?: string;
}): string | null {
  if (patch.name !== undefined && !String(patch.name).trim()) return 'a name is required';
  if (patch.email !== undefined && !EMAIL_RE.test(String(patch.email).trim())) {
    return 'a valid email address is required';
  }
  return null;
}

/** A 0–100 academic metric, when present. */
function validPct(v: unknown, label: string): string | null {
  if (v === undefined || v === null) return null;
  if (!isFiniteNum(v) || v < 0 || v > 100) return `${label} must be between 0 and 100`;
  return null;
}

export function validateAthletePatch(patch: {
  firstName?: string;
  lastName?: string;
  studentNumber?: string;
  squad?: string;
  faculty?: string;
  status?: string;
  riskCategory?: string;
  creditsRegistered?: number;
  lectureAttendance?: number;
  tutorialAttendance?: number;
  assignmentCompletion?: number;
  semesterAverage?: number;
  facultyWarning?: string;
}): string | null {
  if (patch.firstName !== undefined && !String(patch.firstName).trim()) {
    return 'first name is required';
  }
  if (patch.lastName !== undefined && !String(patch.lastName).trim()) {
    return 'surname is required';
  }
  if (patch.studentNumber !== undefined && !String(patch.studentNumber).trim()) {
    return 'student number is required';
  }
  if (patch.squad && !ACADEMIC_SQUADS.has(patch.squad)) return `unknown squad: ${patch.squad}`;
  if (patch.faculty && !ACADEMIC_FACULTIES.has(patch.faculty)) {
    return `unknown faculty: ${patch.faculty}`;
  }
  if (patch.status && !ATHLETE_STATUSES.has(patch.status)) {
    return `unknown status: ${patch.status}`;
  }
  if (patch.riskCategory && !RISK_CATEGORIES.has(patch.riskCategory)) {
    return `unknown risk category: ${patch.riskCategory}`;
  }
  if (
    patch.creditsRegistered !== undefined &&
    (!isFiniteNum(patch.creditsRegistered) ||
      patch.creditsRegistered < 0 ||
      patch.creditsRegistered > 500)
  ) {
    return 'creditsRegistered must be between 0 and 500';
  }
  for (const [key, label] of [
    ['lectureAttendance', 'lecture attendance'],
    ['tutorialAttendance', 'tutorial attendance'],
    ['assignmentCompletion', 'assignment completion'],
    ['semesterAverage', 'semester average'],
  ] as const) {
    const err = validPct(patch[key], label);
    if (err) return err;
  }
  if (patch.facultyWarning && !['Yes', 'No'].includes(patch.facultyWarning)) {
    return 'facultyWarning must be Yes or No';
  }
  return null;
}

const isRating = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5);

/** Validate the Academic Development Plan payload (kind === 'adp'). */
function validateAdp(patch: {
  modules?: unknown;
  sections?: unknown;
  plan?: unknown;
}): string | null {
  if (patch.modules !== undefined) {
    if (!Array.isArray(patch.modules)) return 'modules must be a list';
    for (const m of patch.modules as Array<Record<string, unknown>>) {
      if (!m || typeof m !== 'object') return 'each module must be an object';
      if (!String(m.code ?? '').trim()) return 'each module needs a code';
      if (m.status !== undefined && !MODULE_STATUSES.has(String(m.status))) {
        return `unknown module status: ${String(m.status)}`;
      }
    }
  }
  if (patch.sections !== undefined) {
    if (typeof patch.sections !== 'object' || patch.sections === null) {
      return 'sections must be an object';
    }
    for (const [key, sec] of Object.entries(patch.sections as Record<string, unknown>)) {
      if (!ADP_SECTION_KEYS.has(key)) return `unknown section: ${key}`;
      const s = sec as { modules?: unknown; ratings?: unknown };
      const ratingMaps: unknown[] = [];
      if (s.ratings) ratingMaps.push(s.ratings);
      if (s.modules) ratingMaps.push(...Object.values(s.modules as Record<string, unknown>));
      for (const map of ratingMaps) {
        for (const r of Object.values((map ?? {}) as Record<string, unknown>)) {
          // A rating is a single 1–5 number; older plans stored a {self, mentor}
          // pair, still accepted for back-compat.
          const pair = r as { self?: unknown; mentor?: unknown } | null;
          const ok =
            isRating(r) ||
            (!!pair && typeof pair === 'object' && isRating(pair.self) && isRating(pair.mentor));
          if (!ok) return 'each rating must be a whole number from 1 to 5';
        }
      }
    }
  }
  if (patch.plan !== undefined) {
    if (!Array.isArray(patch.plan)) return 'plan must be a list';
    for (const item of patch.plan as Array<Record<string, unknown>>) {
      if (!item || !INTERVENTION_TYPES.has(String(item.type))) {
        return `unknown intervention type: ${String(item?.type)}`;
      }
      if (
        item.dueDate !== undefined &&
        item.dueDate !== '' &&
        !/^\d{4}-\d{2}-\d{2}$/.test(String(item.dueDate))
      ) {
        return 'intervention dueDate must be an ISO date (YYYY-MM-DD)';
      }
    }
  }
  return null;
}

export function validateCheckIn(patch: {
  studentNumber?: string;
  date?: string;
  followUpRequired?: string;
  answers?: Record<string, unknown>;
  kind?: string;
  modules?: unknown;
  sections?: unknown;
  plan?: unknown;
}): string | null {
  if (!patch.studentNumber?.trim()) return 'studentNumber is required';
  if (patch.date !== undefined && patch.date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(patch.date)) {
    return 'date must be an ISO date (YYYY-MM-DD)';
  }
  if (patch.followUpRequired && !['Yes', 'No'].includes(patch.followUpRequired)) {
    return 'followUpRequired must be Yes or No';
  }
  if (patch.answers) {
    for (const v of Object.values(patch.answers)) {
      if (v !== undefined && !['Yes', 'No', 'N/A', ''].includes(String(v))) {
        return 'each answer must be Yes, No or N/A';
      }
    }
  }
  if (patch.kind === 'adp') return validateAdp(patch);
  return null;
}

export function validateInterventionPatch(patch: {
  studentNumber?: string;
  date?: string;
  concern?: string;
  status?: string;
  followUpDate?: string;
}): string | null {
  if (patch.studentNumber !== undefined && !String(patch.studentNumber).trim()) {
    return 'studentNumber is required';
  }
  if (patch.concern !== undefined && !String(patch.concern).trim()) {
    return 'a concern is required';
  }
  for (const field of ['date', 'followUpDate'] as const) {
    const v = patch[field];
    if (v !== undefined && v !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return `${field} must be an ISO date (YYYY-MM-DD)`;
    }
  }
  if (patch.status && !INTERVENTION_STATUSES.has(patch.status)) {
    return `unknown intervention status: ${patch.status}`;
  }
  return null;
}
