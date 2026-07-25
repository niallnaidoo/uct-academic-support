/**
 * DynamoDB key builders — the single source of truth for the tenant-scoped
 * single-table layout. Every tenant-owned item is partitioned under
 * `TENANT#<t>#…`; this prefix IS the tenant-isolation boundary, so all reads and
 * writes must go through these helpers and never hand-build a key.
 *
 * Domain shape:
 *   SCHOOL      — the persistent directory of visiting schools (recurs season to season)
 *   TOURNAMENT  — one hosted event; embeds its venues, draw config and fixtures
 *   ENTRY       — a (tournament, school) pair: status, pool, entry-pack docs
 *   PLAYER      — a squad member, registered against one entry
 *
 * Entries and their players live in the TOURNAMENT partition, so the organiser's
 * two hot reads — "every entry for this tournament" and "this team's squad" —
 * are each a single query with no cross-partition fan-out. A mirror item under
 * the school gives the reverse lookup without a scan.
 *
 * See docs/architecture/data-model.md for the full access-pattern → key mapping.
 */

export type EntityType = 'SCHOOL' | 'TOURNAMENT' | 'USER';

const tenantPrefix = (tenant: string) => `TENANT#${tenant}`;

/** Tenant config item (branding, host details, venues, default entry docs). */
export const tenantConfigKey = (tenant: string) => ({
  pk: tenantPrefix(tenant),
  sk: 'CONFIG',
});

/* ────────────────────────────── Schools ─────────────────────────────────── */

/** A single visiting school in the directory. */
export const schoolKey = (tenant: string, schoolId: string) => ({
  pk: `${tenantPrefix(tenant)}#SCHOOL#${schoolId}`,
  sk: 'META',
});

/** gsi1 attributes that make a school listable within its tenant. */
export const schoolGsi1 = (tenant: string, name: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#SCHOOL`,
  gsi1sk: name,
});

/** gsi1pk used to query every school in a tenant. */
export const schoolsListGsi1pk = (tenant: string) => `${tenantPrefix(tenant)}#TYPE#SCHOOL`;

/**
 * Idempotency marker for an organiser "send invitation" click. Lives in the
 * school's item collection (same pk, distinct sk) so it's tenant-isolated, but
 * carries no gsi1, so it never surfaces in getSchool/listSchools. Because the
 * marker stores recipient contact in its results, tenant erasure must enumerate
 * it explicitly via `listSchoolInviteKeys` — the gsi1-based erase set misses it.
 * The `attribute_not_exists` claim on this key is the double-send guard.
 */
export const schoolInviteKey = (tenant: string, schoolId: string, idempotencyKey: string) => ({
  pk: `${tenantPrefix(tenant)}#SCHOOL#${schoolId}`,
  sk: `INVITE#${idempotencyKey}`,
});

/* ──────────────────────────── Tournaments ───────────────────────────────── */

/** A single tournament (venues, draw config and fixtures embedded). */
export const tournamentKey = (tenant: string, tournamentId: string) => ({
  pk: `${tenantPrefix(tenant)}#TOURNAMENT#${tournamentId}`,
  sk: 'META',
});

/** Sorted by start date so the organiser's list is chronological for free. */
export const tournamentGsi1 = (tenant: string, startDate: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#TOURNAMENT`,
  gsi1sk: startDate ?? '',
});

export const tournamentsListGsi1pk = (tenant: string) => `${tenantPrefix(tenant)}#TYPE#TOURNAMENT`;

/* ────────────────────────────── Entries ─────────────────────────────────── */

/**
 * A school's entry into a tournament — canonical item, in the TOURNAMENT
 * partition. One school enters a given tournament at most once, so the school id
 * in the sort key doubles as the uniqueness constraint: a conditional put on
 * `attribute_not_exists(sk)` makes a duplicate entry structurally impossible.
 */
export const entryKey = (tenant: string, tournamentId: string, schoolId: string) => ({
  pk: `${tenantPrefix(tenant)}#TOURNAMENT#${tournamentId}`,
  sk: `ENTRY#${schoolId}`,
});

/** pk + sk-prefix to query every entry in a tournament (the organiser's inbox). */
export const entriesListKey = (tenant: string, tournamentId: string) => ({
  pk: `${tenantPrefix(tenant)}#TOURNAMENT#${tournamentId}`,
  skPrefix: 'ENTRY#',
});

/**
 * Mirror pointer under the SCHOOL, so "which tournaments has this school
 * entered" reads the school's own partition instead of scanning every
 * tournament. Carries NO gsi1 — the canonical entry above is the one that
 * counts, and a second index entry would double-count every organiser listing.
 * Kept in sync with the canonical inside the same transaction.
 */
