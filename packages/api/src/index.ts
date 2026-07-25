/**
 * School Tournament Platform API — Hono on Lambda.
 *
 * One app behind the API Gateway $default route. Public routes (/tenant,
 * /register) need no token; everything else runs through authenticate +
 * requireTenantMembership so the caller is scoped to one tenant. Admin-only
 * routes add requireAdmin (the host school's organisers); entry routes assert
 * per-school access, so a visiting school's rep only ever reaches its own entry.
 *
 * All persistence goes through ./repo (tenant-scoped keys). Computation
 * (draws, log tables, slot allocation) stays in the browser — this layer is thin CRUD.
 * See docs/architecture/0004 and docs/api/.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { handle } from 'hono/aws-lambda';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import {
  ensurePasswordlessUser,
  adminGlobalSignOut,
  adminDeleteCognitoUser,
  cognitoUserExists,
} from './cognito-users.js';
import { reconcileTenantAdmins } from './reconcile.js';
import {
  authenticate,
  requireTenantMembership,
  requireAdmin,
  assertSchoolAccess,
  resolveTenant,
  HttpError,
  type HonoEnv,
} from './auth.js';
import * as repo from './repo.js';
import { VersionConflictError, LastAdminError } from './repo.js';
import {
  validateSchoolPatch,
  validateEntryPatch,
  validateTournamentPatch,
  validateResult,
  validateSquadSize,
  validateAssessmentPatch,
  validateTicketTypePatch,
  validateTicketPatch,
  validateParkingZonePatch,
  validateParkingPassPatch,
  validateAthletePatch,
  validateCheckIn,
  validateInterventionPatch,
  validateMentor,
  DOC_KEYS,
  DOC_CONTENT_TYPES,
  MULTI_FILE_DOCS,
  MAX_DOC_FILES,
  SQUAD_LIMITS,
  SPORT_KEYS,
  MEET_SPORTS,
} from './catalogue.js';
import { sendSchoolDraw, sendStaffInvite, type Channel, type SendResult } from './notify/index.js';
import type {
  School,
  SchoolSpec,
  CommEvent,
  Entry,
  Fixture,
  Membership,
  Tournament,
  TenantConfig,
  UserProfile,
  PlayerRegistration,
  VenueAssessment,
  TicketType,
  Ticket,
  ParkingZone,
  ParkingPass,
  StudentAthlete,
  Mentor,
  AcademicCheckIn,
  AcademicIntervention,
} from './types.js';

const s3 = new S3Client({});
const cognito = new CognitoIdentityProviderClient({});
const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET!;
const USER_POOL_ID = process.env.USER_POOL_ID!;
const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB

/** Reject unknown/retired entry-pack doc keys before any S3 or record work. */
function assertDocKey(key: string): void {
  if (!DOC_KEYS.has(key)) throw new HttpError(400, `unknown document key "${key}"`);
}

/** How many files satisfy a doc on its own merits (multi-file docs need more than one). */
const minFilesFor = (key: string): number => MULTI_FILE_DOCS[key] ?? 1;
const isMultiFileDoc = (key: string): boolean => key in MULTI_FILE_DOCS;

/** S3 prefix an entry's uploads must live under: tenant / tournament / school. */
const entryPrefix = (tenant: string, tournamentId: string, schoolId: string) =>
  `${tenant}/${tournamentId}/${schoolId}/`;

/**
 * A recorded objectKey must live under this ENTRY's own S3 prefix. view-url and
 * the multi-file DELETE presign/delete whatever is on record, so record integrity
 * IS their security gate — without this check a rep could record another school's
 * key and then read (or S3-delete) that school's PII through their own record.
 * Scoping to the tournament as well as the school means a rep also can't reach
 * their own school's documents from a different event. `local/` is the no-S3
 * local-dev sentinel.
 */
function assertOwnObjectKey(
  tenant: string,
  tournamentId: string,
  schoolId: string,
  objectKey: string,
): void {
  if (objectKey.startsWith('local/')) return;
  if (!objectKey.startsWith(entryPrefix(tenant, tournamentId, schoolId))) {
    throw new HttpError(400, 'objectKey does not belong to this entry');
  }
}

/** Apply assertOwnObjectKey to every file reference inside a docMeta patch. */
function assertDocMetaObjectKeys(
  tenant: string,
  tournamentId: string,
  schoolId: string,
  docMeta: Record<string, unknown>,
): void {
  for (const value of Object.values(docMeta)) {
    const m = value as { objectKey?: unknown; files?: unknown } | null;
    if (typeof m?.objectKey === 'string') {
      assertOwnObjectKey(tenant, tournamentId, schoolId, m.objectKey);
    }
    if (Array.isArray(m?.files)) {
      for (const f of m.files as { objectKey?: unknown }[]) {
        if (typeof f?.objectKey === 'string') {
          assertOwnObjectKey(tenant, tournamentId, schoolId, f.objectKey);
        }
      }
    }
  }
}

/** One stored compliance-document file (safeguarding holds an array of these). */
interface DocFileEntry {
  objectKey: string;
  size: number;
  contentType?: string;
  uploadedAt: string;
}

/**
 * Mirror of `fileSetMeta` in the frontend's data.jsx — normalizes every historical
 * docMeta shape to `{ files, markedCompliant, at }`: the `{ files: [...] }` wrapper
 * as-is, a legacy single upload `{ objectKey }` as a one-entry array, and the
 * organiser `{ markedCompliant }` sentinel as an empty array with the flag set.
 * Every doc reads through this, not just the multi-file ones, so a doc that later
 * gains a file minimum needs no data migration.
 */
function fileSetMeta(meta: unknown): {
  files: DocFileEntry[];
  markedCompliant: boolean;
  at?: string;
} {
  const m = (meta ?? {}) as Record<string, unknown>;
  if (Array.isArray(m.files)) {
    return {
      files: m.files as DocFileEntry[],
      markedCompliant: !!m.markedCompliant,
      at: m.at as string | undefined,
    };
  }
  if (m.objectKey) {
    return { files: [m as unknown as DocFileEntry], markedCompliant: !!m.markedCompliant };
  }
  return { files: [], markedCompliant: !!m.markedCompliant, at: m.at as string | undefined };
}

/** Re-wrap normalized file-set state as the stored docMeta value. */
function fileSetValue(files: DocFileEntry[], markedCompliant: boolean, at?: string) {
  return markedCompliant ? { files, markedCompliant: true, at } : { files };
}

const app = new Hono<HonoEnv>();

// CORS: allow localhost (dev), *.cloudfront.net, and any host in ALLOWED_ORIGINS.
// A wildcard origin alongside bearer tokens + the x-tenant header is too open.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * True if `origin` (scheme://host[:port]) is a trusted app origin: localhost (dev),
 * any *.cloudfront.net, or an explicit ALLOWED_ORIGINS entry (custom tenant domains).
 * Shared by CORS and the invite-link host check so an admin can't send an invite
 * pointing at an arbitrary/phishing domain.
 */
function originAllowed(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname.endsWith('.cloudfront.net');
  } catch {
    return false;
  }
}

app.use(
  '*',
  cors({
    origin: (origin) => (origin && originAllowed(origin) ? origin : undefined),
    // x-dev-auth is the local-dev identity header; harmless in cloud (the API only
    // trusts it when LOCAL_AUTH=1 — see auth.ts), required for the offline stack.
    allowHeaders: ['content-type', 'authorization', 'x-tenant', 'x-dev-auth'],
  }),
);

const now = () => new Date().toISOString();

/** Surface an entry's denormalized squad count as `players` (no N+1 COUNT). */
function withPlayerCount(entry: Entry): Entry & { players: number } {
  return { ...entry, players: entry.playerCount ?? 0 };
}

// ───────────────────────── Public routes ─────────────────────────

/** Tenant branding by host (or ?tenant= / x-tenant in dev). No auth. */
app.get('/tenant', async (c) => {
  const tenant = resolveTenant(c) ?? c.req.query('tenant') ?? null;
  if (!tenant) throw new HttpError(400, 'unknown tenant');
  const config = await repo.getTenantConfig(tenant);
  if (!config) throw new HttpError(404, 'tenant not found');
  // Only branding and the host's public identity are unauthenticated. Venues,
  // entry-doc config and the signup pointer stay behind auth — a venue list with
  // coordinates is site intelligence, not marketing copy.
  return c.json({
    tenant: config.tenant,
    branding: config.branding,
    host: {
      schoolName: config.host?.schoolName ?? config.branding?.name ?? config.tenant,
      town: config.host?.town,
      province: config.host?.province,
    },
  });
});
/**
 * Validate a squad-registration link → returns the tournament + school names for
 * the form header. The token self-describes its tenant, tournament and school, so
 * this route never trusts the request host for scope.
 */
app.get('/register/:tournamentId/:schoolId', async (c) => {
  const token = c.req.query('t');
  if (!token) throw new HttpError(400, 'missing token');
  const tournamentId = c.req.param('tournamentId');
  const schoolId = c.req.param('schoolId');
  const resolved = await repo.getToken(token);
  // A school-signup token carries no schoolId, so it fails this match — squad
  // links only. Both ids must match, or a link for one event would open another.
  if (!resolved || resolved.schoolId !== schoolId || resolved.tournamentId !== tournamentId) {
    throw new HttpError(404, 'invalid registration link');
  }
  const [school, tournament, entry] = await Promise.all([
    repo.getSchool(resolved.tenant, schoolId),
    repo.getTournament(resolved.tenant, tournamentId),
    repo.getEntry(resolved.tenant, tournamentId, schoolId),
  ]);
  if (!school || !tournament || !entry) throw new HttpError(404, 'entry not found');
  // A withdrawn or declined entry must not keep collecting children's data.
  if (entry.status === 'withdrawn' || entry.status === 'declined') {
    throw new HttpError(410, 'this entry is no longer active');
  }
  return c.json({
    tenant: resolved.tenant,
    tournamentId,
    tournamentName: tournament.name,
    sport: tournament.sport,
    ageGroup: tournament.ageGroup,
    schoolId: school.id,
    schoolName: school.name,
    teamName: entry.teamName,
    squadMax: tournament.maxEntrants == null ? undefined : undefined,
    registered: entry.playerCount ?? 0,
  });
});

/** Register a squad member. No auth; dedup + POPIA minor consent enforced. */
app.post('/register/:tournamentId/:schoolId', async (c) => {
  const token = c.req.query('t');
  if (!token) throw new HttpError(400, 'missing token');
  const tournamentId = c.req.param('tournamentId');
  const schoolId = c.req.param('schoolId');
  const resolved = await repo.getToken(token);
  if (!resolved || resolved.schoolId !== schoolId || resolved.tournamentId !== tournamentId) {
    throw new HttpError(404, 'invalid registration link');
  }
  const [tournament, entry] = await Promise.all([
    repo.getTournament(resolved.tenant, tournamentId),
    repo.getEntry(resolved.tenant, tournamentId, schoolId),
  ]);
  if (!tournament || !entry) throw new HttpError(404, 'entry not found');
  if (entry.status === 'withdrawn' || entry.status === 'declined') {
    throw new HttpError(410, 'this entry is no longer active');
  }

  const body = await c.req.json<Partial<PlayerRegistration>>();
  if (!body.firstName || !body.lastName || !body.dob) {
    throw new HttpError(400, 'firstName, lastName and dob are required');
  }
  const isMinor = computeIsMinor(body.dob);
  if (isMinor && !body.guardianName) {
    throw new HttpError(400, 'guardianName required for minors (POPIA)');
  }
  // The squad cap is a hard gate on the public path: without it anyone holding
  // the link could inflate a roster past what the age group allows.
  const limits = SQUAD_LIMITS_FOR(tournament.sport);
  if ((entry.playerCount ?? 0) >= limits.max) {
    throw new HttpError(409, `squad is full (maximum ${limits.max} players)`);
  }

  const naturalKey = playerNaturalKey(body);
  const player: PlayerRegistration = {
    naturalKey,
    tournamentId,
    schoolId,
    firstName: body.firstName,
    lastName: body.lastName,
    dob: body.dob,
    cell: body.cell,
    email: body.email,
    isMinor,
    guardianName: body.guardianName,
    guardianCell: body.guardianCell,
    position: body.position,
    jerseyNumber: body.jerseyNumber,
    massKg: body.massKg,
    allergies: body.allergies,
    medicalNotes: body.medicalNotes,
    consentAt: now(),
    createdAt: now(),
    registeredVia: 'link',
    status: 'registered',
  };
  try {
    await repo.createPlayer(resolved.tenant, player);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new HttpError(409, 'already registered');
    }
    throw err;
  }
  return c.json({ ok: true }, 201);
});
// ───────────────────── School self-registration (public) ─────────────────────

const SIGNUPS_PER_HOUR = 30;
const SIGNUP_NAME_MAX = 80;
const SIGNUP_CELL_MAX = 20;

/**
 * Normalize a South African cell number to the canonical stored form `0XXXXXXXXX`
 * (what the admin contact modal and the WhatsApp `toE164` conversion expect), or
 * null when it isn't one. Kept identical to src/api.js (the form validates with
 * the same rule before submitting — EMAIL_RE precedent). The `[6-8]` range is a
 * deliberate permissive SUPERSET of real mobile prefixes (it admits 080x/086/087
 * non-cell ranges) — don't "tighten" it: WhatsApp sends already skip undeliverable
 * numbers, and a false reject here locks a real chair out of signup.
 */
function normalizeZaCell(raw: string): string | null {
  const digits = raw.replace(/[\s\-().]/g, '');
  const m = /^(?:\+?27|0)([6-8]\d{8})$/.exec(digits);
  return m ? `0${m[1]}` : null;
}

/**
 * Resolve a school-signup token to its tenant config, or 404. Requires
 * `kind === 'school-signup'` (a player reg-link token never opens signup), a live
 * config — an erased tenant's signup token must die with it even if the TOKEN#
 * item somehow survived erasure — AND that the token matches the config's
 * `schoolSignupLink` pointer. The pointer match makes the pointer the single
 * source of validity: a TOKEN# item orphaned by a partial rotation/revoke
 * failure (put succeeded, pointer write didn't) is inert rather than a live,
 * invisible, irrevocable signup credential.
 */
async function resolveSignupTenant(token: string | undefined): Promise<TenantConfig> {
  if (!token) throw new HttpError(400, 'missing token');
  const resolved = await repo.getToken(token);
  if (!resolved || resolved.kind !== 'school-signup') {
    throw new HttpError(404, 'invalid signup link');
  }
  const cfg = await repo.getTenantConfig(resolved.tenant);
  if (!cfg || cfg.schoolSignupLink?.token !== token) {
    throw new HttpError(404, 'invalid signup link');
  }
  return cfg;
}

/** Validate a school signup link → org name + the district choices for the form. */
app.get('/school-signup', async (c) => {
  const cfg = await resolveSignupTenant(c.req.query('t'));
  return c.json({
    tenant: cfg.tenant,
    // Same fallback chain as tenantOrgName, inlined — resolveSignupTenant already
    // fetched this config; no second read per link validation.
    orgName: cfg.branding?.name || cfg.branding?.title || cfg.tenant,
    provinces: [...PROVINCES],
  });
});

