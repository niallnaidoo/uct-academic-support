/** Domain types shared across the API. Mirrors the frontend's data shapes. */

/**
 * `admin`  — host-school staff running the tournament (sees everything).
 * `rep`    — a visiting school's contact, scoped to that school's own entries.
 */
export type Role = 'admin' | 'rep';

export interface Membership {
  tenantId: string;
  role: Role;
  /** Schools a rep is scoped to. Ignored for admins (who see the whole tenant). */
  schoolIds: string[];
  /** When this membership was created via an organiser invite (ISO). */
  invitedAt?: string;
  /** Email of the organiser who issued the invite. */
  invitedBy?: string;
}

export interface UserProfile {
  sub: string;
  email: string;
  memberships: Membership[];
  onboardingSeen: Record<string, boolean>;
  /**
   * First-ever sign-in timestamp (ISO), stamped once per user lifetime by the
   * PreTokenGen trigger. Absent ⇒ the user has been invited but never signed in
   * (status 'pending'). Drives the Team & Access "Active / Not signed in" pill.
   */
  lastLoginAt?: string;
}

/** A playing surface at the host school. Lives inside TenantConfig and on a tournament. */
export interface Venue {
  id: string;
  name: string;
  /** Field / Astro / Court / Pool / Track / Hall / Nets. */
  kind: string;
  lat?: number;
  lon?: number;
  capacity?: number;
  /** Taken out of service for this event (resurfacing, waterlogged) without deleting it. */
  unavailable?: boolean;
  note?: string;
}

export interface TenantConfig {
  tenant: string;
  branding: {
    name: string;
    /** Human title for <title> and headers, e.g. "Riverside College Sport". */
    title: string;
    logoUrl: string;
    /** CSS color tokens injected at the edge, e.g. { '--navy': '#1B2A4A' }. */
    colors: Record<string, string>;
    /** Org copy strings keyed by slot (welcome, eyebrow, office, footer, support). */
    copy: Record<string, string>;
  };
  /** The host school's own details — used for travel distances and the entry pack. */
  host: {
    schoolName: string;
    town?: string;
    province?: string;
    lat?: number;
    lon?: number;
    contactEmail?: string;
    contactCell?: string;
  };
  /** The host school's playing surfaces — the pool a tournament draws its venues from. */
  venues: Venue[];
  /**
   * Pointer to the tenant-wide school self-signup token (TOKEN# item, kind
   * 'school-signup'). Single active link per tenant; regenerating revokes the
   * prior token. Written ONLY via repo.updateSchoolSignupLink (targeted update) —
   * PUT /tenant/config strips it from patches so a concurrent Settings save can't
   * resurrect a revoked link.
   */
  schoolSignupLink?: { token: string; createdAt: string };
  /** Optional per-tenant entry-doc default; a tournament may narrow it further. */
  defaultEntryDocs?: string[];
  /**
   * Authoritative count of admins for this tenant, maintained transactionally on
   * the CONFIG item so the last-admin lockout guard is race-free (no TOCTOU on a
   * point-in-time list). Absent on legacy tenants → lazily backfilled by
   * repo.recountAdmins from authoritative memberships before the guard runs.
   */
  adminCount?: number;
}

/**
 * A visiting school in the persistent directory. Deliberately thin: everything
 * tournament-specific (status, pool, docs, squad) lives on the Entry, so a school
 * that returns next season carries no stale state with it.
 */