export const schoolEntryKey = (tenant: string, schoolId: string, tournamentId: string) => ({
  pk: `${tenantPrefix(tenant)}#SCHOOL#${schoolId}`,
  sk: `ENTRY#${tournamentId}`,
});

/** pk + sk-prefix to query every tournament a school has entered. */
export const schoolEntriesListKey = (tenant: string, schoolId: string) => ({
  pk: `${tenantPrefix(tenant)}#SCHOOL#${schoolId}`,
  skPrefix: 'ENTRY#',
});

/* ────────────────────────────── Players ─────────────────────────────────── */

/**
 * A squad member, registered against one entry. Squads are tournament-specific
 * (a school brings a different side to the U14 festival than to the U16 one), so
 * players hang off the TOURNAMENT partition, namespaced by school.
 *
 * `<naturalKey>` (ID number or cell) gives dedup: the portal and the public
 * registration link share one natural key, so a player can't be registered twice
 * for the same entry.
 */
export const playerKey = (
  tenant: string,
  tournamentId: string,
  schoolId: string,
  naturalKey: string,
) => ({
  pk: `${tenantPrefix(tenant)}#TOURNAMENT#${tournamentId}`,
  sk: `PLAYER#${schoolId}#${naturalKey}`,
});

/** pk + sk-prefix to query one entry's squad. */
export const squadListKey = (tenant: string, tournamentId: string, schoolId: string) => ({
  pk: `${tenantPrefix(tenant)}#TOURNAMENT#${tournamentId}`,
  skPrefix: `PLAYER#${schoolId}#`,
});

/** pk + sk-prefix to query every player across a tournament (age-audit export). */
export const allPlayersListKey = (tenant: string, tournamentId: string) => ({
  pk: `${tenantPrefix(tenant)}#TOURNAMENT#${tournamentId}`,
  skPrefix: 'PLAYER#',
});

/* ────────────────────────────── Tokens ──────────────────────────────────── */

/**
 * Squad-registration link token. GLOBAL (not tenant-prefixed) and
 * self-describing: the item carries { tenant, tournamentId, schoolId } so the
 * public /register route resolves scope from the token, never from the request
 * host. Deleted on regeneration so old links stop working.
 */
export const tokenKey = (token: string) => ({
  pk: `TOKEN#${token}`,
  sk: 'META',
});

/* ─────────────────────── Venue assessments (facilities module) ───────────── */

/**
 * A dated facility audit of one of the host's venues. Keyed by its own id, and
 * carries `venueId` in the body; listed tenant-wide via gsi1 (sorted by date,
 * newest-first is the caller's job). A venue can have many assessments over time,
 * so this is a first-class entity, not nested on the venue.
 */
export const assessmentKey = (tenant: string, assessmentId: string) => ({
  pk: `${tenantPrefix(tenant)}#ASSESSMENT#${assessmentId}`,
  sk: 'META',
});

export const assessmentGsi1 = (tenant: string, assessedAt: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#ASSESSMENT`,
  gsi1sk: assessedAt ?? '',
});

export const assessmentsListGsi1pk = (tenant: string) => `${tenantPrefix(tenant)}#TYPE#ASSESSMENT`;

/* ────────────────────────────── Ticketing module ────────────────────────── */

/** A ticket tier for an event — name, price, capacity. */
export const ticketTypeKey = (tenant: string, ticketTypeId: string) => ({
  pk: `${tenantPrefix(tenant)}#TICKETTYPE#${ticketTypeId}`,
  sk: 'META',
});

export const ticketTypeGsi1 = (tenant: string, eventId: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#TICKETTYPE`,
  gsi1sk: eventId ?? '',
});

export const ticketTypesListGsi1pk = (tenant: string) => `${tenantPrefix(tenant)}#TYPE#TICKETTYPE`;

/**
 * An issued ticket. Listed tenant-wide via gsi1 (gsi1sk = eventId so the sales
 * view can filter by event client-side). The QR token that a marshal scans at
 * the gate resolves through the GLOBAL token keyspace (see `tokenKey`), so
 * check-in never needs to know the tenant up front.
 */
export const ticketKey = (tenant: string, ticketId: string) => ({
  pk: `${tenantPrefix(tenant)}#TICKET#${ticketId}`,
  sk: 'META',
});

export const ticketGsi1 = (tenant: string, eventId: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#TICKET`,
  gsi1sk: eventId ?? '',
});

export const ticketsListGsi1pk = (tenant: string) => `${tenantPrefix(tenant)}#TYPE#TICKET`;