/**
 * School self-registration: one POST creates the school AND the rep's login account
 * (they then sign in via the normal email OTP). The unguessable, admin-revocable
 * token is the primary abuse gate; the hourly cap on the token item is a cheap
 * backstop for a leaked link. Validation (and the name/slug pre-check) runs
 * BEFORE ensurePasswordlessUser so junk-name spam never mints Cognito accounts.
 */
app.post('/school-signup', async (c) => {
  const token = c.req.query('t');
  const cfg = await resolveSignupTenant(token);
  const tenant = cfg.tenant;

  const body = await c.req
    .json<{
      schoolName?: string;
      province?: string;
      repName?: string;
      repEmail?: string;
      repCell?: string;
      consent?: boolean;
    }>()
    .catch(() => null);
  if (!body) throw new HttpError(400, 'invalid request body');
  const schoolName = (body.schoolName ?? '').trim();
  const repName = (body.repName ?? '').trim();
  const repCell = (body.repCell ?? '').trim();
  const province = body.province ?? '';
  const email = (body.repEmail ?? '').trim().toLowerCase();
  if (!schoolName || !province || !repName || !email) {
    throw new HttpError(400, 'schoolName, province, repName and repEmail are required');
  }
  if (body.consent !== true) throw new HttpError(400, 'consent required (POPIA)');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'valid repEmail required');
  if (!PROVINCES.has(province)) throw new HttpError(400, `unknown province: ${province}`);
  if (schoolName.length > SIGNUP_NAME_MAX || repName.length > SIGNUP_NAME_MAX) {
    throw new HttpError(400, `names must be ${SIGNUP_NAME_MAX} characters or fewer`);
  }
  if (repCell.length > SIGNUP_CELL_MAX) throw new HttpError(400, 'repCell too long');
  // Optional field, but a present cell must normalize: the stored chair cell feeds
  // WhatsApp sends and the admin contact modal, which expect the 0XXXXXXXXX form.
  const repCellNorm = repCell ? normalizeZaCell(repCell) : undefined;
  if (repCell && !repCellNorm) {
    throw new HttpError(400, 'repCell must be a valid South African cell number');
  }
  // The slug becomes the school id; a name like "!!!" slugs to '' and must not fall
  // through to buildSchoolFromSpec's defaults (public input never gets fallbacks).
  const slug = schoolIdFromName(schoolName);
  if (!slug) throw new HttpError(400, 'school name must contain letters or numbers');

  const allowed = await repo.bumpSignupTokenCounter(token!, now(), SIGNUPS_PER_HOUR);
  if (!allowed) throw new HttpError(429, 'too many signups — please try again later');

  // Name AND slug collision pre-check: "Kingsmead-CC" vs "Kingsmead CC" differ as
  // names but collide on id, so a name check alone would die on createSchool's guard.
  const existing = await repo.listSchools(tenant);
  const nameKey = schoolName.toLowerCase();
  const colliding = existing.find(
    (cl) => cl.id === slug || cl.name.trim().toLowerCase() === nameKey,
  );
  if (colliding) return signupReplayOr409(c, tenant, colliding, email);

  const sub = await ensurePasswordlessUser(cognito, USER_POOL_ID, email);
  const school = buildSchoolFromSpec({
    name: schoolName,
    province,
    contact: { name: repName, role: 'Sport Director' },
    contactEmail: email,
    contactCell: repCellNorm ?? undefined,
  });
  school.addedVia = 'self-signup';
  school.signupConsentAt = now();
  school.changedBy = email;
  try {
    await repo.createSchool(tenant, school);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // A concurrent signup won the id between our pre-check and this put — re-run
      // the replay heuristic against the school that actually landed at that id.
      const winner = await repo.getSchool(tenant, school.id);
      if (winner) return signupReplayOr409(c, tenant, winner, email);
      throw err;
    }
    throw err;
  }
  await ensureSignupMembership(tenant, sub, email, school.id);
  return c.json({ schoolId: school.id, schoolName: school.name, email }, 201);
});

/**
 * Replay vs name-taken. A resubmit by the SAME chair (the colliding school's
 * contact.email matches the submitted email) is a replay of their own signup —
 * return 200 with the existing schoolId and re-ensure the membership idempotently,
 * so a lost-response retry converges instead of erroring. Anyone else gets a 409
 * carrying `code: 'name_taken'`, which the SPA branches on to show "choose a
 * different name" inline (never the sign-in route). The chair-email oracle this
 * implies is mild, token-gated, and accepted.
 */
async function signupReplayOr409(
  c: Context<HonoEnv>,
  tenant: string,
  school: School,
  email: string,
): Promise<Response> {
  const contactEmail = (school.contact?.email ?? '').trim().toLowerCase();
  if (contactEmail && contactEmail === email) {
    const sub = await ensurePasswordlessUser(cognito, USER_POOL_ID, email);
    await ensureSignupMembership(tenant, sub, email, school.id);
    return c.json({ schoolId: school.id, replayed: true });
  }
  return c.json(
    {
      error: 'a school with that name is already registered — choose a different name',
      code: 'name_taken',
    },
    409,
  );
}

/**
 * Idempotently ensure the signing-up rep can see their school: an existing admin
 * membership in the tenant is left untouched (admins see every school), an existing
 * rep membership gains the schoolId only if absent, and a brand-new user gets a rep
 * membership stamped 'self-signup'. Filter-then-reattach so memberships in OTHER
 * tenants are preserved (same rule as the admin user-management routes).
 *
 * Read-modify-write with no version guard, like those admin routes: two
 * concurrent signups by one email (or a racing Team & Access edit) can drop a
 * schoolIds append. Accepted — the loser's rep just resubmits and the replay path
 * re-ensures the membership.
 */
async function ensureSignupMembership(
  tenant: string,
  sub: string,
  email: string,
  schoolId: string,
): Promise<void> {
  const existing = await repo.getUser(sub);
  const current = existing?.memberships.find((m) => m.tenantId === tenant);
  if (current?.role === 'admin') return;
  if (current?.schoolIds.includes(schoolId)) return;
  const others = (existing?.memberships ?? []).filter((m) => m.tenantId !== tenant);
  const membership: Membership = current
    ? { ...current, schoolIds: [...current.schoolIds, schoolId] }
    : {
        tenantId: tenant,
        role: 'rep',
        schoolIds: [schoolId],
        invitedAt: now(),
        invitedBy: 'self-signup',
      };
  const next: UserProfile = {
    sub,
    email: existing?.email ?? email,
    memberships: [...others, membership],
    onboardingSeen: existing?.onboardingSeen ?? {},
    ...(existing?.lastLoginAt ? { lastLoginAt: existing.lastLoginAt } : {}),
  };
  await writeUserGuarded(tenant, next, 0);
}

function computeIsMinor(dob: string): boolean {
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return false;
  const eighteen = new Date(born);
  eighteen.setFullYear(eighteen.getFullYear() + 18);
  return eighteen.getTime() > Date.now();
}

/**
 * Idempotent dedup key for a person within a school. SHARED by the public-link path
 * and the in-portal chair form so the same person can't be registered twice (once
 * per path). Keys on email/cell/name-dob — NOT idNumber (the public path has no
 * idNumber, so an idNumber-based key would let both paths create distinct rows).
 */