export interface School {
  id: string;
  name: string;
  shortName?: string;
  town?: string;
  province?: string;
  /** Public / Independent / Semi-private / Combined / Primary. */
  type?: string;
  location?: { lat?: number; lon?: number };
  contact?: {
    name?: string;
    role?: string;
    email?: string;
    cell?: string;
  };
  logoUrl?: string;
  color?: string;
  /** Organiser notes on the school itself (not on one entry), newest-last. */
  notes?: { id: string; text: string; author: string; at: string }[];
  /** Real invitation send events (email/WhatsApp), appended via list_append. */
  commLog?: CommEvent[];
  /** Denormalized count of entries lodged, bumped as entries are created. */
  entryCount?: number;
  /** Marks a school loaded from the demo snapshot; gates illustrative-only UI. */
  demo?: boolean;
  addedAt?: string;
  /** Provenance: set when the school registered itself via the public signup link. */
  addedVia?: 'self-signup';
  /** When the signing-up rep ticked the POPIA consent line (ISO). Self-signups only. */
  signupConsentAt?: string;
  /** Optimistic-concurrency version + audit trail. */
  version: number;
  changedBy?: string;
  changedAt?: string;
}

/** Outbound invite channels. */
export type Channel = 'email' | 'whatsapp';

/** Per-channel outcome of a send (returned to the client + stored on the marker). */
export interface SendResult {
  channel: Channel;
  status: 'sent' | 'failed' | 'skipped';
  /** Recipient the send targeted (email / E.164 cell). Omitted on a skip with no value on file. */
  to?: string;
  messageId?: string;
  /** Reason a send did not succeed (validation skip or provider error). Never set on success. */
  error?: string;
  /** Aggregate, human-readable outcome for a broadcast summary row (e.g. "8 sent · 2 skipped"). */
  summary?: string;
}

/** One real outbound send (invitation, doc chase or draw broadcast), in a school's comm log. */
export interface CommEvent {
  id: string;
  channel: Channel;
  /** Recipient the send targeted. Omitted on a skip with no value, and on broadcast summaries. */
  to?: string;
  status: 'sent' | 'failed' | 'skipped';
  /** Provider message id when sent (SES MessageId / Meta message id). */
  messageId?: string;
  /** Reason when not sent (validation skip or provider error). */
  error?: string;
  at: string;
  by: string;
  /** Ties the event back to the idempotency-keyed send attempt. */
  idempotencyKey: string;
  /**
   * What was sent. Absent ⇒ 'invite'. A 'draw' or 'docs' broadcast is recorded as
   * one PII-free summary event per channel, not one row per recipient.
   */
  kind?: 'invite' | 'draw' | 'docs' | 'results';
  /** Aggregate, PII-free outcome for a broadcast, e.g. "8 sent · 2 skipped". */
  summary?: string;
}

/** Add-school payload: a School plus the flat contact fields the organiser form sends. */
export type SchoolSpec = Partial<School> & {
  contactEmail?: string;
  contactCell?: string;
};

/* ──────────────────────────── Tournaments ───────────────────────────────── */

export type TournamentStatus = 'draft' | 'open' | 'closed' | 'live' | 'complete';
export type TournamentFormat = 'pool_playoff' | 'round_robin' | 'knockout' | 'meet';

/** A scheduled match. Pool fixtures carry a pool; knockout fixtures carry feeds. */
export interface Fixture {
  id: string;
  stage: 'pool' | 'knockout';
  pool: string | null;
  round: number;
  roundName?: string;
  date: string;
  /** Entry (school) ids, or a knockout placeholder like "A1" until pools resolve. */
  home: string;
  away: string;
  /** Fixture ids whose winners fill this bracket slot. */
  feedHome?: string | null;
  feedAway?: string | null;
  venueId: string | null;
  time: string | null;
  result: FixtureResult | null;
}

export interface FixtureResult {
  status: 'played' | 'forfeit' | 'abandoned';
  homeScore?: number;
  awayScore?: number;
  /** The team that forfeited — required when status is 'forfeit'. */
  forfeitBy?: string;
  /** Bonus points, awarded explicitly on capture and never inferred. */
  bonusHome?: number;
  bonusAway?: number;
  /** Sport-specific per-side extras (tries, short corners, wickets…). */
  extras?: { home?: Record<string, number>; away?: Record<string, number> };
  capturedAt?: string;
  capturedBy?: string;
}