/* ─────────────────────────────── Parking module ─────────────────────────── */

/** A parking zone with a capacity and a kind (visiting-school / VIP / bus …). */
export const parkingZoneKey = (tenant: string, zoneId: string) => ({
  pk: `${tenantPrefix(tenant)}#PARKINGZONE#${zoneId}`,
  sk: 'META',
});

export const parkingZoneGsi1 = (tenant: string, name: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#PARKINGZONE`,
  gsi1sk: name ?? '',
});

export const parkingZonesListGsi1pk = (tenant: string) =>
  `${tenantPrefix(tenant)}#TYPE#PARKINGZONE`;

/** A parking pass allocated to a school / person, in a zone, for an arrival slot. */
export const parkingPassKey = (tenant: string, passId: string) => ({
  pk: `${tenantPrefix(tenant)}#PARKINGPASS#${passId}`,
  sk: 'META',
});

export const parkingPassGsi1 = (tenant: string, eventId: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#PARKINGPASS`,
  gsi1sk: eventId ?? '',
});

export const parkingPassesListGsi1pk = (tenant: string) =>
  `${tenantPrefix(tenant)}#TYPE#PARKINGPASS`;

/* ───────────────── Academic support (university module) ──────────────────── */

/**
 * A student-athlete on the academic-support programme. Embeds the current
 * academic snapshot (attendance, assignments, semester average, faculty warning)
 * so the roster and the risk view read one item. Listed tenant-wide via gsi1,
 * sorted by surname for a scannable roster.
 */
export const athleteKey = (tenant: string, athleteId: string) => ({
  pk: `${tenantPrefix(tenant)}#ATHLETE#${athleteId}`,
  sk: 'META',
});

export const athleteGsi1 = (tenant: string, sortName: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#ATHLETE`,
  gsi1sk: sortName ?? '',
});

export const athletesListGsi1pk = (tenant: string) => `${tenantPrefix(tenant)}#TYPE#ATHLETE`;

/** An external academic mentor (never logs in — completes plans via a link). */
export const mentorKey = (tenant: string, mentorId: string) => ({
  pk: `${tenantPrefix(tenant)}#MENTOR#${mentorId}`,
  sk: 'META',
});

export const mentorGsi1 = (tenant: string, sortName: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#MENTOR`,
  gsi1sk: sortName ?? '',
});

export const mentorsListGsi1pk = (tenant: string) => `${tenantPrefix(tenant)}#TYPE#MENTOR`;

/** A bi-weekly academic check-in for one athlete. gsi1sk is the date (newest sorts last). */
export const checkInKey = (tenant: string, checkInId: string) => ({
  pk: `${tenantPrefix(tenant)}#CHECKIN#${checkInId}`,
  sk: 'META',
});

export const checkInGsi1 = (tenant: string, date: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#CHECKIN`,
  gsi1sk: date ?? '',
});

export const checkInsListGsi1pk = (tenant: string) => `${tenantPrefix(tenant)}#TYPE#CHECKIN`;

/** An academic intervention (concern → action → follow-up) for one athlete. */
export const interventionKey = (tenant: string, interventionId: string) => ({
  pk: `${tenantPrefix(tenant)}#INTERVENTION#${interventionId}`,
  sk: 'META',
});

export const interventionGsi1 = (tenant: string, date: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#INTERVENTION`,
  gsi1sk: date ?? '',
});

export const interventionsListGsi1pk = (tenant: string) =>
  `${tenantPrefix(tenant)}#TYPE#INTERVENTION`;

/* ─────────────────────────────── Users ──────────────────────────────────── */

/** A user profile (memberships live here — source of truth for PreTokenGen). */
export const userKey = (sub: string) => ({
  pk: `USER#${sub}`,
  sk: 'META',
});

/**
 * Per-membership marker item: one per (user, tenant) so a user with multiple
 * memberships is enumerable under EVERY tenant they belong to (a single GSI on
 * the META item could only index one tenant). Listed via gsi1 for offboarding.
 */
export const userTenantMarkerKey = (sub: string, tenant: string) => ({
  pk: `USER#${sub}`,
  sk: `TENANT#${tenant}`,
});

/** gsi1 attributes that make a user-tenant marker listable within a tenant. */
export const userGsi1 = (tenant: string, email: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#USER`,
  gsi1sk: email,
});

export const usersListGsi1pk = (tenant: string) => `${tenantPrefix(tenant)}#TYPE#USER`;

/** Prefix used to erase an entire tenant's non-user items. */
export const tenantErasurePrefix = (tenant: string) => `${tenantPrefix(tenant)}#`;
