/**
 * Reusable tenant-seeding logic (no top-level execution), shared by the seed CLI
 * (seed.ts) and the local dev server (local/server.ts). Tenants are provisioned
 * BLANK (config only); sample schools/tournaments/entries are opt-in demo data.
 * Branding and the host's own details live here.
 */
import { readFileSync } from 'node:fs';
import * as repo from './repo.js';
import type {
  Entry,
  PlayerRegistration,
  School,
  Tournament,
  TenantConfig,
  Venue,
  VenueAssessment,
  TicketType,
  Ticket,
  ParkingZone,
  ParkingPass,
  StudentAthlete,
  AcademicCheckIn,
  AcademicIntervention,
} from './types.js';

interface Snapshot {
  host: TenantConfig['host'];
  venues: Venue[];
  schools: School[];
  tournaments: Tournament[];
  entries?: Entry[];
  players?: PlayerRegistration[];
  assessments?: VenueAssessment[];
  ticketTypes?: TicketType[];
  tickets?: Ticket[];
  parkingZones?: ParkingZone[];
  parkingPasses?: ParkingPass[];
  athletes?: StudentAthlete[];
  checkIns?: AcademicCheckIn[];
  interventions?: AcademicIntervention[];
}

/**
 * Colour tokens injected onto :root at the edge. A host school swaps these for
 * its own colours in Settings; these are the shipped defaults.
 */
const COLORS = {
  '--navy': '#16273F',
  '--navy-light': '#2C4667',
  '--teal': '#1D9E75',
  '--green': '#1D9E75',
  '--gold': '#C8A84B',
  '--coral': '#D85A30',
};

export const BRANDING: Record<string, TenantConfig['branding']> = {
  school: {
    name: 'Riverside College',
    title: 'Riverside Tournaments',
    logoUrl: '/school-logo.png',
    colors: COLORS,
    copy: {
      welcome: 'Welcome to Riverside Tournaments',
      eyebrow: 'Riverside College · Invitational Sport',
      office: 'Sport office',
      admin: 'Tournament organiser',
      support: 'Sport office · sport@riverside.example.ac.za',
      footer: 'Powered by Medicoach',
    },
  },
};

export const SEED_TENANTS = Object.keys(BRANDING);