export interface Tournament {
  id: string;
  name: string;
  /** A key from catalogue.SPORT_KEYS. */
  sport: string;
  season: string;
  /** Boys / Girls / Mixed / Open. */
  section?: string;
  ageGroup?: string;
  format: TournamentFormat;
  poolCount?: number;
  startDate: string;
  endDate?: string;
  entryDeadline?: string;
  entryFee?: number;
  maxEntrants?: number;
  /** Subset of the host's venues allocated to this event. */
  venues: Venue[];
  /** Entry-pack doc keys required for this event (subset of catalogue.DOC_KEYS). */
  entryDocs: string[];
  /** Sport match shape overrides (format, overs, match minutes). */
  matchConfig?: Record<string, unknown>;
  /** Log points config; defaults from the sport when absent. */
  points?: Record<string, number>;
  tiebreakers?: string[];
  status: TournamentStatus;
  fixtures: Fixture[];
  /** Whether the draw is visible to entrant schools. */
  released: boolean;
  releasedAt: string | null;
  /** Whether results/log tables are visible to entrant schools. */
  resultsReleased?: boolean;
  /** Denormalized accepted-entry count, so the list view needs no per-row query. */
  entryCount?: number;
  version: number;
  changedBy?: string;
  changedAt?: string;
}

/* ─────────────────────────────── Entries ────────────────────────────────── */

export type EntryStatus = 'pending' | 'accepted' | 'waitlisted' | 'declined' | 'withdrawn';

/**
 * One school's entry into one tournament. The canonical item lives in the
 * TOURNAMENT partition (sk `ENTRY#<schoolId>`); a mirror under the school gives
 * the reverse lookup. Both are written in the same transaction.
 */
export interface Entry {
  tournamentId: string;
  schoolId: string;
  /** Denormalized for display so the inbox needs no per-row school fetch. */
  schoolName: string;
  /** What this school calls the side it is entering, e.g. "Kearsney 1st XI". */
  teamName?: string;
  status: EntryStatus;
  /** Which pool the organiser drew them into, and their seeding for the snake. */
  pool?: string | null;
  seed?: number | null;
  /** Per-doc satisfied flags, keyed by entry-doc key. */
  docs: Record<string, boolean>;
  /**
   * Per-doc upload metadata. Single-file docs store one
   * `{ objectKey, size, contentType?, uploadedAt }` (or an organiser
   * `{ markedCompliant, at }` sentinel). Multi-file docs (safeguarding, medical)
   * store `{ files: [...entries], markedCompliant?, at? }` — see fileSetMeta.
   */
  docMeta?: Record<string, unknown>;
  /** Denormalized squad size, bumped atomically on each player registration. */
  playerCount?: number;
  contact?: {
    name?: string;
    role?: string;
    email?: string;
    cell?: string;
  };
  /** Travel/logistics the host needs to plan catering and parking. */
  logistics?: {
    arrivalDate?: string;
    arrivalTime?: string;
    transport?: string;
    partySize?: number;
    /** Staying over rather than travelling on the day. */
    overnight?: boolean;
    accommodation?: string;
    dietaryNotes?: string;
  };
  entryFeePaid?: boolean;
  paidAt?: string;
  /** Set when the school submits — an unsubmitted entry is still a draft. */
  submittedAt?: string;
  /** Organiser decision audit. */
  decidedAt?: string;
  decidedBy?: string;
  declineReason?: string;
  /** Per-entry squad-registration link handed to the visiting school. */
  squadRegLink?: { token: string; createdAt: string };
  /** Organiser notes on this entry, newest-last. */
  notes?: { id: string; text: string; author: string; at: string }[];
  demo?: boolean;
  createdAt?: string;
  version: number;
  changedBy?: string;
  changedAt?: string;
}

/* ─────────────────────────────── Players ────────────────────────────────── */

/** Stored object metadata for a player's uploaded ID/age document. */
export interface PlayerIdDocMeta {
  objectKey: string;
  size: number;
  uploadedAt: string;
  /** MIME type the file was signed/stored as (ID docs allow image/* or PDF). */
  contentType?: string;
}