function playerNaturalKey(body: Partial<PlayerRegistration>): string {
  return (body.email || body.cell || `${body.firstName}-${body.lastName}-${body.dob}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
}

/**
 * Derive an ISO date of birth from a 13-digit RSA ID (YYMMDD…). The century digit is
 * absent, so we pivot year-relative (not on a frozen constant): assume the 2000s, and
 * fall back to the 1900s only if that lands in the future. This self-updates each year,
 * so it never silently rots. Returns null if the digits don't form a real date.
 */
function dobFromSaId(idNumber: string): string | null {
  if (!/^\d{13}$/.test(idNumber)) return null;
  const yy = Number(idNumber.slice(0, 2));
  const mm = Number(idNumber.slice(2, 4));
  const dd = Number(idNumber.slice(4, 6));
  const currentYear = new Date().getFullYear();
  const year = 2000 + yy <= currentYear ? 2000 + yy : 1900 + yy;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const iso = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getTime() > Date.now()) return null;
  // Guard against rollover (e.g. 0230 → Mar 02): the parsed date must match the inputs.
  if (d.getUTCMonth() + 1 !== mm || d.getUTCDate() !== dd) return null;
  return iso;
}

// ───────────── Mentor plan completion (public, token-gated) ─────────────
//
// An external mentor opens a link they received by email and completes the plan
// for one athlete. Like /register, the token self-describes its tenant and the
// check-in it completes, so nothing is inferred from the request and no login is
// needed. These routes sit before the auth guards below.

async function resolveMentorPlan(id: string, token: string | undefined) {
  if (!token) throw new HttpError(400, 'missing token');
  const resolved = await repo.getToken(token);
  if (!resolved || resolved.kind !== 'mentor-plan' || resolved.checkInId !== id) {
    throw new HttpError(404, 'this link is not valid');
  }
  const checkIn = await repo.getCheckIn(resolved.tenant, id);
  if (!checkIn) throw new HttpError(404, 'this plan no longer exists');
  return { tenant: resolved.tenant, checkIn };
}

app.get('/mentor-plan/:id', async (c) => {
  const { tenant, checkIn } = await resolveMentorPlan(c.req.param('id'), c.req.query('t'));
  // A little athlete context for the mentor (faculty/degree), resolved by student
  // number; only this athlete's fields are returned, never the rest of the roster.
  const athlete = (await repo.listAthletes(tenant)).find(
    (a) => a.studentNumber === checkIn.studentNumber,
  );
  return c.json({
    athleteName: checkIn.athleteName,
    studentNumber: checkIn.studentNumber,
    faculty: athlete?.faculty,
    degree: athlete?.degree,
    squad: athlete?.squad,
    period: checkIn.period,
    mentor: checkIn.mentor,
    scheduledNext: checkIn.scheduledNext,
    planStatus: checkIn.planStatus,
    completedAt: checkIn.completedAt,
    modules: checkIn.modules ?? [],
    sections: checkIn.sections ?? {},
    plan: checkIn.plan ?? [],
    note: checkIn.note,
  });
});

app.post('/mentor-plan/:id', async (c) => {
  const { tenant, checkIn } = await resolveMentorPlan(c.req.param('id'), c.req.query('t'));
  const body = await c.req.json<Partial<AcademicCheckIn>>();
  const invalid = validateCheckIn({ ...body, kind: 'adp', studentNumber: checkIn.studentNumber });
  if (invalid) throw new HttpError(400, invalid);
  const updated: AcademicCheckIn = {
    ...checkIn,
    modules: body.modules ?? checkIn.modules,
    sections: body.sections ?? checkIn.sections,
    plan: body.plan ?? checkIn.plan,
    note: body.note ?? checkIn.note,
    scheduledNext: body.scheduledNext ?? checkIn.scheduledNext,
    followUpRequired: body.followUpRequired ?? checkIn.followUpRequired,
    planStatus: 'completed',
    completedAt: now(),
    date: today(),
    version: (checkIn.version ?? 1) + 1,
  };
  await repo.putCheckIn(tenant, updated);
  // Mirror the admin flow: each planned intervention lands in the register.
  for (const item of body.plan ?? []) {
    try {
      await repo.putIntervention(tenant, {
        id: `int-${randomUUID().slice(0, 8)}`,
        studentNumber: checkIn.studentNumber,
        athleteName: checkIn.athleteName,
        date: today(),
        concern: `${item.type ?? 'intervention'}${item.module ? ` · ${item.module}` : ''}${checkIn.period ? ` · ${checkIn.period}` : ''}`,
        actionTaken: item.type,
        referredTo: item.referredTo,
        followUpDate: item.dueDate,
        status: 'open',
        raisedBy: checkIn.mentorEmail ?? checkIn.mentor ?? 'mentor-link',
        createdAt: now(),
        version: 1,
      });
    } catch {
      /* best-effort logging */
    }
  }
  return c.json({ ok: true, athleteName: checkIn.athleteName });
});

// ───────────────────── Authenticated routes ─────────────────────

app.use('/me', authenticate);
app.get('/me', async (c) => {
  const auth = c.get('auth')!;
  const user = await repo.getUser(auth.sub);
  return c.json(
    user ?? { sub: auth.sub, email: auth.email, memberships: auth.memberships, onboardingSeen: {} },
  );
});
app.patch('/me', async (c) => {
  const auth = c.get('auth')!;
  const body = await c.req.json<{ onboardingSeen?: Record<string, boolean> }>();
  const existing = await repo.getUser(auth.sub);
  const user = existing ?? {
    sub: auth.sub,
    email: auth.email,
    memberships: auth.memberships,
    onboardingSeen: {},
  };
  user.onboardingSeen = { ...user.onboardingSeen, ...(body.onboardingSeen ?? {}) };
  await repo.putUser(user);
  return c.json(user);
});

// All /schools, /tournaments, /tenant/config, /admin routes require a tenant membership.
app.use('/schools/*', authenticate, requireTenantMembership);
app.use('/schools', authenticate, requireTenantMembership);
app.use('/tournaments/*', authenticate, requireTenantMembership);
app.use('/tournaments', authenticate, requireTenantMembership);
app.use('/tenant/config', authenticate, requireTenantMembership);
app.use('/tenant/support', authenticate, requireTenantMembership);
app.use('/admin/*', authenticate, requireTenantMembership, requireAdmin);
// ───────────────────────── Schools (visiting-school directory) ─────────────────────────

/** The full directory (organisers only). */
app.get('/schools', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  return c.json(await repo.listSchools(tenant));
});

/**
 * Lightweight directory for reps — {id, name, town, province} only. A visiting
 * school's rep needs to see who else is coming (fixtures name opponents), but must
 * NOT see the full record: contact details, organiser notes and the comm log are
 * the host's. Admin-only `GET /schools` returns everything; this is the rep-safe
 * projection. Registered before `/schools/:id` so the static path wins.
 */
app.get('/schools/directory', async (c) => {
  const ra = c.get('requestAuth')!;
  const schools = await repo.listSchools(ra.tenant);
  return c.json(
    schools.map((s) => ({
      id: s.id,
      name: s.name,
      shortName: s.shortName,
      town: s.town,
      province: s.province,
    })),
  );
});

app.get('/schools/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  assertSchoolAccess(ra, id);
  const school = await repo.getSchool(ra.tenant, id);
  if (!school) throw new HttpError(404, 'school not found');
  return c.json(school);
});

/** Add a school to the directory by hand (the organiser's own path). */
app.post('/schools', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  const spec = await c.req.json<SchoolSpec>();
  if (!spec.name?.trim()) throw new HttpError(400, 'name required');
  const invalid = validateSchoolPatch(spec);
  if (invalid) throw new HttpError(400, invalid);
  const school = buildSchoolFromSpec(spec);
  try {
    await repo.createSchool(ra.tenant, school);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new HttpError(409, 'a school with that name already exists');
    }
    throw err;
  }
  return c.json(school, 201);
});

/** Update a directory record (contact, location, type). */
app.patch('/schools/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  assertSchoolAccess(ra, id);
  const patch = await c.req.json<Partial<School>>();
  const current = await repo.getSchool(ra.tenant, id);
  if (!current) throw new HttpError(404, 'school not found');
  const invalid = validateSchoolPatch(patch);
  if (invalid) throw new HttpError(400, invalid);
  // The comm log and organiser notes are append-only through their own routes;
  // a generic patch carrying them would let a rep rewrite the host's audit trail.
  for (const field of ['commLog', 'notes', 'entryCount'] as const) {
    delete (patch as Record<string, unknown>)[field];
  }
  try {
    const updated = await repo.updateSchool(ra.tenant, id, patch, ra.email, now());
    return c.json(updated);
  } catch (err) {
    if (err instanceof VersionConflictError) throw new HttpError(409, 'school changed; refetch');
    throw err;
  }
});

/** Every tournament this school has entered (its own portal home). */
app.get('/schools/:id/entries', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  assertSchoolAccess(ra, id);
  const mirrors = await repo.listSchoolEntries(ra.tenant, id);
  // The mirrors carry only the pointer; hydrate from the canonical items so the
  // portal shows real status, pool and squad counts.
  const entries = await Promise.all(
    mirrors.map((m) => repo.getEntry(ra.tenant, m.tournamentId, id)),
  );
  return c.json(entries.filter(Boolean).map((e) => withPlayerCount(e!)));
});

/**
 * DELETE /schools/:id — admin-only school deletion (junk/abandoned signups, POPIA
 * erasure of the school's player data).
 *
 * The membership sweep runs BEFORE the data cascade so a crash leaves the school
 * intact and re-deletable (the sweep itself is idempotent), never a half-erased
 * school whose reps still hold access. It's a bounded N+1 over the tenant roster
 * (team-sized, same shape as GET /admin/users) because the markers don't carry
 * schoolIds. Only rep memberships can reference a school (admins force schoolIds: []),
 * so the last-admin guard never applies here. Re-delete (or unknown id) is a 404.
 */
app.delete('/schools/:id', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const school = await repo.getSchool(ra.tenant, id);
  if (!school) throw new HttpError(404, 'school not found');

  let users = 0;
  for (const entry of await repo.listTenantUsers(ra.tenant)) {
    const profile = await repo.getUser(entry.sub);
    const membership = profile?.memberships.find((m) => m.tenantId === ra.tenant);
    if (!profile || !membership || membership.role !== 'rep') continue;
    if (!membership.schoolIds.includes(id)) continue;
    users++;

    const schoolIds = membership.schoolIds.filter((cid) => cid !== id);
    const others = profile.memberships.filter((m) => m.tenantId !== ra.tenant);
    if (schoolIds.length > 0) {
      // Mere rescope: the rep keeps other schools in this tenant. No sign-out — same as
      // a PATCH /admin/users scope edit (narrowing schoolIds isn't a role change; the
      // next token refresh picks it up).
      await repo.putUser({ ...profile, memberships: [...others, { ...membership, schoolIds }] });
      continue;
    }
    // Empty schoolIds would violate the rep-≥1-school invariant — the membership goes.
    if (others.length === 0) {
      // Full offboard: same pieces as DELETE /admin/users/:sub. The sign-out AFTER the
      // Cognito delete is a guaranteed swallowed UserNotFoundException — kept in that
      // order so the refresh-token revoke still runs when the (best-effort, logged-not-
      // thrown) delete itself failed and the account survived.
      await repo.deleteUser(entry.sub);
      await adminDeleteCognitoUser(cognito, USER_POOL_ID, profile.email);
      await adminGlobalSignOut(cognito, USER_POOL_ID, profile.email);
    } else {
      // Memberships in OTHER tenants remain: keep the account, drop this tenant's
      // membership, and revoke refresh tokens so the removed access can't be re-minted.
      await repo.putUser({ ...profile, memberships: others });
      await adminGlobalSignOut(cognito, USER_POOL_ID, profile.email);
    }
  }

  const removed = await repo.eraseSchoolData(ra.tenant, school);
  return c.json({ ok: true, removed: { ...removed, users } });
}); /** Append a note to the school's communication log (admin only) — audited. */
app.post('/schools/:id/notes', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const { text } = await c.req.json<{ text?: string }>();
  if (!text || !text.trim()) throw new HttpError(400, 'note text required');
  const note = { id: randomUUID(), text: text.trim(), author: ra.email, at: now() };
  try {
    // appendSchoolNote's ConditionExpression (attribute_exists) is the existence
    // check — no separate read, so there's no delete-race window.
    const updated = await repo.appendSchoolNote(ra.tenant, id, note);
    return c.json(updated);
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException')
      throw new HttpError(404, 'school not found');
    throw err;
  }
});
// ───────────────────────── Tournaments ─────────────────────────

app.get('/tournaments', async (c) => {
  const ra = c.get('requestAuth')!;
  const tournaments = await repo.listTournaments(ra.tenant);
  // Reps see only what has been released to them: a draft or unreleased draw is
  // the organiser's working copy, not something an entrant should be planning around.
  if (ra.membership.role === 'admin') return c.json(tournaments);
  return c.json(tournaments.filter((t) => t.status !== 'draft').map(publicTournamentView));
});

app.get('/tournaments/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  const t = await repo.getTournament(ra.tenant, c.req.param('id'));
  if (!t) throw new HttpError(404, 'tournament not found');
  if (ra.membership.role === 'admin') return c.json(t);
  if (t.status === 'draft') throw new HttpError(404, 'tournament not found');
  return c.json(publicTournamentView(t));
});

app.post('/tournaments', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  const body = await c.req.json<Partial<Tournament>>();
  if (!body.name?.trim()) throw new HttpError(400, 'name required');
  if (!body.sport || !SPORT_KEYS.has(body.sport)) throw new HttpError(400, 'valid sport required');
  const invalid = validateTournamentPatch(body);
  if (invalid) throw new HttpError(400, invalid);
  const id = body.id ?? `${slugify(body.name)}-${randomUUID().slice(0, 6)}`;
  const tournament: Tournament = {
    id,
    name: body.name.trim(),
    sport: body.sport,
    season: body.season ?? String(new Date().getUTCFullYear()),
    section: body.section,
    ageGroup: body.ageGroup,
    // A meet has no bracket; forcing the format here keeps a mis-set draw
    // impossible rather than merely discouraged.
    format: MEET_SPORTS.has(body.sport) ? 'meet' : (body.format ?? 'pool_playoff'),
    poolCount: body.poolCount ?? 2,
    startDate: body.startDate ?? '',
    endDate: body.endDate,
    entryDeadline: body.entryDeadline,
    entryFee: body.entryFee ?? 0,
    maxEntrants: body.maxEntrants ?? 8,
    venues: body.venues ?? [],
    entryDocs: body.entryDocs ?? [],
    matchConfig: body.matchConfig ?? {},
    points: body.points,
    tiebreakers: body.tiebreakers,
    status: body.status ?? 'draft',
    fixtures: [],
    released: false,
    releasedAt: null,
    resultsReleased: false,
    entryCount: 0,
    version: 1,
    changedBy: ra.email,
    changedAt: now(),
  };
  await repo.putTournament(ra.tenant, tournament);
  return c.json(tournament, 201);
});

app.patch('/tournaments/:id', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const patch = await c.req.json<Partial<Tournament>>();
  const invalid = validateTournamentPatch(patch);
  if (invalid) throw new HttpError(400, invalid);
  // Fixtures move only through the draw and result routes, which apply their own
  // guards; letting a generic PATCH carry them would bypass both.
  delete (patch as { fixtures?: unknown }).fixtures;
  if (patch.released === true && !patch.releasedAt) patch.releasedAt = now();
  try {
    const updated = await repo.updateTournament(ra.tenant, id, {
      ...patch,
      changedBy: ra.email,
      changedAt: now(),
    });
    return c.json(updated);
  } catch (err) {
    if (err instanceof VersionConflictError) {
      throw new HttpError(409, 'tournament changed; refetch');
    }
    if ((err as Error).message === 'tournament not found') {
      throw new HttpError(404, 'tournament not found');
    }
    throw err;
  }
});

/** Delete a tournament and cascade its entries, squads and uploaded packs. */
app.delete('/tournaments/:id', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const t = await repo.getTournament(ra.tenant, id);
  if (!t) return c.json({ ok: true, entries: 0, players: 0 });
  const res = await repo.eraseTournamentData(ra.tenant, id);
  return c.json({ ok: true, ...res });
});

/** Copy a tournament's setup for next season — config only, never entries or results. */
app.post('/tournaments/:id/duplicate', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  const source = await repo.getTournament(ra.tenant, c.req.param('id'));
  if (!source) throw new HttpError(404, 'tournament not found');
  const body = await c.req
    .json<{ name?: string; startDate?: string }>()
    .catch(() => ({}) as { name?: string; startDate?: string });
  const name = body.name?.trim() || `${source.name} (copy)`;
  const copy: Tournament = {
    ...source,
    id: `${slugify(name)}-${randomUUID().slice(0, 6)}`,
    name,
    startDate: body.startDate ?? source.startDate,
    status: 'draft',
    fixtures: [],
    released: false,
    releasedAt: null,
    resultsReleased: false,
    entryCount: 0,
    version: 1,
    changedBy: ra.email,
    changedAt: now(),
  };
  await repo.putTournament(ra.tenant, copy);
  return c.json(copy, 201);
});

// ───────────────────────── Draws & results ─────────────────────────

/**
 * Store a generated draw. The draw itself is computed in the browser (ADR 0004) —
 * this route validates that what came back is internally consistent before it
 * becomes the schedule everyone plans around.
 */
app.put('/tournaments/:id/draw', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const tournament = await repo.getTournament(ra.tenant, id);
  if (!tournament) throw new HttpError(404, 'tournament not found');
  if (MEET_SPORTS.has(tournament.sport)) {
    throw new HttpError(400, 'a meet has no fixture draw');
  }
  const body = await c.req.json<{ fixtures?: Fixture[]; version?: number }>();
  const fixtures = body.fixtures ?? [];
  if (!Array.isArray(fixtures)) throw new HttpError(400, 'fixtures must be an array');

  const ids = new Set<string>();
  for (const f of fixtures) {
    if (!f.id) throw new HttpError(400, 'every fixture needs an id');
    if (ids.has(f.id)) throw new HttpError(400, `duplicate fixture id: ${f.id}`);
    ids.add(f.id);
    if (f.home && f.away && f.home === f.away) {
      throw new HttpError(400, `fixture ${f.id} has the same team on both sides`);
    }
  }

  // Regenerating wipes captured scores, so refuse once results exist unless the
  // organiser explicitly confirms — losing a morning's results to a stray click
  // is not a recoverable mistake.
  const hasResults = (tournament.fixtures ?? []).some((f) => f.result);
  const confirmed = c.req.query('force') === '1';
  if (hasResults && !confirmed) {
    throw new HttpError(409, 'results already captured; regenerating discards them');
  }

  try {
    const updated = await repo.updateTournament(ra.tenant, id, {
      fixtures,
      version: body.version,
      changedBy: ra.email,
      changedAt: now(),
    });
    return c.json(updated);
  } catch (err) {
    if (err instanceof VersionConflictError) {
      throw new HttpError(409, 'tournament changed; refetch');
    }
    throw err;
  }
});

/**
 * Capture one fixture's result. Uses the repo's targeted list-element update, so
 * scorers on different fields don't collide with each other.
 */
app.post('/tournaments/:id/fixtures/:fid/result', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const fid = c.req.param('fid');
  const tournament = await repo.getTournament(ra.tenant, id);
  if (!tournament) throw new HttpError(404, 'tournament not found');
  const fixture = (tournament.fixtures ?? []).find((f) => f.id === fid);
  if (!fixture) throw new HttpError(404, 'fixture not found');
  // Only the host's organisers score. A visiting school confirming its own result
  // would be marking its own homework.
  if (ra.membership.role !== 'admin')
    throw new HttpError(403, 'only organisers may capture results');

  const body = await c.req.json<Record<string, unknown>>();
  const invalid = validateResult(body, fixture);
  if (invalid) throw new HttpError(400, invalid);

  try {
    const updated = await repo.captureFixtureResult(ra.tenant, id, fid, {
      ...body,
      capturedAt: now(),
      capturedBy: ra.email,
    });
    return c.json(updated);
  } catch (err) {
    if (err instanceof VersionConflictError) {
      throw new HttpError(409, 'the draw changed; refetch and re-capture');
    }
    throw err;
  }
});

/** Clear a mis-keyed result. */
app.delete('/tournaments/:id/fixtures/:fid/result', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  try {
    const updated = await repo.clearFixtureResult(ra.tenant, c.req.param('id'), c.req.param('fid'));
    return c.json(updated);
  } catch (err) {
    if (err instanceof VersionConflictError) {
      throw new HttpError(409, 'the draw changed; refetch');
    }
    if ((err as Error).message === 'fixture not found') {
      throw new HttpError(404, 'fixture not found');
    }
    throw err;
  }
});

// ───────────────────────── Entries ─────────────────────────

/** Every entry for a tournament (organiser), or just the rep's own. */
app.get('/tournaments/:tid/entries', async (c) => {
  const ra = c.get('requestAuth')!;
  const tid = c.req.param('tid');
  const entries = await repo.listEntries(ra.tenant, tid);
  const visible =
    ra.membership.role === 'admin'
      ? entries
      : entries.filter((e) => ra.membership.schoolIds.includes(e.schoolId));
  return c.json(visible.map(withPlayerCount));
});

/** Lodge an entry. A rep may only enter their own school; an organiser may enter any. */
app.post('/tournaments/:tid/entries', async (c) => {
  const ra = c.get('requestAuth')!;
  const tid = c.req.param('tid');
  const body = await c.req.json<Partial<Entry>>();
  const schoolId = body.schoolId;
  if (!schoolId) throw new HttpError(400, 'schoolId required');
  assertSchoolAccess(ra, schoolId);

  const [tournament, school] = await Promise.all([
    repo.getTournament(ra.tenant, tid),
    repo.getSchool(ra.tenant, schoolId),
  ]);
  if (!tournament) throw new HttpError(404, 'tournament not found');
  if (!school) throw new HttpError(404, 'school not found');

  // Entry-window rules bind visiting schools, not the organiser — the host
  // routinely adds a late entry by hand after the deadline.
  if (ra.membership.role !== 'admin') {
    if (tournament.status !== 'open') throw new HttpError(409, 'entries are not open');
    if (tournament.entryDeadline && tournament.entryDeadline < today()) {
      throw new HttpError(409, 'the entry deadline has passed');
    }
  }

  const entry: Entry = {
    tournamentId: tid,
    schoolId,
    schoolName: school.name,
    teamName: body.teamName?.trim() || school.name,
    status: 'pending',
    pool: null,
    seed: null,
    docs: {},
    docMeta: {},
    playerCount: 0,
    contact: body.contact ?? school.contact,
    logistics: body.logistics,
    entryFeePaid: false,
    submittedAt: body.submittedAt,
    createdAt: now(),
    version: 1,
    changedBy: ra.email,
    changedAt: now(),
  };
  const invalid = validateEntryPatch(entry, DOC_KEYS);
  if (invalid) throw new HttpError(400, invalid);

  try {
    const created = await repo.createEntry(ra.tenant, entry);
    return c.json(withPlayerCount(created), 201);
  } catch (err) {
    if (err instanceof repo.DuplicateEntryError) {
      throw new HttpError(409, 'this school has already entered this tournament');
    }
    throw err;
  }
});

app.get('/tournaments/:tid/entries/:sid', async (c) => {
  const ra = c.get('requestAuth')!;
  assertSchoolAccess(ra, c.req.param('sid'));
  const entry = await repo.getEntry(ra.tenant, c.req.param('tid'), c.req.param('sid'));
  if (!entry) throw new HttpError(404, 'entry not found');
  return c.json(withPlayerCount(entry));
});

/**
 * Update an entry. A rep may edit its own logistics, contact and team name; the
 * decision fields (status, pool, seed, fee) are the organiser's alone — otherwise
 * a school could accept itself into a full tournament.
 */
app.patch('/tournaments/:tid/entries/:sid', async (c) => {
  const ra = c.get('requestAuth')!;
  const tid = c.req.param('tid');
  const sid = c.req.param('sid');
  assertSchoolAccess(ra, sid);
  const patch = await c.req.json<Partial<Entry>>();

  if (ra.membership.role !== 'admin') {
    for (const field of [
      'status',
      'pool',
      'seed',
      'entryFeePaid',
      'paidAt',
      'decidedAt',
      'decidedBy',
    ] as const) {
      if (field in patch) throw new HttpError(403, `only organisers may set "${field}"`);
    }
  }

  const current = await repo.getEntry(ra.tenant, tid, sid);
  if (!current) throw new HttpError(404, 'entry not found');
  const validDocKeys = new Set([...DOC_KEYS, ...Object.keys(current.docMeta ?? {})]);
  const invalid = validateEntryPatch(patch, validDocKeys);
  if (invalid) throw new HttpError(400, invalid);
  if (patch.docMeta) assertDocMetaObjectKeys(ra.tenant, tid, sid, patch.docMeta);

  return c.json(withPlayerCount(await applyEntryPatch(ra.tenant, tid, sid, patch, ra.email)));
});

/**
 * Accept / decline / waitlist an entry. Separate from PATCH so the decision
 * carries an audit stamp and the capacity check can't be sidestepped by a
 * hand-rolled status patch.
 */
app.post('/tournaments/:tid/entries/:sid/decision', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  const tid = c.req.param('tid');
  const sid = c.req.param('sid');
  const { status, reason } = await c.req.json<{ status?: string; reason?: string }>();
  if (!status || !['accepted', 'declined', 'waitlisted', 'withdrawn'].includes(status)) {
    throw new HttpError(400, 'status must be accepted, declined, waitlisted or withdrawn');
  }
  const [tournament, entry] = await Promise.all([
    repo.getTournament(ra.tenant, tid),
    repo.getEntry(ra.tenant, tid, sid),
  ]);
  if (!tournament) throw new HttpError(404, 'tournament not found');
  if (!entry) throw new HttpError(404, 'entry not found');

  // Capacity is enforced on the way IN only, and only when it's actually a new
  // acceptance — re-confirming an already-accepted entry must stay idempotent.
  if (status === 'accepted' && entry.status !== 'accepted' && tournament.maxEntrants) {
    const accepted = (await repo.listEntries(ra.tenant, tid)).filter(
      (e) => e.status === 'accepted',
    ).length;
    if (accepted >= tournament.maxEntrants) {
      throw new HttpError(409, `tournament is full (${tournament.maxEntrants} teams)`);
    }
  }

  const updated = await applyEntryPatch(
    ra.tenant,
    tid,
    sid,
    {
      status: status as Entry['status'],
      declineReason: status === 'declined' ? reason : undefined,
      decidedAt: now(),
      decidedBy: ra.email,
    },
    ra.email,
  );
  return c.json(withPlayerCount(updated));
});

/** Remove an entry and cascade its squad + uploaded pack. */
app.delete('/tournaments/:tid/entries/:sid', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  const entry = await repo.getEntry(ra.tenant, c.req.param('tid'), c.req.param('sid'));
  if (!entry) return c.json({ ok: true, players: 0 });
  const res = await repo.eraseEntryData(ra.tenant, entry);
  return c.json({ ok: true, ...res });
});

/**
 * Mint (or rotate) the squad-registration link for an entry. Rotating deletes the
 * previous token, so a link that has leaked stops working the moment it's replaced.
 */
app.post('/tournaments/:tid/entries/:sid/squad-link', async (c) => {
  const ra = c.get('requestAuth')!;
  const tid = c.req.param('tid');
  const sid = c.req.param('sid');
  assertSchoolAccess(ra, sid);
  const entry = await repo.getEntry(ra.tenant, tid, sid);
  if (!entry) throw new HttpError(404, 'entry not found');
  if (entry.squadRegLink?.token) await repo.deleteToken(entry.squadRegLink.token);
  const token = randomUUID();
  await repo.putToken(token, { tenant: ra.tenant, tournamentId: tid, schoolId: sid });
  const squadRegLink = { token, createdAt: now() };
  await applyEntryPatch(ra.tenant, tid, sid, { squadRegLink }, ra.email);
  return c.json({ squadRegLink });
});

// ───────────────────── Entry-pack documents ─────────────────────

app.post('/tournaments/:tid/entries/:sid/docs/:key/upload-url', async (c) => {
  const ra = c.get('requestAuth')!;
  const tid = c.req.param('tid');
  const sid = c.req.param('sid');
  const key = c.req.param('key');
  assertDocKey(key);
  assertSchoolAccess(ra, sid);
  // PDF and Word are accepted (Google Docs exports as .docx/.pdf). A MISSING
  // contentType falls back to PDF (legacy no-body clients); a present-but-unknown
  // one must 400 here — silently signing it as PDF would let the upload through
  // only for the record PATCH to reject it, orphaning the object in S3. The
  // presign locks the upload to the echoed type, so the client must PUT with
  // exactly this Content-Type.
  const { contentType } = await c.req
    .json<{ contentType?: string }>()
    .catch(() => ({ contentType: undefined }));
  if (contentType !== undefined && !DOC_CONTENT_TYPES[contentType]) {
    throw new HttpError(400, 'contentType must be PDF or Word');
  }
  const ct = contentType ?? 'application/pdf';
  const objectKey = `${entryPrefix(ra.tenant, tid, sid)}${key}-${randomUUID()}.${DOC_CONTENT_TYPES[ct]}`;
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: UPLOADS_BUCKET, Key: objectKey, ContentType: ct }),
    { expiresIn: 300 },
  );
  return c.json({ uploadUrl: url, objectKey, contentType: ct });
});

/** Record an uploaded document against the entry. */
app.patch('/tournaments/:tid/entries/:sid/docs/:key', async (c) => {
  const ra = c.get('requestAuth')!;
  const tid = c.req.param('tid');
  const sid = c.req.param('sid');
  const key = c.req.param('key');
  assertDocKey(key);
  assertSchoolAccess(ra, sid);
  const meta = await c.req.json<{ objectKey: string; size: number; contentType?: string }>();
  if (!meta.objectKey) throw new HttpError(400, 'objectKey required');
  assertOwnObjectKey(ra.tenant, tid, sid, meta.objectKey);
  if (typeof meta.size !== 'number' || meta.size <= 0 || meta.size > MAX_DOC_BYTES) {
    throw new HttpError(400, 'file must be a non-empty PDF or Word document under 10 MB');
  }
  if (meta.contentType !== undefined && !DOC_CONTENT_TYPES[meta.contentType]) {
    throw new HttpError(400, 'contentType must be PDF or Word');
  }
  const current = await repo.getEntry(ra.tenant, tid, sid);
  if (!current) throw new HttpError(404, 'entry not found');
  const docMeta = current.docMeta ?? {};

  if (isMultiFileDoc(key)) {
    // Per-person documents (safeguarding certificates, medical consent forms)
    // APPEND — files coexist, and the doc only completes at its minimum.
    const norm = fileSetMeta(docMeta[key]);
    const exists = norm.files.some((f) => f.objectKey === meta.objectKey);
    if (!exists && norm.files.length >= MAX_DOC_FILES) {
      throw new HttpError(400, `no more than ${MAX_DOC_FILES} files for "${key}"`);
    }
    const files = exists
      ? norm.files
      : [
          ...norm.files,
          {
            objectKey: meta.objectKey,
            size: meta.size,
            contentType: meta.contentType,
            uploadedAt: now(),
          },
        ];
    const updated = await applyEntryPatch(
      ra.tenant,
      tid,
      sid,
      {
        docs: {
          ...current.docs,
          [key]: norm.markedCompliant || files.length >= minFilesFor(key),
        },
        docMeta: { ...docMeta, [key]: fileSetValue(files, norm.markedCompliant, norm.at) },
        // Append is read-modify-write: pin the version read above so a parallel
        // upload 409s (client retries) instead of silently dropping a file.
        version: current.version,
      },
      ra.email,
    );
    return c.json(withPlayerCount(updated));
  }

  // Replacing a wrongly-uploaded file: best-effort delete the previous S3 object so a
  // stale document (PII) isn't orphaned in the bucket (POPIA data-minimisation). A
  // failed delete must never fail the replace, and we skip non-S3 keys (local dev).
  const prev = docMeta[key] as { objectKey?: string } | undefined;
  const prevKey = prev?.objectKey;
  if (prevKey && prevKey !== meta.objectKey && !prevKey.startsWith('local/')) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: UPLOADS_BUCKET, Key: prevKey }));
    } catch (err) {
      // Orphaned object is recoverable via a bucket lifecycle rule; don't block the
      // replace. Log once so accumulation is observable rather than silent.
      console.warn(`docs replace: failed to delete prior object ${prevKey}`, err);
    }
  }
  const updated = await applyEntryPatch(
    ra.tenant,
    tid,
    sid,
    {
      docs: { ...current.docs, [key]: true },
      docMeta: { ...docMeta, [key]: { ...meta, uploadedAt: now() } },
    },
    ra.email,
  );
  return c.json(withPlayerCount(updated));
});

/**
 * Remove one file from a multi-file document. Recomputes the satisfied flag from
 * the remaining files; an organiser override keeps the doc satisfied regardless.
 */
app.delete('/tournaments/:tid/entries/:sid/docs/:key/file', async (c) => {
  const ra = c.get('requestAuth')!;
  const tid = c.req.param('tid');
  const sid = c.req.param('sid');
  const key = c.req.param('key');
  assertDocKey(key);
  assertSchoolAccess(ra, sid);
  if (!isMultiFileDoc(key)) throw new HttpError(400, `"${key}" is not a multi-file document`);
  const { objectKey } = await c.req.json<{ objectKey?: string }>();
  if (!objectKey) throw new HttpError(400, 'objectKey required');
  assertOwnObjectKey(ra.tenant, tid, sid, objectKey);

  const current = await repo.getEntry(ra.tenant, tid, sid);
  if (!current) throw new HttpError(404, 'entry not found');
  const docMeta = current.docMeta ?? {};
  const norm = fileSetMeta(docMeta[key]);
  const files = norm.files.filter((f) => f.objectKey !== objectKey);
  if (files.length === norm.files.length) throw new HttpError(404, 'file not on record');

  const updated = await applyEntryPatch(
    ra.tenant,
    tid,
    sid,
    {
      docs: {
        ...current.docs,
        [key]: norm.markedCompliant || files.length >= minFilesFor(key),
      },
      docMeta: { ...docMeta, [key]: fileSetValue(files, norm.markedCompliant, norm.at) },
      version: current.version,
    },
    ra.email,
  );
  // Record first, S3 second: an orphaned object is recoverable, a record pointing
  // at a deleted file is a broken preview for everyone.
  if (!objectKey.startsWith('local/')) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: UPLOADS_BUCKET, Key: objectKey }));
    } catch (err) {
      console.warn(`docs delete: failed to remove object ${objectKey}`, err);
    }
  }
  return c.json(withPlayerCount(updated));
});

/** Mint a short-lived GET url so the organiser can read a lodged document. */
app.post('/tournaments/:tid/entries/:sid/docs/:key/view-url', async (c) => {
  const ra = c.get('requestAuth')!;
  const tid = c.req.param('tid');
  const sid = c.req.param('sid');
  const key = c.req.param('key');
  assertDocKey(key);
  assertSchoolAccess(ra, sid);
  const entry = await repo.getEntry(ra.tenant, tid, sid);
  if (!entry) throw new HttpError(404, 'entry not found');
  const body = await c.req
    .json<{ objectKey?: string }>()
    .catch(() => ({}) as { objectKey?: string });
  const norm = fileSetMeta((entry.docMeta ?? {})[key]);
  // Presign only what is ON RECORD — never a client-supplied key. The record IS
  // the authorization: anything else would let a rep read an arbitrary object.
  const target = body.objectKey
    ? norm.files.find((f) => f.objectKey === body.objectKey)
    : norm.files[0];
  if (!target?.objectKey) throw new HttpError(404, 'no file on record');
  assertOwnObjectKey(ra.tenant, tid, sid, target.objectKey);
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: UPLOADS_BUCKET, Key: target.objectKey }),
    { expiresIn: 300 },
  );
  return c.json({ viewUrl: url, contentType: target.contentType });
});

// ───────────────────────── Squads ─────────────────────────

app.get('/tournaments/:tid/entries/:sid/players', async (c) => {
  const ra = c.get('requestAuth')!;
  assertSchoolAccess(ra, c.req.param('sid'));
  const players = await repo.listSquad(ra.tenant, c.req.param('tid'), c.req.param('sid'));
  return c.json(players);
});

/** Register a squad member from inside the portal (the authenticated path). */
app.post('/tournaments/:tid/entries/:sid/players', async (c) => {
  const ra = c.get('requestAuth')!;
  const tid = c.req.param('tid');
  const sid = c.req.param('sid');
  assertSchoolAccess(ra, sid);
  const [tournament, entry] = await Promise.all([
    repo.getTournament(ra.tenant, tid),
    repo.getEntry(ra.tenant, tid, sid),
  ]);
  if (!tournament) throw new HttpError(404, 'tournament not found');
  if (!entry) throw new HttpError(404, 'entry not found');

  const body = await c.req.json<Partial<PlayerRegistration>>();
  if (!body.firstName || !body.lastName)
    throw new HttpError(400, 'firstName and lastName required');
  const dob = body.dob || (body.idNumber ? dobFromSaId(body.idNumber) : '');
  if (!dob) throw new HttpError(400, 'dob or a valid SA ID number is required');
  const isMinor = computeIsMinor(dob);
  if (isMinor && !body.guardianName) {
    throw new HttpError(400, 'guardianName required for minors (POPIA)');
  }
  const limits = SQUAD_LIMITS_FOR(tournament.sport);
  if ((entry.playerCount ?? 0) >= limits.max) {
    throw new HttpError(409, `squad is full (maximum ${limits.max} players)`);
  }

  const player: PlayerRegistration = {
    naturalKey: playerNaturalKey({ ...body, dob }),
    tournamentId: tid,
    schoolId: sid,
    firstName: body.firstName,
    lastName: body.lastName,
    dob,
    idNumber: body.idNumber,
    cell: body.cell,
    email: body.email,
    gender: body.gender,
    isMinor,
    guardianName: body.guardianName,
    guardianCell: body.guardianCell,
    jerseyNumber: body.jerseyNumber,
    position: body.position,
    isCaptain: body.isCaptain,
    massKg: body.massKg,
    medicalNotes: body.medicalNotes,
    allergies: body.allergies,
    medicalAidNumber: body.medicalAidNumber,
    consentAt: now(),
    createdAt: now(),
    registeredBy: ra.email,
    registeredVia: 'portal',
    status: 'registered',
    version: 1,
  };
  try {
    await repo.createPlayer(ra.tenant, player);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new HttpError(409, 'this player is already in the squad');
    }
    throw err;
  }
  return c.json(player, 201);
});

app.patch('/tournaments/:tid/entries/:sid/players/:nk', async (c) => {
  const ra = c.get('requestAuth')!;
  const tid = c.req.param('tid');
  const sid = c.req.param('sid');
  assertSchoolAccess(ra, sid);
  const patch = await c.req.json<Partial<PlayerRegistration>>();
  // Identity keys are structural — changing one would silently create a second
  // person rather than edit this one.
  for (const field of ['naturalKey', 'tournamentId', 'schoolId'] as const) {
    delete (patch as Record<string, unknown>)[field];
  }
  try {
    const updated = await repo.updatePlayer(ra.tenant, tid, sid, c.req.param('nk'), patch);
    return c.json(updated);
  } catch (err) {
    if (err instanceof VersionConflictError) throw new HttpError(409, 'player changed; refetch');
    if ((err as Error).message === 'player not found') {
      throw new HttpError(404, 'player not found');
    }
    throw err;
  }
});

app.delete('/tournaments/:tid/entries/:sid/players/:nk', async (c) => {
  const ra = c.get('requestAuth')!;
  const tid = c.req.param('tid');
  const sid = c.req.param('sid');
  assertSchoolAccess(ra, sid);
  const player = await repo.getPlayer(ra.tenant, tid, sid, c.req.param('nk'));
  const removed = await repo.deletePlayer(ra.tenant, tid, sid, c.req.param('nk'));
  // Purge the ID/age document with the player — keeping a child's ID copy after
  // the record it belonged to is gone is exactly what POPIA forbids.
  const objectKey = player?.idDocMeta?.objectKey;
  if (removed && objectKey && !objectKey.startsWith('local/')) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: UPLOADS_BUCKET, Key: objectKey }));
    } catch (err) {
      console.warn(`player delete: failed to remove ID doc ${objectKey}`, err);
    }
  }
  return c.json({ ok: true, removed });
});

/**
 * Submit the squad for approval. This is where the sport's size bounds bite — a
 * squad is legitimately under-strength while it's being filled in, so the check
 * belongs here rather than on each registration.
 */
app.post('/tournaments/:tid/entries/:sid/squad/submit', async (c) => {
  const ra = c.get('requestAuth')!;
  const tid = c.req.param('tid');
  const sid = c.req.param('sid');
  assertSchoolAccess(ra, sid);
  const tournament = await repo.getTournament(ra.tenant, tid);
  if (!tournament) throw new HttpError(404, 'tournament not found');
  const squad = await repo.listSquad(ra.tenant, tid, sid);
  const active = squad.filter((p) => (p.status ?? 'registered') === 'registered');
  const invalid = validateSquadSize(tournament.sport, active.length);
  if (invalid) throw new HttpError(400, invalid);
  const updated = await applyEntryPatch(ra.tenant, tid, sid, { submittedAt: now() }, ra.email);
  return c.json(withPlayerCount(updated));
});

// ── Player ID / age documents ──

app.post('/tournaments/:tid/entries/:sid/players/:nk/id-doc/upload-url', async (c) => {
  const ra = c.get('requestAuth')!;
  const tid = c.req.param('tid');
  const sid = c.req.param('sid');
  const nk = c.req.param('nk');
  assertSchoolAccess(ra, sid);
  const { contentType } = await c.req
    .json<{ contentType?: string }>()
    .catch(() => ({ contentType: undefined }));
  const ct = contentType ?? 'application/pdf';
  // ID documents are commonly phone photos, so images are allowed here in
  // addition to the PDF/Word set the entry pack accepts.
  const allowed: Record<string, string> = {
    ...DOC_CONTENT_TYPES,
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/heic': 'heic',
  };
  if (!allowed[ct]) throw new HttpError(400, 'contentType must be an image or PDF');
  const objectKey = `${entryPrefix(ra.tenant, tid, sid)}players/${nk}-${randomUUID()}.${allowed[ct]}`;
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: UPLOADS_BUCKET, Key: objectKey, ContentType: ct }),
    { expiresIn: 300 },
  );
  return c.json({ uploadUrl: url, objectKey, contentType: ct });
});

app.patch('/tournaments/:tid/entries/:sid/players/:nk/id-doc', async (c) => {
  const ra = c.get('requestAuth')!;
  const tid = c.req.param('tid');
  const sid = c.req.param('sid');
  assertSchoolAccess(ra, sid);
  const meta = await c.req.json<{ objectKey: string; size: number; contentType?: string }>();
  if (!meta.objectKey) throw new HttpError(400, 'objectKey required');
  assertOwnObjectKey(ra.tenant, tid, sid, meta.objectKey);
  if (typeof meta.size !== 'number' || meta.size <= 0 || meta.size > MAX_DOC_BYTES) {
    throw new HttpError(400, 'file must be non-empty and under 10 MB');
  }
  try {
    const updated = await repo.updatePlayer(ra.tenant, tid, sid, c.req.param('nk'), {
      idDocMeta: { ...meta, uploadedAt: now() },
    });
    return c.json(updated);
  } catch (err) {
    if (err instanceof VersionConflictError) throw new HttpError(409, 'player changed; refetch');
    if ((err as Error).message === 'player not found') {
      throw new HttpError(404, 'player not found');
    }
    throw err;
  }
});

app.post('/tournaments/:tid/entries/:sid/players/:nk/id-doc/view-url', async (c) => {
  const ra = c.get('requestAuth')!;
  const tid = c.req.param('tid');
  const sid = c.req.param('sid');
  assertSchoolAccess(ra, sid);
  const player = await repo.getPlayer(ra.tenant, tid, sid, c.req.param('nk'));
  if (!player?.idDocMeta?.objectKey) throw new HttpError(404, 'no ID document on record');
  assertOwnObjectKey(ra.tenant, tid, sid, player.idDocMeta.objectKey);
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: UPLOADS_BUCKET, Key: player.idDocMeta.objectKey }),
    { expiresIn: 300 },
  );
  return c.json({ viewUrl: url, contentType: player.idDocMeta.contentType });
});

/** Every player across a tournament — the on-the-day age-verification audit list. */
app.get('/tournaments/:tid/players', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  return c.json(await repo.listAllPlayers(ra.tenant, c.req.param('tid')));
});
/**
 * Publish the draw to every accepted school — each gets only its own fixtures.
 *
 * Idempotency-keyed like the invite send: a double-click replays the stored
 * summary rather than sending twice, which matters more here than anywhere else
 * (a duplicate draw email to twenty schools is twenty confused sport directors).
 */
app.post('/tournaments/:tid/send-draw', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  const tid = c.req.param('tid');
  const { channels = ['email'], idempotencyKey } = await c.req.json<{
    channels?: Channel[];
    idempotencyKey?: string;
  }>();
  validateChannels(channels);
  if (!idempotencyKey) throw new HttpError(400, 'idempotencyKey required');

  const tournament = await repo.getTournament(ra.tenant, tid);
  if (!tournament) throw new HttpError(404, 'tournament not found');
  if (!tournament.released) throw new HttpError(409, 'release the draw before sending it');
  if (!tournament.fixtures?.length) throw new HttpError(409, 'there is no draw to send');

  const entries = (await repo.listEntries(ra.tenant, tid)).filter((e) => e.status === 'accepted');
  if (!entries.length) throw new HttpError(409, 'no accepted entries to send to');

  const namesById = new Map(entries.map((e) => [e.schoolId, e.teamName || e.schoolName]));
  const orgName = await tenantOrgName(ra.tenant);
  const results: SendResult[] = [];

  for (const entry of entries) {
    const schedule = buildSchoolSchedule(tournament, entry.schoolId, namesById);
    // A school with no fixtures (accepted after the draw was generated) is skipped
    // rather than sent an empty schedule that reads like a cancellation.
    if (!schedule) {
      results.push({
        channel: 'email',
        status: 'skipped',
        error: 'no fixtures in the current draw',
      });
      continue;
    }
    const sent = await sendSchoolDraw({
      channels,
      to: { email: entry.contact?.email, cell: entry.contact?.cell },
      orgName,
      schoolName: entry.teamName || entry.schoolName,
      tournamentName: tournament.name,
      schedule,
    });
    results.push(...sent);
  }

  const { summaryResults, commEvents } = summarizeBroadcast(
    results,
    channels,
    ra.email,
    idempotencyKey,
    'draw',
  );
  // The log lives on each school's directory record, so next season's organiser
  // can see what this school was actually told and when.
  for (const entry of entries) {
    await repo.appendSchoolCommEvents(ra.tenant, entry.schoolId, commEvents).catch((err) => {
      console.warn(`send-draw: comm log append failed for ${entry.schoolId}`, err);
    });
  }
  return c.json({ results: summaryResults, schools: entries.length });
});

// ═══════════════════════ Venue assessment (facilities module) ═══════════════
//
// All module routes sit under /admin/*, so the middleware at the top of the file
// already scopes them to an authenticated organiser of this tenant. A visiting
// school's rep never reaches any of them.

app.get('/admin/assessments', async (c) => {
  const ra = c.get('requestAuth')!;
  const list = await repo.listAssessments(ra.tenant);
  // Newest audit first — the list is what the organiser scans before match day.
  list.sort((a, b) => String(b.assessedAt).localeCompare(String(a.assessedAt)));
  return c.json(list);
});

app.get('/admin/assessments/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  const a = await repo.getAssessment(ra.tenant, c.req.param('id'));
  if (!a) throw new HttpError(404, 'assessment not found');
  return c.json(a);
});

app.post('/admin/assessments', async (c) => {
  const ra = c.get('requestAuth')!;
  const body = await c.req.json<Partial<VenueAssessment>>();
  if (!body.venueId) throw new HttpError(400, 'venueId is required');
  const invalid = validateAssessmentPatch(body);
  if (invalid) throw new HttpError(400, invalid);
  // The venue must be one of the host's own surfaces — you can't assess a field
  // that isn't on the books.
  const config = await repo.getTenantConfig(ra.tenant);
  const venue = (config?.venues ?? []).find((v) => v.id === body.venueId);
  if (!venue) throw new HttpError(404, 'venue not found');

  const assessment: VenueAssessment = {
    id: `asm-${randomUUID().slice(0, 8)}`,
    venueId: body.venueId,
    venueName: venue.name,
    assessedAt: body.assessedAt || today(),
    assessedBy: ra.email,
    scores: body.scores ?? [],
    actions: (body.actions ?? []).map((a) => ({ ...a, id: a.id || randomUUID().slice(0, 8) })),
    overall: typeof body.overall === 'number' ? body.overall : 0,
    verdict: body.verdict ?? 'conditional',
    notes: body.notes,
    photos: body.photos ?? [],
    createdAt: now(),
    version: 1,
    changedBy: ra.email,
    changedAt: now(),
  };
  await repo.putAssessment(ra.tenant, assessment);
  return c.json(assessment, 201);
});

app.patch('/admin/assessments/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const patch = await c.req.json<Partial<VenueAssessment>>();
  const invalid = validateAssessmentPatch(patch);
  if (invalid) throw new HttpError(400, invalid);
  // Give any new action an id so the client can key + toggle it.
  if (patch.actions) {
    patch.actions = patch.actions.map((a) => ({ ...a, id: a.id || randomUUID().slice(0, 8) }));
  }
  try {
    const updated = await repo.updateAssessment(ra.tenant, id, patch, ra.email, now());
    return c.json(updated);
  } catch (err) {
    if (err instanceof VersionConflictError)
      throw new HttpError(409, 'assessment changed; refetch');
    if ((err as Error).message === 'assessment not found') {
      throw new HttpError(404, 'assessment not found');
    }
    throw err;
  }
});

app.delete('/admin/assessments/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  await repo.deleteAssessment(ra.tenant, c.req.param('id'));
  return c.json({ ok: true });
});

// ═══════════════════════════════ Ticketing module ══════════════════════════

app.get('/admin/ticket-types', async (c) => {
  const ra = c.get('requestAuth')!;
  return c.json(await repo.listTicketTypes(ra.tenant));
});

app.post('/admin/ticket-types', async (c) => {
  const ra = c.get('requestAuth')!;
  const body = await c.req.json<Partial<TicketType>>();
  if (!body.name?.trim()) throw new HttpError(400, 'a ticket type needs a name');
  if (!body.eventId) throw new HttpError(400, 'eventId is required');
  const invalid = validateTicketTypePatch(body);
  if (invalid) throw new HttpError(400, invalid);
  const ticketType: TicketType = {
    id: `tt-${randomUUID().slice(0, 8)}`,
    eventId: body.eventId,
    eventName: body.eventName ?? body.eventId,
    tournamentId: body.tournamentId,
    name: body.name.trim(),
    priceCents: body.priceCents ?? 0,
    capacity: body.capacity ?? 0,
    sold: 0,
    active: body.active ?? true,
    createdAt: now(),
    version: 1,
  };
  await repo.putTicketType(ra.tenant, ticketType);
  return c.json(ticketType, 201);
});

app.patch('/admin/ticket-types/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  const patch = await c.req.json<Partial<TicketType>>();
  const invalid = validateTicketTypePatch(patch);
  if (invalid) throw new HttpError(400, invalid);
  // `sold` is server-maintained; a client patch must never overwrite it.
  delete (patch as { sold?: unknown }).sold;
  try {
    return c.json(await repo.updateTicketType(ra.tenant, c.req.param('id'), patch));
  } catch (err) {
    if (err instanceof VersionConflictError)
      throw new HttpError(409, 'ticket type changed; refetch');
    if ((err as Error).message === 'ticket type not found') {
      throw new HttpError(404, 'ticket type not found');
    }
    throw err;
  }
});

app.delete('/admin/ticket-types/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  // Refuse to delete a tier that has tickets against it — voiding those first is
  // the deliberate path, so a sold ticket never dangles pointing at nothing.
  const sold = (await repo.listTickets(ra.tenant)).some(
    (t) => t.ticketTypeId === id && t.status !== 'void',
  );
  if (sold) throw new HttpError(409, 'void this tier’s tickets before deleting it');
  await repo.deleteTicketType(ra.tenant, id);
  return c.json({ ok: true });
});

app.get('/admin/tickets', async (c) => {
  const ra = c.get('requestAuth')!;
  return c.json(await repo.listTickets(ra.tenant));
});

/** Issue a ticket: capacity-checked, QR-tokened, sold-count bumped. */
app.post('/admin/tickets', async (c) => {
  const ra = c.get('requestAuth')!;
  const body = await c.req.json<Partial<Ticket>>();
  if (!body.ticketTypeId) throw new HttpError(400, 'ticketTypeId is required');
  if (!body.buyerName?.trim()) throw new HttpError(400, 'a ticket needs a buyer name');
  const invalid = validateTicketPatch(body);
  if (invalid) throw new HttpError(400, invalid);

  const type = await repo.getTicketType(ra.tenant, body.ticketTypeId);
  if (!type) throw new HttpError(404, 'ticket type not found');
  if (!type.active) throw new HttpError(409, 'this ticket tier is not on sale');
  const qty = body.quantity ?? 1;
  // Capacity is a hard gate — 0 means "unlimited" (a free open day), any other
  // value caps issued (non-void) tickets.
  if (type.capacity > 0 && (type.sold ?? 0) + qty > type.capacity) {
    const left = Math.max(0, type.capacity - (type.sold ?? 0));
    throw new HttpError(409, `only ${left} ticket${left === 1 ? '' : 's'} left for ${type.name}`);
  }

  const ticket: Ticket = {
    id: `tk-${randomUUID().slice(0, 10)}`,
    eventId: type.eventId,
    ticketTypeId: type.id,
    ticketTypeName: type.name,
    priceCents: type.priceCents,
    buyerName: body.buyerName.trim(),
    buyerEmail: body.buyerEmail,
    buyerCell: body.buyerCell,
    schoolId: body.schoolId,
    quantity: qty,
    status: 'valid',
    // A comp ticket is marked paid-as-comp; otherwise it starts unpaid unless the
    // organiser recorded a payment on issue.
    payment: body.payment ?? (type.priceCents === 0 ? 'comp' : 'unpaid'),
    qrToken: randomUUID(),
    code: shortCode('RC'),
    issuedAt: now(),
    issuedBy: ra.email,
    version: 1,
  };
  await repo.createTicket(ra.tenant, ticket);
  return c.json(ticket, 201);
});

app.patch('/admin/tickets/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  const patch = await c.req.json<Partial<Ticket>>();
  const invalid = validateTicketPatch(patch);
  if (invalid) throw new HttpError(400, invalid);
  // The QR/code identity and the status are set through dedicated routes only.
  for (const f of ['qrToken', 'code', 'status', 'ticketTypeId'] as const) {
    delete (patch as Record<string, unknown>)[f];
  }
  try {
    return c.json(await repo.updateTicket(ra.tenant, c.req.param('id'), patch));
  } catch (err) {
    if (err instanceof VersionConflictError) throw new HttpError(409, 'ticket changed; refetch');
    if ((err as Error).message === 'ticket not found') throw new HttpError(404, 'ticket not found');
    throw err;
  }
});

app.post('/admin/tickets/:id/void', async (c) => {
  const ra = c.get('requestAuth')!;
  try {
    return c.json(await repo.voidTicket(ra.tenant, c.req.param('id')));
  } catch (err) {
    if ((err as Error).message === 'ticket not found') throw new HttpError(404, 'ticket not found');
    throw err;
  }
});

// ═══════════════════════════════ Parking module ════════════════════════════

app.get('/admin/parking/zones', async (c) => {
  const ra = c.get('requestAuth')!;
  return c.json(await repo.listParkingZones(ra.tenant));
});

app.post('/admin/parking/zones', async (c) => {
  const ra = c.get('requestAuth')!;
  const body = await c.req.json<Partial<ParkingZone>>();
  if (!body.name?.trim()) throw new HttpError(400, 'a zone needs a name');
  const invalid = validateParkingZonePatch(body);
  if (invalid) throw new HttpError(400, invalid);
  const zone: ParkingZone = {
    id: `pz-${randomUUID().slice(0, 8)}`,
    name: body.name.trim(),
    kind: body.kind ?? 'general',
    capacity: body.capacity ?? 0,
    allocated: 0,
    note: body.note,
    createdAt: now(),
    version: 1,
  };
  await repo.putParkingZone(ra.tenant, zone);
  return c.json(zone, 201);
});

app.patch('/admin/parking/zones/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  const patch = await c.req.json<Partial<ParkingZone>>();
  const invalid = validateParkingZonePatch(patch);
  if (invalid) throw new HttpError(400, invalid);
  delete (patch as { allocated?: unknown }).allocated;
  try {
    return c.json(await repo.updateParkingZone(ra.tenant, c.req.param('id'), patch));
  } catch (err) {
    if (err instanceof VersionConflictError) throw new HttpError(409, 'zone changed; refetch');
    if ((err as Error).message === 'parking zone not found') {
      throw new HttpError(404, 'parking zone not found');
    }
    throw err;
  }
});

app.delete('/admin/parking/zones/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const inUse = (await repo.listParkingPasses(ra.tenant)).some(
    (p) => p.zoneId === id && p.status !== 'void',
  );
  if (inUse) throw new HttpError(409, 'void this zone’s passes before deleting it');
  await repo.deleteParkingZone(ra.tenant, id);
  return c.json({ ok: true });
});

app.get('/admin/parking/passes', async (c) => {
  const ra = c.get('requestAuth')!;
  return c.json(await repo.listParkingPasses(ra.tenant));
});

/** Allocate a parking pass: capacity-checked against its zone, QR-tokened. */
app.post('/admin/parking/passes', async (c) => {
  const ra = c.get('requestAuth')!;
  const body = await c.req.json<Partial<ParkingPass>>();
  if (!body.zoneId) throw new HttpError(400, 'zoneId is required');
  if (!body.eventId) throw new HttpError(400, 'eventId is required');
  if (!body.allocatedTo?.trim()) throw new HttpError(400, 'a pass needs an allocatee');
  const invalid = validateParkingPassPatch(body);
  if (invalid) throw new HttpError(400, invalid);

  const zone = await repo.getParkingZone(ra.tenant, body.zoneId);
  if (!zone) throw new HttpError(404, 'parking zone not found');
  const bays = body.bays ?? 1;
  if (zone.capacity > 0 && (zone.allocated ?? 0) + bays > zone.capacity) {
    const left = Math.max(0, zone.capacity - (zone.allocated ?? 0));
    throw new HttpError(409, `only ${left} bay${left === 1 ? '' : 's'} left in ${zone.name}`);
  }

  const pass: ParkingPass = {
    id: `pp-${randomUUID().slice(0, 10)}`,
    zoneId: zone.id,
    zoneName: zone.name,
    eventId: body.eventId,
    schoolId: body.schoolId,
    allocatedTo: body.allocatedTo.trim(),
    vehicle: body.vehicle,
    registration: body.registration,
    bays,
    arrivalSlot: body.arrivalSlot,
    status: 'allocated',
    qrToken: randomUUID(),
    code: shortCode('P'),
    issuedAt: now(),
    issuedBy: ra.email,
    version: 1,
  };
  await repo.createParkingPass(ra.tenant, pass);
  return c.json(pass, 201);
});

app.post('/admin/parking/passes/:id/void', async (c) => {
  const ra = c.get('requestAuth')!;
  try {
    return c.json(await repo.voidParkingPass(ra.tenant, c.req.param('id')));
  } catch (err) {
    if ((err as Error).message === 'parking pass not found') {
      throw new HttpError(404, 'parking pass not found');
    }
    throw err;
  }
});

// ═══════════════════════════ Gate check-in (scan) ══════════════════════════

/**
 * Resolve a scanned QR token (or a typed short code) and check the holder in.
 *
 * One endpoint covers both tickets and parking: the token self-describes its
 * kind, so a marshal's device never needs to know which module it belongs to.
 * The tenant on the token must match the caller's — a scan can't reach across
 * tenants even though the token keyspace is global.
 */
app.post('/admin/scan', async (c) => {
  const ra = c.get('requestAuth')!;
  const { token, code } = await c.req.json<{ token?: string; code?: string }>();

  let resolved = token ? await repo.getScanToken(token) : null;
  // Fall back to the short human code when the scan failed and the marshal typed
  // it — a linear scan of the tenant's live records, fine at gate volumes.
  if (!resolved && code) {
    const wanted = code.trim().toUpperCase();
    const ticket = (await repo.listTickets(ra.tenant)).find(
      (t) => t.code === wanted && t.status !== 'void',
    );
    if (ticket) resolved = { tenant: ra.tenant, kind: 'ticket', refId: ticket.id };
    else {
      const pass = (await repo.listParkingPasses(ra.tenant)).find(
        (p) => p.code === wanted && p.status !== 'void',
      );
      if (pass) resolved = { tenant: ra.tenant, kind: 'parking', refId: pass.id };
    }
  }
  if (!resolved) throw new HttpError(404, 'no valid ticket or pass for that code');
  if (resolved.tenant !== ra.tenant)
    throw new HttpError(404, 'no valid ticket or pass for that code');

  if (resolved.kind === 'ticket') {
    const ticket = await repo.getTicket(ra.tenant, resolved.refId);
    if (!ticket) throw new HttpError(404, 'ticket not found');
    if (ticket.status === 'void') throw new HttpError(409, 'this ticket has been voided');
    if (ticket.status === 'checked_in') {
      return c.json({ kind: 'ticket', already: true, record: ticket });
    }
    const updated = await repo.updateTicket(ra.tenant, ticket.id, {
      status: 'checked_in',
      checkedInAt: now(),
      checkedInBy: ra.email,
      version: ticket.version,
    });
    return c.json({ kind: 'ticket', already: false, record: updated });
  }

  const pass = await repo.getParkingPass(ra.tenant, resolved.refId);
  if (!pass) throw new HttpError(404, 'parking pass not found');
  if (pass.status === 'void') throw new HttpError(409, 'this pass has been voided');
  if (pass.status === 'arrived') {
    return c.json({ kind: 'parking', already: true, record: pass });
  }
  const updated = await repo.updateParkingPass(ra.tenant, pass.id, {
    status: 'arrived',
    arrivedAt: now(),
    arrivedBy: ra.email,
    version: pass.version,
  });
  return c.json({ kind: 'parking', already: false, record: updated });
});

// ═══════════════════ Academic support (university module) ══════════════════
//
// All under /admin/*, so the middleware already scopes them to an organiser of
// this tenant. Student-athlete academic records are sensitive PII held under the
// SOP's POPIA consent — never exposed to a visiting-school rep.

app.get('/admin/academic/athletes', async (c) => {
  const ra = c.get('requestAuth')!;
  return c.json(await repo.listAthletes(ra.tenant));
});

app.get('/admin/academic/athletes/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  const a = await repo.getAthlete(ra.tenant, c.req.param('id'));
  if (!a) throw new HttpError(404, 'athlete not found');
  return c.json(a);
});

app.post('/admin/academic/athletes', async (c) => {
  const ra = c.get('requestAuth')!;
  const body = await c.req.json<Partial<StudentAthlete>>();
  if (!body.firstName?.trim() || !body.lastName?.trim()) {
    throw new HttpError(400, 'first name and surname are required');
  }
  if (!body.studentNumber?.trim()) throw new HttpError(400, 'a student number is required');
  const invalid = validateAthletePatch(body);
  if (invalid) throw new HttpError(400, invalid);

  const athlete: StudentAthlete = {
    id: `ath-${randomUUID().slice(0, 8)}`,
    firstName: body.firstName.trim(),
    lastName: body.lastName.trim(),
    studentNumber: body.studentNumber.trim().toUpperCase(),
    saId: body.saId,
    squad: body.squad ?? 'General',
    faculty: body.faculty,
    degree: body.degree,
    yearOfStudy: body.yearOfStudy,
    creditsRegistered: body.creditsRegistered,
    mentor: body.mentor,
    riskCategory: body.riskCategory,
    lectureAttendance: body.lectureAttendance,
    tutorialAttendance: body.tutorialAttendance,
    assignmentCompletion: body.assignmentCompletion,
    semesterAverage: body.semesterAverage,
    facultyWarning: body.facultyWarning,
    assessedAt: hasSnapshot(body) ? now() : undefined,
    consentAt: body.consentAt,
    status: body.status ?? 'active',
    notes: body.notes,
    createdAt: now(),
    version: 1,
    changedBy: ra.email,
    changedAt: now(),
  };
  await repo.putAthlete(ra.tenant, athlete);
  return c.json(athlete, 201);
});

app.patch('/admin/academic/athletes/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const patch = await c.req.json<Partial<StudentAthlete>>();
  const invalid = validateAthletePatch(patch);
  if (invalid) throw new HttpError(400, invalid);
  // Stamp the snapshot time whenever any academic metric is touched, so "last
  // assessed" reflects reality without the client having to send it.
  if (hasSnapshot(patch)) patch.assessedAt = now();
  try {
    return c.json(await repo.updateAthlete(ra.tenant, id, patch, ra.email, now()));
  } catch (err) {
    if (err instanceof VersionConflictError) throw new HttpError(409, 'athlete changed; refetch');
    if ((err as Error).message === 'athlete not found') {
      throw new HttpError(404, 'athlete not found');
    }
    throw err;
  }
});

app.delete('/admin/academic/athletes/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  await repo.deleteAthlete(ra.tenant, c.req.param('id'));
  return c.json({ ok: true });
});

// ── Bi-weekly check-ins ──

app.get('/admin/academic/check-ins', async (c) => {
  const ra = c.get('requestAuth')!;
  const list = await repo.listCheckIns(ra.tenant);
  list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return c.json(list);
});

app.post('/admin/academic/check-ins', async (c) => {
  const ra = c.get('requestAuth')!;
  const body = await c.req.json<Partial<AcademicCheckIn> & { athleteId?: string }>();
  const invalid = validateCheckIn(body);
  if (invalid) throw new HttpError(400, invalid);
  const athlete = await repo.getAthlete(ra.tenant, body.athleteId ?? '');
  // The check-in denormalizes the athlete name; resolve it from the roster when
  // the client sent an athleteId, else trust the name it supplied.
  const athleteName = athlete
    ? `${athlete.firstName} ${athlete.lastName}`
    : (body.athleteName ?? body.studentNumber!);
  const id = `chk-${randomUUID().slice(0, 8)}`;
  // When a plan is assigned to an external mentor, mint an opaque completion
  // token so the public /mentor-plan page can resolve it without any auth.
  const token = body.planStatus === 'sent' ? randomBytes(18).toString('base64url') : undefined;
  const checkIn: AcademicCheckIn = {
    id,
    studentNumber: body.studentNumber!.trim().toUpperCase(),
    athleteName,
    date: body.date || today(),
    mentor: body.mentor ?? athlete?.mentor,
    riskLevel: body.riskLevel,
    followUpRequired: body.followUpRequired,
    answers: body.answers ?? {},
    note: body.note,
    // Academic Development Plan payload (kind === 'adp'); undefined for legacy.
    kind: body.kind,
    period: body.period,
    modules: body.modules,
    sections: body.sections,
    plan: body.plan,
    mentorEmail: body.mentorEmail,
    planStatus: body.planStatus,
    token,
    scheduledNext: body.scheduledNext,
    sentAt: body.planStatus === 'sent' ? now() : undefined,
    createdAt: now(),
    createdBy: ra.email,
    version: 1,
  };
  await repo.putCheckIn(ra.tenant, checkIn);
  if (token) {
    await repo.putMentorPlanToken(token, {
      tenant: ra.tenant,
      checkInId: id,
      studentNumber: checkIn.studentNumber,
    });
  }
  return c.json(checkIn, 201);
});

app.delete('/admin/academic/check-ins/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  const existing = await repo.getCheckIn(ra.tenant, c.req.param('id'));
  if (existing?.token) await repo.deleteToken(existing.token);
  await repo.deleteCheckIn(ra.tenant, c.req.param('id'));
  return c.json({ ok: true });
});

// ── External mentors (registry) ──

app.get('/admin/academic/mentors', async (c) => {
  const ra = c.get('requestAuth')!;
  const list = await repo.listMentors(ra.tenant);
  list.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  return c.json(list);
});

app.post('/admin/academic/mentors', async (c) => {
  const ra = c.get('requestAuth')!;
  const body = await c.req.json<Partial<Mentor>>();
  if (!body.name?.trim()) throw new HttpError(400, 'a name is required');
  if (!body.email?.trim()) throw new HttpError(400, 'an email is required');
  const invalid = validateMentor(body);
  if (invalid) throw new HttpError(400, invalid);
  const mentor: Mentor = {
    id: `mtr-${randomUUID().slice(0, 8)}`,
    name: body.name.trim(),
    email: body.email.trim().toLowerCase(),
    phone: body.phone?.trim() || undefined,
    organisation: body.organisation?.trim() || undefined,
    createdAt: now(),
    createdBy: ra.email,
    version: 1,
  };
  await repo.putMentor(ra.tenant, mentor);
  return c.json(mentor, 201);
});

app.patch('/admin/academic/mentors/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  const patch = await c.req.json<Partial<Mentor>>();
  const invalid = validateMentor(patch);
  if (invalid) throw new HttpError(400, invalid);
  try {
    return c.json(await repo.updateMentor(ra.tenant, c.req.param('id'), patch));
  } catch (err) {
    if ((err as Error).message === 'mentor not found') throw new HttpError(404, 'mentor not found');
    throw err;
  }
});

app.delete('/admin/academic/mentors/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  await repo.deleteMentor(ra.tenant, c.req.param('id'));
  return c.json({ ok: true });
});

// ── Interventions ──

app.get('/admin/academic/interventions', async (c) => {
  const ra = c.get('requestAuth')!;
  const list = await repo.listInterventions(ra.tenant);
  list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return c.json(list);
});

app.post('/admin/academic/interventions', async (c) => {
  const ra = c.get('requestAuth')!;
  const body = await c.req.json<Partial<AcademicIntervention> & { athleteId?: string }>();
  if (!body.studentNumber?.trim()) throw new HttpError(400, 'studentNumber is required');
  if (!body.concern?.trim()) throw new HttpError(400, 'a concern is required');
  const invalid = validateInterventionPatch(body);
  if (invalid) throw new HttpError(400, invalid);
  const athlete = await repo.getAthlete(ra.tenant, body.athleteId ?? '');
  const intervention: AcademicIntervention = {
    id: `int-${randomUUID().slice(0, 8)}`,
    studentNumber: body.studentNumber.trim().toUpperCase(),
    athleteName: athlete
      ? `${athlete.firstName} ${athlete.lastName}`
      : (body.athleteName ?? body.studentNumber),
    date: body.date || today(),
    concern: body.concern.trim(),
    actionTaken: body.actionTaken,
    referredTo: body.referredTo,
    followUpDate: body.followUpDate,
    status: body.status ?? 'open',
    raisedBy: ra.email,
    createdAt: now(),
    version: 1,
  };
  await repo.putIntervention(ra.tenant, intervention);
  return c.json(intervention, 201);
});

app.patch('/admin/academic/interventions/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const patch = await c.req.json<Partial<AcademicIntervention>>();
  const invalid = validateInterventionPatch(patch);
  if (invalid) throw new HttpError(400, invalid);
  try {
    return c.json(await repo.updateIntervention(ra.tenant, id, patch, ra.email, now()));
  } catch (err) {
    if (err instanceof VersionConflictError) {
      throw new HttpError(409, 'intervention changed; refetch');
    }
    if ((err as Error).message === 'intervention not found') {
      throw new HttpError(404, 'intervention not found');
    }
    throw err;
  }
});

app.delete('/admin/academic/interventions/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  await repo.deleteIntervention(ra.tenant, c.req.param('id'));
  return c.json({ ok: true });
});

// ───────────────────── Tenant config + users (admin) ─────────────────────

// Anchored + TLD-required: blocks whitespace/newlines, so the validated value is
// safe to splice into a mailto: link downstream. Kept identical to api.js EMAIL_RE.
const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;

/** Mirror of PROVINCES in src/data.jsx — the signup form's province choices. */
const PROVINCES = new Set([
  'Eastern Cape',
  'Free State',
  'Gauteng',
  'KwaZulu-Natal',
  'Limpopo',
  'Mpumalanga',
  'North West',
  'Northern Cape',
  'Western Cape',
  'International',
]);

app.get('/tenant/config', async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const config = await repo.getTenantConfig(tenant);
  if (!config) throw new HttpError(404, 'tenant not found');
  // The signup token is a live credential — it has its own route, and a config
  // read (which any member can make) must not hand it out.
  const { schoolSignupLink, ...safe } = config;
  return c.json({ ...safe, hasSignupLink: !!schoolSignupLink });
});

app.put('/tenant/config', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const patch = await c.req.json<Partial<TenantConfig>>();
  const current = await repo.getTenantConfig(tenant);
  if (!current) throw new HttpError(404, 'tenant not found');
  // schoolSignupLink is server-owned and written only via its targeted routes — a stale
  // Settings tab's whole-config save must not resurrect a revoked link. registrationAccess
  // is retired; strip it too so an old client can't write it back onto the row.
  delete (patch as { schoolSignupLink?: unknown }).schoolSignupLink;
  delete (patch as { registrationAccess?: unknown }).registrationAccess;
  // Guard the venue list: ids are the matching token stored on every fixture, so a
  // duplicate or blank id would silently point two matches at the same slot.
  if (patch.venues !== undefined) {
    const ids = patch.venues.map((v) => v.id);
    if (ids.some((id) => !id)) throw new HttpError(400, 'every venue needs an id');
    if (patch.venues.some((v) => !v.name?.trim()))
      throw new HttpError(400, 'every venue needs a name');
    if (new Set(ids).size !== ids.length) throw new HttpError(409, 'duplicate venue id');
  }
  const next = { ...current, ...patch, tenant };
  await repo.putTenantConfig(next);
  return c.json(next);
});

/**
 * Update the union support contact (admin only, like the rest of tenant config).
 * Validates name + email, recombines into the "Name · email" string the UI parses,
 * and writes only that one copy slot (repo.updateSupportCopy) so it can't clobber a
 * concurrent leagues/deadline write.
 */
app.put('/tenant/support', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const { name, email } = await c.req.json<{ name?: string; email?: string }>();
  const officeName = (name ?? '').trim().replace(/·/g, '').trim();
  const addr = (email ?? '').trim();
  if (!officeName) throw new HttpError(400, 'office name required');
  if (!EMAIL_RE.test(addr)) throw new HttpError(400, 'valid email required');
  const support = `${officeName} · ${addr}`;
  try {
    await repo.updateSupportCopy(tenant, support);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new HttpError(404, 'tenant not found');
    }
    throw err;
  }
  return c.json({ support });
});

/**
 * GET /admin/users — list every user in the tenant for the Team & Access roster.
 *
 * Lists from the marker GSI, then ENRICHES each via getUser: the markers carry only
 * {sub,email,role} and NOT schoolIds, so a rep's school scope has no other source. This is
 * a bounded N+1 (team-sized N) and intentional. POPIA: first endpoint to bulk-return
 * member emails — admin-gated, consistent with the documented invite exception.
 *
 * Shape: [{ sub, email, role, schoolIds, invitedAt, status }], status = lastLoginAt
 * ? 'active' : 'pending'.
 */
app.get('/admin/users', async (c) => {
  const ra = c.get('requestAuth')!;
  const roster = await repo.listTenantUsers(ra.tenant);
  const rows = await Promise.all(
    roster.map(async (entry) => {
      const profile = await repo.getUser(entry.sub);
      const membership = profile?.memberships.find((m) => m.tenantId === ra.tenant);
      return {
        sub: entry.sub,
        email: profile?.email ?? entry.email,
        // Authoritative role from memberships; fall back to the marker for a half-written user.
        role: membership?.role ?? (entry.role as 'admin' | 'rep'),
        schoolIds: membership?.schoolIds ?? [],
        invitedAt: membership?.invitedAt,
        status: profile?.lastLoginAt ? ('active' as const) : ('pending' as const),
      };
    }),
  );
  return c.json(rows);
});

/**
 * POST /admin/users — invite a user (admin): create the Cognito account + USER#
 * membership record, optionally send a staff invite, and return a copyable login link.
 *
 * Email is normalized server-side (trim + lowercase) so the stored email / gsi1sk can't
 * drift from the Cognito username (a casing mismatch would orphan the account on
 * offboard). A re-invite of an ALREADY-ACTIVE user (a membership for this tenant +
 * lastLoginAt set) is a 409, not a silent role/scope reset. Inviting an admin runs the
 * adminCount increment in the same transaction as the user write.
 */
app.post('/admin/users', async (c) => {
  const ra = c.get('requestAuth')!;
  const body = await c.req.json<{
    email?: string;
    role?: 'admin' | 'rep';
    schoolIds?: string[];
    channels?: Channel[];
    link?: string;
  }>();
  const email = (body.email ?? '').trim().toLowerCase();
  if (!email) throw new HttpError(400, 'email required');
  const role: 'admin' | 'rep' = body.role === 'admin' ? 'admin' : 'rep';
  const schoolIds = role === 'admin' ? [] : (body.schoolIds ?? []);
  if (role === 'rep' && schoolIds.length === 0)
    throw new HttpError(400, 'a rep must be scoped to at least one school');

  // Validate the optional invite link up front (so a bad link fails before provisioning).
  // Falls back to the request-derived app origin when no link is supplied.
  const loginUrl = resolveLoginUrl(c, body.link);
  if (body.channels !== undefined) validateChannels(body.channels);

  // Create (or reuse, for a multi-union invite) a CONFIRMED passwordless user.
  const sub = await ensurePasswordlessUser(cognito, USER_POOL_ID, email);
  const existing = await repo.getUser(sub);
  const others = (existing?.memberships ?? []).filter((m) => m.tenantId !== ra.tenant);
  const prior = (existing?.memberships ?? []).find((m) => m.tenantId === ra.tenant);
  // Re-invite of an already-active user must not silently reset their role/schoolIds.
  if (prior && existing?.lastLoginAt)
    throw new HttpError(409, 'user already active — use resend or edit role');

  const membership: Membership = {
    tenantId: ra.tenant,
    role,
    schoolIds,
    // Keep the original invite stamp on a re-invite of a still-pending user.
    invitedAt: prior?.invitedAt ?? now(),
    invitedBy: prior?.invitedBy ?? ra.email,
  };
  const next: UserProfile = {
    sub,
    email,
    memberships: [...others, membership],
    onboardingSeen: existing?.onboardingSeen ?? {},
    ...(existing?.lastLoginAt ? { lastLoginAt: existing.lastLoginAt } : {}),
  };

  // adminCount delta = the admin-tier transition for this tenant: +1 when becoming an
  // admin, -1 when a re-invite demotes a still-pending admin to rep (else 0). The -1 case
  // routes through the transactional guard in writeUserGuarded, so re-inviting the only
  // admin down to rep is correctly blocked (409) instead of silently drifting the counter.
  const wasAdmin = prior?.role === 'admin';
  const delta: -1 | 0 | 1 =
    role === 'admin' && !wasAdmin ? 1 : role !== 'admin' && wasAdmin ? -1 : 0;
  await writeUserGuarded(ra.tenant, next, delta);

  let results: SendResult[] | undefined;
  if (body.channels && body.channels.length > 0) {
    const orgName = await tenantOrgName(ra.tenant);
    ({ results } = await sendStaffInvite({
      email,
      orgName,
      channels: body.channels,
      link: loginUrl,
    }));
  }
  return c.json({ sub, email, loginUrl, ...(results ? { results } : {}) }, 201);
});

/**
 * PATCH /admin/users/:sub — change a user's role and/or school scope within THIS tenant.
 *
 * Filter-then-reattach (never replace the whole memberships array — that would strip the
 * user's access in OTHER tenants). Admins force schoolIds:[]; reps must keep ≥1 school. A
 * demote (admin→rep) goes through the transactional last-admin guard and is followed by
 * a global sign-out so the just-demoted user can't reuse an elevated token. Returns the
 * updated tenant row.
 */
app.patch('/admin/users/:sub', async (c) => {
  const ra = c.get('requestAuth')!;
  const sub = c.req.param('sub');
  const body = await c.req.json<{ role?: 'admin' | 'rep'; schoolIds?: string[] }>();

  const profile = await repo.getUser(sub);
  const current = profile?.memberships.find((m) => m.tenantId === ra.tenant);
  if (!profile || !current) throw new HttpError(404, 'user not found in this tenant');

  const role = body.role ?? current.role;
  if (role !== 'admin' && role !== 'rep') throw new HttpError(400, 'invalid role');
  const schoolIds = role === 'admin' ? [] : (body.schoolIds ?? current.schoolIds);
  if (role === 'rep' && schoolIds.length === 0)
    throw new HttpError(400, 'a rep must be scoped to at least one school');

  const others = profile.memberships.filter((m) => m.tenantId !== ra.tenant);
  const updated: Membership = { ...current, role, schoolIds };
  const next: UserProfile = { ...profile, memberships: [...others, updated] };

  const demote = current.role === 'admin' && role === 'rep';
  const promote = current.role === 'rep' && role === 'admin';
  const delta: -1 | 0 | 1 = demote ? -1 : promote ? 1 : 0;
  await writeUserGuarded(ra.tenant, next, delta);

  // Kill refresh tokens after a demote so no NEW elevated token can be minted (the
  // current one stays valid until it expires — bounded ≤ pool TTL window).
  if (demote) await adminGlobalSignOut(cognito, USER_POOL_ID, profile.email);

  return c.json({
    sub,
    email: profile.email,
    role,
    schoolIds,
    invitedAt: updated.invitedAt,
    status: profile.lastLoginAt ? 'active' : 'pending',
  });
});

/**
 * DELETE /admin/users/:sub — remove a user's access to THIS tenant only.
 *
 * Filter-then-reattach to drop just this tenant's membership (mirrors erase-tenant): if
 * the user has no memberships left, fully offboard (deleteUser + Cognito delete); else
 * putUser with the rest. Removing an admin goes through the transactional last-admin
 * guard (blocks removing the last admin, incl. yourself). Then global sign-out.
 */
app.delete('/admin/users/:sub', async (c) => {
  const ra = c.get('requestAuth')!;
  const sub = c.req.param('sub');

  const profile = await repo.getUser(sub);
  const current = profile?.memberships.find((m) => m.tenantId === ra.tenant);
  if (!profile || !current) throw new HttpError(404, 'user not found in this tenant');

  const remaining = profile.memberships.filter((m) => m.tenantId !== ra.tenant);
  const wasAdmin = current.role === 'admin';

  if (remaining.length === 0) {
    // Full offboard. Guard the admin count BEFORE deleting so the last admin can't be
    // removed; on success drop the META item and the Cognito account. Unlike the PATCH /
    // partial-removal path (writeUserWithAdminDelta is one transaction), this decrement and
    // the deleteUser are NOT atomic — if deleteUser failed after the decrement, adminCount
    // would drift LOW, which only makes the guard stricter (never enables a lockout), so the
    // asymmetry is the safe direction; recountAdmins repairs any drift.
    if (wasAdmin) await guardAdminDecrement(ra.tenant);
    await repo.deleteUser(sub);
    await adminDeleteCognitoUser(cognito, USER_POOL_ID, profile.email);
  } else {
    const next: UserProfile = { ...profile, memberships: remaining };
    await writeUserGuarded(ra.tenant, next, wasAdmin ? -1 : 0);
  }
  // Revoke refresh tokens so removed access can't be re-minted on the next refresh.
  await adminGlobalSignOut(cognito, USER_POOL_ID, profile.email);
  return c.json({ ok: true });
});

/**
 * POST /admin/users/:sub/resend — re-send the staff invite (always allowed, even for an
 * active user who wants a fresh link). Returns the per-channel send results.
 */
app.post('/admin/users/:sub/resend', async (c) => {
  const ra = c.get('requestAuth')!;
  const sub = c.req.param('sub');
  const body = await c.req
    .json<{ channels?: Channel[]; link?: string }>()
    .catch(() => ({}) as { channels?: Channel[]; link?: string });

  const profile = await repo.getUser(sub);
  const membership = profile?.memberships.find((m) => m.tenantId === ra.tenant);
  if (!profile || !membership) throw new HttpError(404, 'user not found in this tenant');

  const channels =
    body.channels && body.channels.length > 0 ? body.channels : (['email'] as Channel[]);
  validateChannels(channels);
  const loginUrl = resolveLoginUrl(c, body.link);
  const orgName = await tenantOrgName(ra.tenant);
  const { results } = await sendStaffInvite({
    email: profile.email,
    orgName,
    channels,
    link: loginUrl,
  });
  return c.json({ results });
});

// ───────────────── Admin: school self-registration link ─────────────────

/** The tenant's active school signup link, or null. SPA builds the /signup?t= URL. */
app.get('/admin/school-signup-link', async (c) => {
  const ra = c.get('requestAuth')!;
  const cfg = await repo.getTenantConfig(ra.tenant);
  if (!cfg) throw new HttpError(404, 'tenant not found');
  return c.json({ schoolSignupLink: cfg.schoolSignupLink ?? null });
});

/**
 * Mint a fresh school signup link. Single active link per tenant: the prior token
 * is revoked once the new one is stored, and the CONFIG pointer is written via a
 * targeted update so a concurrent Settings save can't clobber or resurrect it.
 */
app.post('/admin/school-signup-link', async (c) => {
  const ra = c.get('requestAuth')!;
  const cfg = await repo.getTenantConfig(ra.tenant);
  if (!cfg) throw new HttpError(404, 'tenant not found');
  const token = randomUUID();
  const createdAt = now();
  await repo.putSignupToken(token, ra.tenant, createdAt);
  const oldToken = cfg.schoolSignupLink?.token;
  if (oldToken && oldToken !== token) await repo.deleteToken(oldToken);
  await repo.updateSchoolSignupLink(ra.tenant, { token, createdAt });
  return c.json({ schoolSignupLink: { token, createdAt } });
});

/** Revoke the school signup link (token + pointer). Idempotent. */
app.delete('/admin/school-signup-link', async (c) => {
  const ra = c.get('requestAuth')!;
  const cfg = await repo.getTenantConfig(ra.tenant);
  if (!cfg) throw new HttpError(404, 'tenant not found');
  if (cfg.schoolSignupLink?.token) await repo.deleteToken(cfg.schoolSignupLink.token);
  await repo.updateSchoolSignupLink(ra.tenant, null);
  return c.json({ ok: true });
});
// ───────────────────── User-management helpers ─────────────────────

/** Reject a channels array that's empty or carries an unknown channel (400). */
function validateChannels(channels: Channel[]): void {
  if (!Array.isArray(channels) || channels.length === 0)
    throw new HttpError(400, 'channels required');
  const bad = channels.find((ch) => ch !== 'email' && ch !== 'whatsapp');
  if (bad) throw new HttpError(400, `unknown channel: ${bad}`);
}

/**
 * Resolve the sign-in URL an invite should carry. Prefers a client-supplied `link`
 * (so it rides the tenant's own custom domain), validated to be http(s) on a TRUSTED
 * app origin — so an admin can't aim an invite at a phishing domain. Falls back to the
 * request's own Origin (or a localhost dev default) when no link is supplied.
 */
function resolveLoginUrl(c: Context<HonoEnv>, link?: string): string {
  if (link) {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new HttpError(400, 'valid link required');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new HttpError(400, 'valid link required');
    if (!originAllowed(url.origin)) throw new HttpError(400, 'link host not allowed');
    return url.href;
  }
  const origin = c.req.header('origin') ?? '';
  if (origin && originAllowed(origin)) return origin;
  // No usable origin (e.g. a server-to-server call) — return a harmless localhost
  // default so the response always carries a copyable link; the admin can correct it.
  return 'http://localhost:5173';
}

/** The tenant's display name for invite copy, falling back to the slug. */
async function tenantOrgName(tenant: string): Promise<string> {
  const cfg = await repo.getTenantConfig(tenant);
  return cfg?.branding?.name || cfg?.branding?.title || tenant;
}

/**
 * Write a user with an adminCount delta, lazily backfilling CONFIG.adminCount from
 * authoritative memberships when it's absent (legacy tenant) so the transactional
 * guard's `adminCount > 1` condition has a real value to compare. Maps the typed
 * last-admin rejection to a 409.
 */
async function writeUserGuarded(
  tenant: string,
  user: UserProfile,
  delta: -1 | 0 | 1,
): Promise<void> {
  if (delta !== 0) await ensureAdminCount(tenant);
  // Before a guarded decrement, prune phantom admins (membership but no Cognito user) so
  // the floor compares against REAL admins — an orphan must not mask the last-admin guard.
  if (delta === -1) await reconcileTenantAdmins(tenant, adminExists);
  try {
    await repo.writeUserWithAdminDelta(user, tenant, delta);
  } catch (err) {
    if (err instanceof LastAdminError) throw new HttpError(409, 'cannot remove the last admin');
    throw err;
  }
}

/**
 * Guard a standalone admin decrement (used on full-offboard DELETE, where there's no
 * user-item write to bundle into the transaction). Backfills adminCount if absent,
 * reconciles phantom admins, then conditionally decrements; a floor hit is the 409.
 */
async function guardAdminDecrement(tenant: string): Promise<void> {
  await ensureAdminCount(tenant);
  await reconcileTenantAdmins(tenant, adminExists);
  try {
    await repo.decrementAdminCount(tenant);
  } catch (err) {
    if (err instanceof LastAdminError) throw new HttpError(409, 'cannot remove the last admin');
    throw err;
  }
}

/** Bound Cognito existence check passed into reconcile (stubbed offline via LOCAL_AUTH). */
const adminExists = (email: string): Promise<boolean> =>
  cognitoUserExists(cognito, USER_POOL_ID, email);

/** Backfill CONFIG.adminCount from authoritative memberships when it's not yet set. */
async function ensureAdminCount(tenant: string): Promise<void> {
  const cfg = await repo.getTenantConfig(tenant);
  if (cfg && typeof cfg.adminCount !== 'number') await repo.recountAdmins(tenant);
}
// ───────────────────────── Helpers ─────────────────────────

/** Today as an ISO date, for deadline comparisons against stored `YYYY-MM-DD`. */
const today = () => new Date().toISOString().slice(0, 10);

/** Whether a patch touches any Live-Academic-Tracker metric (so "assessed at" restamps). */
function hasSnapshot(p: {
  lectureAttendance?: unknown;
  tutorialAttendance?: unknown;
  assignmentCompletion?: unknown;
  semesterAverage?: unknown;
  facultyWarning?: unknown;
}): boolean {
  return (
    p.lectureAttendance !== undefined ||
    p.tutorialAttendance !== undefined ||
    p.assignmentCompletion !== undefined ||
    p.semesterAverage !== undefined ||
    p.facultyWarning !== undefined
  );
}

/**
 * A short, human-typable code for a ticket or parking pass — the fallback a gate
 * marshal keys in when a QR scan fails. Ambiguous characters (0/O, 1/I) are left
 * out of the alphabet so a code read off a phone screen can't be mis-typed.
 */
function shortCode(prefix: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let body = '';
  const bytes = randomBytes(4);
  for (let i = 0; i < 4; i++) body += alphabet[bytes[i] % alphabet.length];
  return `${prefix}-${body}`;
}

/** URL-safe slug from a name, shared by tournament and school id generation. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Canonical school id from a name. Shared by buildSchoolFromSpec and the public
 * signup's collision pre-check, which MUST slug exactly the way the id is built
 * ("St-Andrews" and "St Andrews" are distinct names but the same id).
 */
const schoolIdFromName = slugify;

/** The sport's squad bounds, falling back to a permissive range for an unknown code. */
function SQUAD_LIMITS_FOR(sportKey: string): { min: number; max: number } {
  return SQUAD_LIMITS[sportKey] ?? { min: 1, max: 60 };
}

/** Apply an entry patch under optimistic concurrency, mapping conflicts to 409. */
async function applyEntryPatch(
  tenant: string,
  tournamentId: string,
  schoolId: string,
  patch: Partial<Entry>,
  changedBy: string,
): Promise<Entry> {
  try {
    return await repo.updateEntry(tenant, tournamentId, schoolId, patch, changedBy, now());
  } catch (err) {
    if (err instanceof VersionConflictError) throw new HttpError(409, 'entry changed; refetch');
    if ((err as Error).message === 'entry not found') throw new HttpError(404, 'entry not found');
    throw err;
  }
}

/**
 * What an entrant school is allowed to see of a tournament. The organiser's
 * working state — an unreleased draw, uncaptured results, the entry-fee ledger —
 * stays out of the payload entirely rather than being hidden in the UI.
 */
function publicTournamentView(t: Tournament): Partial<Tournament> {
  const { fixtures, released, resultsReleased, ...rest } = t;
  return {
    ...rest,
    released,
    resultsReleased,
    // An unreleased draw isn't shown at all; a released one drops results until
    // the organiser publishes them.
    fixtures: !released
      ? []
      : resultsReleased
        ? fixtures
        : fixtures.map((f) => ({ ...f, result: null })),
  };
}

const COLORS = ['#1B2A4A', '#1D9E75', '#C8A84B', '#D85A30', '#2E4070', '#243356', '#8A6E1C'];

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}

/**
 * Build a directory record from what the organiser's add-school form (or the
 * public signup) sends. The flat `contactEmail`/`contactCell` fields are folded
 * into the nested `contact` object the rest of the app reads.
 */
function buildSchoolFromSpec(spec: SchoolSpec): School {
  const id = spec.id ?? schoolIdFromName(spec.name ?? 'school');
  const contact = {
    name: spec.contact?.name ?? '',
    role: spec.contact?.role ?? '',
    email: spec.contact?.email ?? spec.contactEmail ?? '',
    cell: spec.contact?.cell ?? spec.contactCell ?? '',
  };
  return {
    id,
    name: spec.name ?? 'New School',
    shortName: spec.shortName,
    town: spec.town ?? '',
    province: spec.province ?? '',
    type: spec.type,
    location: spec.location ?? {},
    contact,
    color: COLORS[Math.abs(hashCode(id)) % COLORS.length],
    entryCount: 0,
    addedAt: now(),
    version: 1,
  };
}

function fmtFixtureDate(iso?: string): string {
  if (!iso) return 'Date TBA';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Build the plain-text schedule one visiting school receives when the organiser
 * publishes the draw — its own fixtures only, in playing order, with the venue
 * and kick-off time it needs to plan the day.
 */
function buildSchoolSchedule(
  tournament: Tournament,
  schoolId: string,
  namesById: Map<string, string>,
): string {
  const mine = (tournament.fixtures ?? [])
    .filter((f) => f.home === schoolId || f.away === schoolId)
    .sort((a, b) => `${a.date}${a.time ?? ''}`.localeCompare(`${b.date}${b.time ?? ''}`));
  if (mine.length === 0) return '';
  const venueName = (id: string | null) =>
    tournament.venues?.find((v) => v.id === id)?.name ?? 'Venue TBA';
  const lines = [tournament.name];
  for (const f of mine) {
    const oppId = f.home === schoolId ? f.away : f.home;
    const opp = namesById.get(oppId) ?? 'TBA';
    const stage = f.stage === 'knockout' ? (f.roundName ?? 'Playoff') : `Pool ${f.pool ?? '?'}`;
    lines.push(
      `  ${stage} · ${fmtFixtureDate(f.date)}${f.time ? ` ${f.time}` : ''} · vs ${opp} · ${venueName(f.venueId)}`,
    );
  }
  return lines.join('\n');
}

/**
 * Collapse per-recipient send results into <=2 PII-free per-channel rows: one
 * `SendResult` (returned to the caller and stored on the idempotency marker for
 * replay, carrying the count in its dedicated `summary` field — never in `error`)
 * and one matching `CommEvent` with no recipient `to`. Keeps the marker and comm
 * log small and free of player PII. The summary counts only — it omits a total
 * denominator so a set of legitimately-skipped recipients doesn't read as a
 * partial failure.
 */
function summarizeBroadcast(
  results: SendResult[],
  channels: Channel[],
  by: string,
  idempotencyKey: string,
  kind: CommEvent['kind'],
): { summaryResults: SendResult[]; commEvents: CommEvent[] } {
  const at = now();
  const summaryResults: SendResult[] = [];
  const commEvents: CommEvent[] = [];
  for (const channel of channels) {
    const forCh = results.filter((r) => r.channel === channel);
    const sent = forCh.filter((r) => r.status === 'sent').length;
    const failed = forCh.filter((r) => r.status === 'failed').length;
    const skipped = forCh.filter((r) => r.status === 'skipped').length;
    const status: SendResult['status'] = sent > 0 ? 'sent' : failed > 0 ? 'failed' : 'skipped';
    const parts = [`${sent} sent`];
    if (skipped) parts.push(`${skipped} skipped`);
    if (failed) parts.push(`${failed} failed`);
    const summary = parts.join(' · ');
    summaryResults.push({ channel, status, summary });
    commEvents.push({
      id: randomUUID(),
      channel,
      status,
      at,
      by,
      idempotencyKey,
      kind,
      summary,
    });
  }
  return { summaryResults, commEvents };
}

// ───────────────────────── Error handling ─────────────────────────

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error('unhandled error', err);
  return c.json({ error: 'internal error' }, 500);
});

export const handler = handle(app);
// Exported so the local dev server (src/local/server.ts) can serve the same app.
export { app };