function loadSnapshot(tenant: string): Snapshot {
  const path = new URL(`../seed-data/${tenant}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
}

/**
 * Provision a tenant: write its config (branding + host details + venue list).
 *
 * The DATA (schools, tournaments, entries) starts BLANK — a real host adds its
 * own. But the venue list is real, host-specific REFERENCE data (a school's
 * fields don't change season to season), so it is provisioned here from the
 * snapshot and ships in production. Returns the number of venues seeded.
 */
export async function seedTenantConfig(tenant: string): Promise<number> {
  const branding = BRANDING[tenant];
  if (!branding) throw new Error(`no branding for tenant "${tenant}"`);
  const snap = loadSnapshot(tenant);
  const venues = snap.venues ?? [];
  const config: TenantConfig = {
    tenant,
    branding,
    host: snap.host,
    venues,
  };
  await repo.putTenantConfig(config);
  return venues.length;
}

/**
 * Outcome of a venues-only backfill, kept tri-state on purpose: a single boolean
 * would conflate "already populated" (healthy) with "no CONFIG row" (broken
 * tenant) and give the operator a false all-clear. The CLI maps each case to
 * distinct output / exit code.
 */
export type VenuesBackfillResult =
  | { status: 'config-missing' }
  | { status: 'already-populated'; count: number }
  | { status: 'empty-skipped'; count: number }
  | { status: 'backfilled'; count: number };

/**
 * Repair ONLY a tenant's venue list from its snapshot, without touching branding,
 * host details or adminCount — a manual one-shot repair for a stage whose CONFIG
 * predates the venue list (NOT an automatic post-deploy step). Reads first to
 * decide policy:
 *
 *   • no CONFIG row    → 'config-missing' (caller surfaces a loud error; run full seed)
 *   • venues non-empty → 'already-populated' (idempotent no-op)
 *   • venues `[]`      → 'empty-skipped' unless `force` — an empty list is a valid
 *                        choice (PUT /tenant/config accepts it), so we don't silently
 *                        refill it; `force` overrides for a deliberate repair
 *   • venues absent    → 'backfilled' (the "never seeded" case)
 *
 * The write itself is race-guarded (see repo.backfillVenues) so a concurrent
 * organiser save between our read and write can't be clobbered.
 */
export async function seedVenuesOnly(tenant: string, force = false): Promise<VenuesBackfillResult> {
  const current = await repo.getTenantConfig(tenant);
  if (!current) return { status: 'config-missing' };
  const existing = current.venues;
  if (Array.isArray(existing) && existing.length > 0)
    return { status: 'already-populated', count: existing.length };
  if (Array.isArray(existing) && existing.length === 0 && !force)
    return { status: 'empty-skipped', count: 0 };
  const snapVenues = loadSnapshot(tenant).venues ?? [];
  const written = await repo.backfillVenues(tenant, snapVenues, force);
  if (written) return { status: 'backfilled', count: snapVenues.length };
  // Guard fired between our read and our write — a concurrent organiser save (or a
  // deleted CONFIG) changed the row. Don't report a backfill that didn't happen:
  // re-read and tell the truth. Non-force ⇒ the list became non-empty; force ⇒ the
  // only way the guard (attribute_exists(pk)) fails is the row vanished.
  const after = await repo.getTenantConfig(tenant);
  if (!after) return { status: 'config-missing' };
  return { status: 'already-populated', count: after.venues?.length ?? 0 };
}

/**
 * Opt-in demo data: load the snapshot's sample schools, tournaments and entries
 * into a tenant (for local dev / demo accounts). Provisioning (config, incl.
 * venues) must run first.
 */
export async function seedDemoData(
  tenant: string,
): Promise<{ schools: number; tournaments: number; entries: number; players: number }> {
  const snap = loadSnapshot(tenant);
  for (const school of snap.schools) {
    // Flag snapshot schools as demo so illustrative-only UI (e.g. the seeded
    // communication-log events) shows for them but not for real added schools.
    await repo.putSchool(tenant, { ...school, demo: true, version: 1 });
  }
  for (const tournament of snap.tournaments) {
    await repo.putTournament(tenant, { ...tournament, version: 1 });
  }
  const entries = snap.entries ?? [];
  for (const entry of entries) {
    // createEntry writes the school-side mirror in the same transaction, so demo
    // data lands with the same invariants a real entry has. Ignore a duplicate —
    // re-seeding an already-seeded tenant must stay idempotent.
    await repo.createEntry(tenant, { ...entry, demo: true, version: 1 }).catch((err) => {
      if (!(err instanceof repo.DuplicateEntryError)) throw err;
    });
  }
  // Squads land after their entries: createPlayer bumps the entry's playerCount,
  // so the denormalized number ends up backed by real rows instead of asserted.
  const players = snap.players ?? [];
  for (const player of players) {
    await repo.createPlayer(tenant, player).catch((err: unknown) => {
      // Re-seeding an already-seeded tenant must stay idempotent.
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    });
  }

  // Sports-admin modules. Zones and ticket types are plain puts (idempotent by
  // id); tickets/passes go through create* so their scan tokens and denormalized
  // counts land exactly as a real issue would. `createTicket`/`createParkingPass`
  // bump the parent's count, so the seeded types/zones start at 0 and let those
  // bumps accumulate rather than double-counting.
  for (const a of snap.assessments ?? []) {
    await repo.putAssessment(tenant, { ...a, version: 1 });
  }
  for (const tt of snap.ticketTypes ?? []) {
    await repo.putTicketType(tenant, { ...tt, sold: 0, version: 1 });
  }
  for (const t of snap.tickets ?? []) {
    await repo.createTicket(tenant, { ...t, version: 1 }).catch((err: unknown) => {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    });
  }
  for (const z of snap.parkingZones ?? []) {
    await repo.putParkingZone(tenant, { ...z, allocated: 0, version: 1 });
  }
  for (const p of snap.parkingPasses ?? []) {
    await repo.createParkingPass(tenant, { ...p, version: 1 }).catch((err: unknown) => {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    });
  }

  // Academic-support module: the student-athlete roster and its check-ins /
  // interventions. Plain puts (idempotent by id).
  for (const a of snap.athletes ?? []) await repo.putAthlete(tenant, { ...a, version: 1 });
  for (const c of snap.checkIns ?? []) await repo.putCheckIn(tenant, { ...c, version: 1 });
  for (const iv of snap.interventions ?? []) {
    await repo.putIntervention(tenant, { ...iv, version: 1 });
  }

  return {
    schools: snap.schools.length,
    tournaments: snap.tournaments.length,
    entries: entries.length,
    players: players.length,
  };
}