export type PlayerStatus = 'registered' | 'withdrawn' | 'injured';

/**
 * A squad member registered against one entry. Squads are tournament-specific,
 * so a player row belongs to a (tournament, school) pair, not to a school.
 */
export interface PlayerRegistration {
  naturalKey: string;
  tournamentId: string;
  schoolId: string;
  firstName: string;
  lastName: string;
  dob: string;
  cell?: string;
  email?: string;
  isMinor: boolean;
  guardianName?: string;
  guardianCell?: string;
  /** POPIA consent timestamp — required for every minor. */
  consentAt: string;
  createdAt: string;
  /** 13-digit RSA ID. `dob` is derived from it on the portal path. */
  idNumber?: string;
  gender?: string;
  /** Shirt/squad number for the programme and the scoreboard. */
  jerseyNumber?: number;
  /** A position from the sport's `positions` list. */
  position?: string;
  isCaptain?: boolean;
  /** Rugby junior age groups gate on mass, not age alone. */
  massKg?: number;
  /** Medical detail the host's on-site staff need. */
  medicalNotes?: string;
  allergies?: string;
  medicalAidNumber?: string;
  idDocMeta?: PlayerIdDocMeta;
  /** Squad lifecycle. Absent ⇒ treated as 'registered'. */
  status?: PlayerStatus;
  /** Email of the school rep who registered the player via the portal. */
  registeredBy?: string;
  /** Which path created the row. Absent ⇒ 'link'. */
  registeredVia?: 'link' | 'portal';
  /** Optimistic-concurrency version. Absent on legacy rows → treated as 0. */
  version?: number;
}

/** A single scored performance at a meet (athletics/swimming). */
export interface MeetResult {
  id: string;
  tournamentId: string;
  eventId: string;
  eventName: string;
  schoolId: string;
  /** Player natural key, when the result is attributed to an individual. */
  playerKey?: string;
  playerName?: string;
  place: number;
  /** Time or distance as recorded, kept as text so "10.42" and "1:58.3" both round-trip. */
  mark?: string;
  ageGroup?: string;
  capturedAt?: string;
  capturedBy?: string;
}

/* ═══════════════════════ Venue assessment (facilities module) ════════════ */

/** One scored line inside an assessment. `score` is 0–5; 0 means "not present". */
export interface AssessmentScore {
  /** A category key from catalogue.ASSESSMENT_CATEGORIES. */
  key: string;
  score: number;
  note?: string;
}

/** A follow-up action raised by an assessment (a defect to fix before match day). */
export interface AssessmentAction {
  id: string;
  text: string;
  priority: 'low' | 'medium' | 'high';
  done: boolean;
  dueDate?: string;
}

/**
 * A dated facility audit of one venue. The overall rating is computed on the
 * client from the scores (thin-API convention); it is stored too so the list
 * view needs no recompute, but the scores remain the source of truth.
 */
export interface VenueAssessment {
  id: string;
  venueId: string;
  /** Denormalized for the list view so it needs no venue fetch. */
  venueName: string;
  /** ISO date the assessment was carried out. */
  assessedAt: string;
  assessedBy?: string;
  scores: AssessmentScore[];
  actions: AssessmentAction[];
  /** 0–100, computed from the scores; stored for the list. */
  overall: number;
  /** ready | conditional | not_ready — the headline verdict. */
  verdict: 'ready' | 'conditional' | 'not_ready';
  notes?: string;
  /** Uploaded photo object keys (S3), same presign pattern as entry-pack docs. */
  photos?: PlayerIdDocMeta[];
  createdAt: string;
  version: number;
  changedBy?: string;
  changedAt?: string;
}

/* ═══════════════════════════════ Ticketing module ════════════════════════ */

/**
 * An event tickets are sold against. Usually a tournament (so `tournamentId` is
 * set), but can be a standalone fixture or open day (name + date only).
 */
export interface TicketType {
  id: string;
  eventId: string;
  eventName: string;
  /** Set when the event is a tournament in this platform. */
  tournamentId?: string;
  name: string;
  /** Price in ZAR cents, so no floating-point money. 0 = free tier. */
  priceCents: number;
  capacity: number;
  /** Denormalized count of issued (non-void) tickets, for the "sold" column. */
  sold?: number;
  /** Whether this tier is on sale. */
  active: boolean;
  createdAt: string;
  version: number;
}

export type TicketStatus = 'valid' | 'checked_in' | 'void';
export type PaymentStatus = 'unpaid' | 'paid' | 'comp' | 'refunded';

/** An issued ticket. The QR token is the gate credential. */
export interface Ticket {
  id: string;
  eventId: string;
  ticketTypeId: string;
  /** Denormalized so the list and the gate screen need no type fetch. */
  ticketTypeName: string;
  priceCents: number;
  buyerName: string;
  buyerEmail?: string;
  buyerCell?: string;
  /** A visiting school, when the ticket was allocated to a touring party. */
  schoolId?: string;
  quantity: number;
  status: TicketStatus;
  payment: PaymentStatus;
  /** The scannable gate credential — also a global TOKEN# item for lookup. */
  qrToken: string;
  /** Short human code (e.g. "RC-8FQ2") a marshal can type if the scan fails. */
  code: string;
  checkedInAt?: string;
  checkedInBy?: string;
  issuedAt: string;
  issuedBy?: string;
  version: number;
}

/* ═══════════════════════════════ Parking module ══════════════════════════ */

export type ParkingZoneKind = 'visiting_school' | 'vip' | 'bus' | 'general' | 'staff' | 'disabled';

/** A parking zone at the host, with a capacity and an intended use. */
export interface ParkingZone {
  id: string;
  name: string;
  kind: ParkingZoneKind;
  capacity: number;
  /** Denormalized count of passes allocated to this zone. */
  allocated?: number;
  note?: string;
  createdAt: string;
  version: number;
}

/* ═══════════════════ Academic support (university module) ════════════════ */

export type YesNo = 'Yes' | 'No';

/**
 * A student-athlete on the academic-support programme (the tracker's Player
 * Database + the Live Academic Tracker row, folded into one record). The
 * academic metrics are embedded and the RAG risk is computed from them on the
 * client (see src/academic-model.js), so the roster reads a single item.
 *
 * This is sensitive academic PII: access rides POPIA consent (the SOP's consent
 * form), and tenant erasure sweeps it.
 */
export interface StudentAthlete {
  id: string;
  firstName: string;
  lastName: string;
  /** UCT student number, e.g. "ANDCHR020". */
  studentNumber: string;
  /** 13-digit RSA ID, optional. */
  saId?: string;
  /** 1st Team / U20s / Both / General. */
  squad: string;
  faculty?: string;
  degree?: string;
  yearOfStudy?: string;
  /** Credits carried this year — drives Varsity Cup eligibility (≥60). */
  creditsRegistered?: number;
  /** Assigned academic mentor (free text — a mentor is a staff member, not a user). */
  mentor?: string;
  /** The SOP's manual categorisation: high / medium / low. */
  riskCategory?: 'high' | 'medium' | 'low';

  // ── Live Academic Tracker snapshot (0–100 metrics) ──
  lectureAttendance?: number;
  tutorialAttendance?: number;
  assignmentCompletion?: number;
  semesterAverage?: number;
  facultyWarning?: YesNo;
  /** When the snapshot above was last captured. */
  assessedAt?: string;

  /** POPIA consent to access academic records (the SOP's consent form). */
  consentAt?: string;
  status?: 'active' | 'graduated' | 'withdrawn';
  notes?: string;
  createdAt?: string;
  version: number;
  changedBy?: string;
  changedAt?: string;
}

/**
 * A bi-weekly academic check-in. The 13 review questions live in `answers`
 * (Yes/No/"N/A"), keyed by CHECKIN_QUESTIONS in the model.
 */
/**
 * A single agreed 1–5 rating on the development scale. (Older plans stored a
 * {self, mentor} pair; both shapes are accepted, see catalogue.validateCheckIn.)
 */
export type AdpRating = number | { self?: number; mentor?: number };

/** An external academic mentor — never logs in; completes plans via a tokenised link. */
export interface Mentor {
  id: string;
  name: string;
  email: string;
  phone?: string;
  organisation?: string;
  createdAt?: string;
  createdBy?: string;
  version: number;
}

/** How far a plan has moved: assigned to a mentor, sent, or completed. */
export type PlanStatus = 'draft' | 'sent' | 'completed';

/** One module in the plan: quick screener answers + resulting status. */
export interface AdpModule {
  code: string;
  name?: string;
  status?: 'on_track' | 'watch' | 'at_risk';
  screener?: Record<string, string>;
  /** Enrichment from the UCT course catalogue, when the code is recognised. */
  convener?: string;
  credits?: number;
  faculty?: string;
  nqf?: number;
  /** Auto-assigned intrinsic difficulty, 1 (gentle) – 5 (very hard). */
  difficulty?: number;
}

/** A dev section's ratings — keyed per module (scope 'module') or flat (student). */
export interface AdpSection {
  modules?: Record<string, Record<string, AdpRating>>;
  ratings?: Record<string, AdpRating>;
  note?: string;
}

/** One planned intervention drawn from the LMS-style catalogue. */
export interface AdpIntervention {
  type: string;
  module?: string;
  referredTo?: string;
  owner?: string;
  dueDate?: string;
  note?: string;
}

export interface AcademicCheckIn {
  id: string;
  studentNumber: string;
  athleteName: string;
  date: string;
  mentor?: string;
  riskLevel?: string;
  followUpRequired?: YesNo;
  answers: Record<string, string>;
  note?: string;
  /** 'adp' marks a full Academic Development Plan; legacy check-ins omit it. */
  kind?: string;
  /** Free-text term/block the plan covers, e.g. "Block 3 2026". */
  period?: string;
  modules?: AdpModule[];
  sections?: Record<string, AdpSection>;
  plan?: AdpIntervention[];
  /** The external mentor this plan is assigned to, and their email. */
  mentorEmail?: string;
  /** draft (admin) · sent (mentor has the link) · completed (mentor submitted). */
  planStatus?: PlanStatus;
  /** Opaque token for the mentor's public completion link. */
  token?: string;
  /** When the mentor is next scheduled to see the athlete (ISO date). */
  scheduledNext?: string;
  sentAt?: string;
  completedAt?: string;
  createdAt?: string;
  createdBy?: string;
  version: number;
}

export type InterventionStatus = 'open' | 'in_progress' | 'resolved';

/** An academic intervention: concern → action → follow-up, per the SOP escalation. */
export interface AcademicIntervention {
  id: string;
  studentNumber: string;
  athleteName: string;
  date: string;
  concern: string;
  actionTaken?: string;
  /** University support structure the student was referred to, if any. */
  referredTo?: string;
  followUpDate?: string;
  status: InterventionStatus;
  raisedBy?: string;
  createdAt?: string;
  version: number;
  changedBy?: string;
  changedAt?: string;
}

export type ParkingPassStatus = 'allocated' | 'arrived' | 'void';

/** A parking pass: a zone, who it's for, an arrival slot, and a QR credential. */
export interface ParkingPass {
  id: string;
  zoneId: string;
  zoneName: string;
  /** The event/tournament this pass is for. */
  eventId: string;
  /** Who it's allocated to — a visiting school, or a free-text name for VIP/staff. */
  schoolId?: string;
  allocatedTo: string;
  vehicle?: string;
  registration?: string;
  bays: number;
  arrivalSlot?: string;
  status: ParkingPassStatus;
  qrToken: string;
  code: string;
  arrivedAt?: string;
  arrivedBy?: string;
  issuedAt: string;
  issuedBy?: string;
  version: number;
}
