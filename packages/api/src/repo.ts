/**
 * Repository — all DynamoDB access for the single table. Callers pass a tenant
 * and the repo builds tenant-scoped keys via ./keys, so no handler ever touches
 * a raw key. School/tournament writes use optimistic concurrency (version check).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  DeleteCommand,
  BatchWriteCommand,
  TransactWriteCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
  schoolKey,
  schoolInviteKey,
  schoolGsi1,
  schoolsListGsi1pk,
  tournamentKey,
  tournamentGsi1,
  tournamentsListGsi1pk,
  entryKey,
  entriesListKey,
  schoolEntryKey,
  schoolEntriesListKey,
  playerKey,
  squadListKey,
  allPlayersListKey,
  assessmentKey,
  assessmentGsi1,
  assessmentsListGsi1pk,
  ticketTypeKey,
  ticketTypeGsi1,
  ticketTypesListGsi1pk,
  ticketKey,
  ticketGsi1,
  ticketsListGsi1pk,
  parkingZoneKey,
  parkingZoneGsi1,
  parkingZonesListGsi1pk,
  parkingPassKey,
  parkingPassGsi1,
  parkingPassesListGsi1pk,
  athleteKey,
  athleteGsi1,
  athletesListGsi1pk,
  mentorKey,
  mentorGsi1,
  mentorsListGsi1pk,
  checkInKey,
  checkInGsi1,
  checkInsListGsi1pk,
  interventionKey,
  interventionGsi1,
  interventionsListGsi1pk,
  tokenKey,
  tenantConfigKey,
  userKey,
  userTenantMarkerKey,
  userGsi1,
  usersListGsi1pk,
} from './keys.js';
import type {
  School,
  CommEvent,
  Entry,
  Venue,
  SendResult,
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

import { tableName } from './env.js';

const TABLE = tableName();
// DYNAMO_ENDPOINT points at a local DynamoDB (dynalite) for offline dev; any
// credentials are accepted by the local clone. Unset in AWS (uses the role).
const localEndpoint = process.env.DYNAMO_ENDPOINT;
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient(
    localEndpoint
      ? {
          endpoint: localEndpoint,
          region: 'localhost',
          credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
        }
      : {},
  ),
  { marshallOptions: { removeUndefinedValues: true } },
);

const s3 = new S3Client({});
const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET;

/**
 * Best-effort delete of stored upload objects (compliance PDFs, player ID docs) during
 * tenant/cohort erasure — so a POPIA "right to erasure" actually removes the files, not
 * just the DynamoDB rows. Skips local-dev keys and never throws: a failed object delete is
 * logged (recoverable via a bucket lifecycle rule) and must not abort the erase.
 */
async function deleteUploadObjects(objectKeys: string[]): Promise<void> {
  if (!UPLOADS_BUCKET) return;
  for (const key of objectKeys) {
    if (!key || key.startsWith('local/')) continue;
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: UPLOADS_BUCKET, Key: key }));
    } catch (err) {
      console.warn(`erase: failed to delete upload object ${key}`, err);
    }
  }
}

/**
 * Send a transactional write, with an offline fallback.
 *
 * dynalite — the in-process DynamoDB clone the offline stack and the integration
 * tests run against — implements no `TransactWriteItems` action, so every
 * multi-item write would 400 with UnknownOperationException locally. Real
 * DynamoDB always takes the transaction; only a local endpoint falls back to
 * applying the writes in order.
 *
 * The fallback is NOT atomic, and deliberately so: it exists to make local dev
 * work, not to weaken production. Callers keep their conditional expressions, so
 * the guard that matters (a duplicate put, a version check, the last-admin floor)
 * still fires on the individual write — the surrendered guarantee is only that a
 * crash mid-sequence can leave the later items unwritten, which offline means one
 * lost dev record and a restart.
 */
async function transactWrite(items: Array<Record<string, never>>): Promise<void> {
  if (!localEndpoint) {
    await ddb.send(new TransactWriteCommand({ TransactItems: items as never }));
    return;
  }
  for (const item of items) {
    const entry = item as unknown as {
      Put?: Record<string, unknown>;
      Update?: Record<string, unknown>;
      Delete?: Record<string, unknown>;
    };
    if (entry.Put) await ddb.send(new PutCommand(entry.Put as never));
    else if (entry.Update) await ddb.send(new UpdateCommand(entry.Update as never));
    else if (entry.Delete) await ddb.send(new DeleteCommand(entry.Delete as never));
  }
}

/** Thrown when a version-checked write loses a race. Handlers map this to HTTP 409. */
export class VersionConflictError extends Error {
  constructor() {
    super('version conflict');
    this.name = 'VersionConflictError';
  }
}

/**
 * Thrown when a transactional admin-decrement (demote/remove) would leave a tenant
 * with zero admins — the CONFIG `adminCount > 1` condition failed. Handlers map this
 * to HTTP 409 "cannot remove the last admin".
 */
export class LastAdminError extends Error {
  constructor() {
    super('cannot remove the last admin');
    this.name = 'LastAdminError';
  }
}

const stripKeys = <T>(item: Record<string, unknown> | undefined): T | null => {
  if (!item) return null;
  const { pk, sk, gsi1pk, gsi1sk, ...rest } = item;
  return rest as T;
};

/**
 * Drain a Query across LastEvaluatedKey pages. A single Query response is capped at
 * 1 MB, so any enumeration that feeds an erase cascade MUST page — a >1MB partition
 * would otherwise silently truncate to its first page and leave residue an erase
 * promised to remove. Passes the input through untouched, so callers may set `Limit`
 * for smaller pages — the int tests use that to drive multi-page reads against
 * dynalite, where seeding a real >1MB partition isn't practical (hence the export).
 */
export async function queryAll(input: QueryCommandInput): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey: startKey }));
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

// ── Tenant config ──

export async function getTenantConfig(tenant: string): Promise<TenantConfig | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: tenantConfigKey(tenant) }));
  return stripKeys<TenantConfig>(res.Item);
}

/** Create a tenant config; fails if the slug is already taken (collision guard). */
export async function createTenantConfig(config: TenantConfig): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...tenantConfigKey(config.tenant), ...config },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
}

export async function putTenantConfig(config: TenantConfig): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...tenantConfigKey(config.tenant), ...config },
    }),
  );
}

/**
 * Update only the support-contact copy slot. Uses a targeted UpdateExpression
 * (not a whole-config read-modify-write) so it physically cannot clobber a
 * concurrent leagues/deadline write — TenantConfig has no version guard.
 * Throws ConditionalCheckFailedException if the config row doesn't exist
 * (handler maps that to 404).
 *
 * Precondition: the `branding.copy` map must already exist on the row — setting
 * a nested path can't create its parent. This holds for every config we write
 * (the TenantConfig type makes `branding.copy` required and seed-core always
 * populates it), so a missing parent would mean a malformed/hand-edited row; it
 * would surface as a ValidationException → unmapped 500 rather than the 404.
 */
export async function updateSupportCopy(tenant: string, support: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: tenantConfigKey(tenant),
      UpdateExpression: 'SET #b.#c.#s = :v',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#b': 'branding', '#c': 'copy', '#s': 'support' },
      ExpressionAttributeValues: { ':v': support },
    }),
  );
}

/**
 * Targeted SET of the host venue list (leaves branding/host/adminCount untouched),
 * guarded so a concurrent organiser save can't be clobbered: by default the write
 * only lands while the stored list is still ABSENT or EMPTY. Returns true if written,
 * false if the guard failed (raced to populated, or the CONFIG row vanished). The
 * CALLER decides whether to attempt this based on a prior read — this is the race
 * net, not the policy. `force` drops the empty-array half of the guard so an
 * explicitly forced repair can overwrite a present-but-empty list.
 */
export async function backfillVenues(
  tenant: string,
  venues: Venue[],
  force = false,
): Promise<boolean> {
  const guard = force
    ? 'attribute_exists(pk)'
    : 'attribute_exists(pk) AND (attribute_not_exists(#v) OR size(#v) = :zero)';
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: tenantConfigKey(tenant),
        UpdateExpression: 'SET #v = :val',
        ConditionExpression: guard,
        ExpressionAttributeNames: { '#v': 'venues' },
        ExpressionAttributeValues: force ? { ':val': venues } : { ':val': venues, ':zero': 0 },
      }),
    );
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

// ── Schools (the visiting-school directory) ──

export async function listSchools(tenant: string): Promise<School[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :p',
      ExpressionAttributeValues: { ':p': schoolsListGsi1pk(tenant) },
    }),
  );
  return (res.Items ?? []).map((i) => stripKeys<School>(i)!);
}

export async function getSchool(tenant: string, schoolId: string): Promise<School | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: schoolKey(tenant, schoolId) }),
  );
  return stripKeys<School>(res.Item);
}

/** Insert a new school (used by onboarding + seed). Fails if the id already exists. */
export async function createSchool(tenant: string, school: School): Promise<School> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...schoolKey(tenant, school.id),
        ...schoolGsi1(tenant, school.name),
        ...school,
        version: school.version ?? 1,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
  return school;
}

/** Upsert a school (used by seed; overwrites, no version guard). */
export async function putSchool(tenant: string, school: School): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...schoolKey(tenant, school.id),
        ...schoolGsi1(tenant, school.name),
        ...school,
        version: school.version ?? 1,
      },
    }),
  );
}

/**
 * Apply a partial update to a school under optimistic concurrency. Reads the current
 * record, merges, and writes with a version guard — a lost race throws
 * VersionConflictError (→ 409). Always re-derives gsi1 from the (possibly new) name.
 */
export async function updateSchool(
  tenant: string,
  schoolId: string,
  patch: Partial<School>,
  changedBy: string,
  changedAt: string,
): Promise<School> {
  const current = await getSchool(tenant, schoolId);
  if (!current) throw new Error('school not found');
  // Honor a client-supplied expected version (true optimistic concurrency);
  // fall back to the current version for callers that don't send one.
  const expectedVersion = patch.version ?? current.version ?? 0;
  // Shallow merge: a patch key (e.g. `docMeta`) REPLACES the current value
  // wholesale, it is not deep-merged per sub-key. The client's reversible
  // "Mark as compliant" revert relies on this — it omits a doc key from the
  // docMeta it sends to remove an override. Deep-merging here would resurrect
  // those removed keys and silently break revert.
  const next: School = {
    ...current,
    ...patch,
    id: schoolId,
    version: expectedVersion + 1,
    changedBy,
    changedAt,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          ...schoolKey(tenant, schoolId),
          ...schoolGsi1(tenant, next.name),
          ...next,
        },
        // Update of an existing row: guard strictly on version. (No
        // attribute_not_exists OR — that would resurrect a concurrently-deleted
        // row and weakens the conflict check.)
        ConditionExpression: 'version = :v',
        ExpressionAttributeValues: { ':v': expectedVersion },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new VersionConflictError();
    }
    throw err;
  }
  return next;
}

/**
 * Append a note to a school's communication log. Uses a DynamoDB `list_append`
 * UpdateExpression (not read-modify-write) so concurrent note posts compose
 * instead of clobbering each other — there is no version guard precisely so two
 * simultaneous appends both land. The version still bumps for audit/OCC of other
 * writers. Guards on row existence (handler does the 404 with a clearer message).
 *
 * Caveat: because the bump is unconditional (no `version = :v` guard), an append
 * can invalidate the OCC token of a concurrent version-guarded updateSchool, handing
 * it a spurious 409. The UI mitigates this by invalidating the school query right
 * after a note add, so the next edit re-reads the bumped version.
 */
export async function appendSchoolNote(
  tenant: string,
  schoolId: string,
  note: { id: string; text: string; author: string; at: string },
): Promise<School> {
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: schoolKey(tenant, schoolId),
      UpdateExpression:
        'SET notes = list_append(if_not_exists(notes, :empty), :new), ' +
        'version = if_not_exists(version, :zero) + :one, changedBy = :by, changedAt = :at',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: {
        ':empty': [],
        ':new': [note],
        ':zero': 0,
        ':one': 1,
        ':by': note.author,
        ':at': note.at,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return stripKeys<School>(res.Attributes) as School;
}

/**
 * Append real onboarding-invite send events to a school's comm log. Same `list_append`
 * strategy as appendSchoolNote (no version guard) so concurrent appends compose. Best
 * effort from the caller's perspective: the messages already went out before this
 * runs, so a failure here must not be treated as a send failure.
 */
export async function appendSchoolCommEvents(
  tenant: string,
  schoolId: string,
  events: CommEvent[],
): Promise<School> {
  if (events.length === 0) return (await getSchool(tenant, schoolId)) as School;
  const stampedBy = events[events.length - 1].by;
  const stampedAt = events[events.length - 1].at;
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: schoolKey(tenant, schoolId),
      UpdateExpression:
        'SET commLog = list_append(if_not_exists(commLog, :empty), :new), ' +
        'version = if_not_exists(version, :zero) + :one, changedBy = :by, changedAt = :at',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: {
        ':empty': [],
        ':new': events,
        ':zero': 0,
        ':one': 1,
        ':by': stampedBy,
        ':at': stampedAt,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return stripKeys<School>(res.Attributes) as School;
}

/** Outcome of a duplicate idempotency claim: prior results + whether the first attempt is still running. */
export interface InviteSendReplay {
  pending: boolean;
  results: SendResult[];
}

/**
 * Server-side idempotency for invite sends. Atomically claims an idempotency key by
 * writing a marker item (separate sk in the school's collection) under
 * `attribute_not_exists(pk)`. Returns:
 *   - `null` when the claim succeeds → the caller proceeds to send.
 *   - an {@link InviteSendReplay} when the key was already claimed → the caller
 *     short-circuits. `pending` is true when the first attempt hasn't completed yet
 *     (no results to replay), so the UI can say "already sending" rather than showing
 *     a silent no-op.
 * This stops a lost-response retry (or a second tab/admin) from re-sending the same
 * keyed attempt. Each fresh admin click uses a new key, so genuine retries still send.
 */
export async function claimInviteSend(
  tenant: string,
  schoolId: string,
  idempotencyKey: string,
  channels: string[],
  kind: 'invite' | 'fixtures' = 'invite',
): Promise<InviteSendReplay | null> {
  const startedAt = new Date().toISOString();
  // TTL (epoch seconds): the marker only needs to outlive a lost-response retry window,
  // so let DynamoDB reap it after ~72h instead of accumulating one item per send forever.
  // (Tenant/cohort erasure still deletes any that haven't expired — see listSchoolInviteKeys.)
  const expiresAt = Math.floor(Date.now() / 1000) + 72 * 60 * 60;
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          ...schoolInviteKey(tenant, schoolId, idempotencyKey),
          // Markers for both sends share the INVITE# sk prefix (so erasure finds both);
          // `kind` keeps a fixtures marker distinguishable from an onboarding invite.
          kind,
          channels,
          status: 'in_progress',
          startedAt,
          expiresAt,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return null;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      const res = await ddb.send(
        new GetCommand({
          TableName: TABLE,
          Key: schoolInviteKey(tenant, schoolId, idempotencyKey),
        }),
      );
      const item = res.Item as
        { status?: string; results?: SendResult[]; kind?: string } | undefined;
      // The invite/fixtures markers share the INVITE# keyspace; `kind` disambiguates them.
      // A key reused across kinds must never replay the wrong send's results — refuse it.
      const priorKind = (item?.kind as 'invite' | 'fixtures') ?? 'invite';
      if (priorKind !== kind) {
        throw new Error(
          `idempotency key ${idempotencyKey} already used for a ${priorKind} send (got ${kind})`,
        );
      }
      return { pending: item?.status !== 'completed', results: item?.results ?? [] };
    }
    throw err;
  }
}

/**
 * Delete an idempotency marker so the key can be reclaimed fresh. Used when a send
 * aborts AFTER the claim but BEFORE completion (e.g. a validation 409), so the failed
 * attempt doesn't poison a legitimate retry for the full 72h TTL.
 *
 * Safe to call unconditionally: only the request that WON the `attribute_not_exists`
 * claim reaches this path. A concurrent retry on the same key lost the claim (got a
 * pending/completed replay) and never created a marker of its own, so there is no
 * sibling marker for this delete to clobber — the shared key serializes ownership.
 */
export async function releaseInviteClaim(
  tenant: string,
  schoolId: string,
  idempotencyKey: string,
): Promise<void> {
  await ddb.send(
    new DeleteCommand({ TableName: TABLE, Key: schoolInviteKey(tenant, schoolId, idempotencyKey) }),
  );
}

/** Record the outcome on the idempotency marker so a replay returns the same results. */
export async function completeInviteSend(
  tenant: string,
  schoolId: string,
  idempotencyKey: string,
  results: SendResult[],
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: schoolInviteKey(tenant, schoolId, idempotencyKey),
      UpdateExpression: 'SET #r = :r, #s = :done, completedAt = :at',
      ExpressionAttributeNames: { '#r': 'results', '#s': 'status' },
      ExpressionAttributeValues: {
        ':r': results,
        ':done': 'completed',
        ':at': new Date().toISOString(),
      },
    }),
  );
}

/**
 * Keys of all invite-idempotency markers for a school (sk begins `INVITE#`). These items
 * carry recipient contact in their stored results, so tenant/cohort erasure must delete
 * them too — they're not reachable via the gsi1 school listing that the erase paths use.
 */
async function listSchoolInviteKeys(
  tenant: string,
  schoolId: string,
): Promise<Array<{ pk: string; sk: string }>> {
  const { pk } = schoolKey(tenant, schoolId);
  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': pk, ':s': 'INVITE#' },
    ProjectionExpression: 'pk, sk',
  });
  return items.map((i) => ({ pk: i.pk as string, sk: i.sk as string }));
}

// ── Tournament ──

export async function listTournaments(tenant: string): Promise<Tournament[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :p',
      ExpressionAttributeValues: { ':p': tournamentsListGsi1pk(tenant) },
    }),
  );
  return (res.Items ?? []).map((i) => stripKeys<Tournament>(i)!);
}

export async function getTournament(
  tenant: string,
  tournamentId: string,
): Promise<Tournament | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: tournamentKey(tenant, tournamentId) }),
  );
  return stripKeys<Tournament>(res.Item);
}

export async function putTournament(tenant: string, tournament: Tournament): Promise<Tournament> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...tournamentKey(tenant, tournament.id),
        ...tournamentGsi1(tenant, tournament.startDate),
        ...tournament,
        version: tournament.version ?? 1,
      },
    }),
  );
  return tournament;
}

/** Version-checked replace of a tournament (fixtures embedded). 409 on conflict. */
export async function updateTournament(
  tenant: string,
  tournamentId: string,
  patch: Partial<Tournament>,
): Promise<Tournament> {
  const current = await getTournament(tenant, tournamentId);
  if (!current) throw new Error('tournament not found');
  const expectedVersion = (patch.version as number | undefined) ?? current.version ?? 0;
  const next: Tournament = {
    ...current,
    ...patch,
    id: tournamentId,
    version: expectedVersion + 1,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          ...tournamentKey(tenant, tournamentId),
          ...tournamentGsi1(tenant, next.startDate),
          ...next,
        },
        ConditionExpression: 'version = :v',
        ExpressionAttributeValues: { ':v': expectedVersion },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new VersionConflictError();
    }
    throw err;
  }
  return next;
}

export async function deleteTournament(tenant: string, tournamentId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: tournamentKey(tenant, tournamentId) }));
}

// ── Registration tokens (global, self-describing) ──

/**
 * Two token shapes share the TOKEN# keyspace: player reg-links carry a `schoolId`
 * (no `kind`), school signup links carry `kind: 'school-signup'` (no schoolId). Each
 * consumer checks the field it requires, so neither token works on the other's
 * endpoints.
 */
export async function getToken(token: string): Promise<{
  tenant: string;
  /** Present on squad-registration tokens; absent on the tenant signup token. */
  tournamentId?: string;
  schoolId?: string;
  kind?: 'school-signup' | 'mentor-plan';
  /** Present on mentor-plan tokens — the check-in the mentor completes. */
  checkInId?: string;
  studentNumber?: string;
  createdAt: string;
} | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: tokenKey(token) }));
  return stripKeys(res.Item);
}

/**
 * Mint a squad-registration token. It self-describes its full scope (tenant,
 * tournament, school) so the public /register route never infers any of the three
 * from the request host.
 */
export async function putToken(
  token: string,
  scope: { tenant: string; tournamentId: string; schoolId: string },
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...tokenKey(token), ...scope, createdAt: new Date().toISOString() },
    }),
  );
}

/** Store a tenant-wide school self-signup token (kind-tagged, no schoolId). */
export async function putSignupToken(
  token: string,
  tenant: string,
  createdAt: string,
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...tokenKey(token), tenant, kind: 'school-signup', createdAt },
    }),
  );
}

/** Revoke a token so a regenerated reg-link invalidates the previous one. */
export async function deleteToken(token: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: tokenKey(token) }));
}

const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

/**
 * Hourly signup rate cap, kept on the TOKEN# item itself (no extra row to revoke).
 * Returns whether this signup is allowed. Two conditional updates, no read:
 *   1. start a fresh window (count = 1) when none exists or the current one aged out;
 *   2. otherwise increment under `signupCount < limit`.
 * Both writes are condition-guarded so concurrent requests can't blow past the cap
 * mid-window. At a window boundary two racers can both "win" the reset (the second
 * overwrites count back to 1) — that under-counts by the race width, which only ever
 * ADMITS a request the cap might have refused; it never blocks a legitimate one.
 * `attribute_exists(pk)` in step 1 (and the attribute reads in step 2) make a revoked
 * token fail both conditions → false. The caller surfaces false as a 429, so a token
 * revoked between route validation and this bump reads as "try later" rather than
 * "link dead" — a one-request-wide race, denied either way; the next attempt 404s
 * at validation.
 */
export async function bumpSignupTokenCounter(
  token: string,
  nowIso: string,
  limit: number,
): Promise<boolean> {
  const cutoff = new Date(new Date(nowIso).getTime() - SIGNUP_WINDOW_MS).toISOString();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: tokenKey(token),
        UpdateExpression: 'SET signupWindowStart = :now, signupCount = :one',
        ConditionExpression:
          'attribute_exists(pk) AND (attribute_not_exists(signupWindowStart) OR signupWindowStart < :cutoff)',
        ExpressionAttributeValues: { ':now': nowIso, ':one': 1, ':cutoff': cutoff },
      }),
    );
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: tokenKey(token),
        UpdateExpression: 'SET signupCount = signupCount + :one',
        ConditionExpression: 'signupWindowStart >= :cutoff AND signupCount < :limit',
        ExpressionAttributeValues: { ':one': 1, ':cutoff': cutoff, ':limit': limit },
      }),
    );
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * SET or REMOVE the tenant's school-signup-link pointer via a targeted UpdateExpression
 * (modeled on updateSupportCopy) — never a whole-config read-modify-write, so a
 * concurrent Settings save can't clobber it (TenantConfig has no version guard).
 * Throws ConditionalCheckFailedException when the CONFIG row doesn't exist.
 */
export async function updateSchoolSignupLink(
  tenant: string,
  link: { token: string; createdAt: string } | null,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: tenantConfigKey(tenant),
      ...(link
        ? {
            UpdateExpression: 'SET schoolSignupLink = :v',
            ExpressionAttributeValues: { ':v': link },
          }
        : { UpdateExpression: 'REMOVE schoolSignupLink' }),
      ConditionExpression: 'attribute_exists(pk)',
    }),
  );
}

// ── Users ──

export async function getUser(sub: string): Promise<UserProfile | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: userKey(sub) }));
  return stripKeys<UserProfile>(res.Item);
}

/**
 * Reconcile the per-membership TENANT# marker items against a user's current
 * memberships: upsert a marker for every membership (refreshing a changed
 * role/email), delete markers for revoked memberships. Best-effort and idempotent —
 * re-converges on the next call, so a partial failure self-heals. Shared by
 * `putUser` and the transactional admin-delta write so both keep markers in sync.
 */
async function reconcileUserMarkers(user: UserProfile): Promise<void> {
  const existing = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': userKey(user.sub).pk, ':s': 'TENANT#' },
    }),
  );
  const wanted = new Set(user.memberships.map((m) => m.tenantId));
  const have = new Set((existing.Items ?? []).map((i) => String(i.sk).slice('TENANT#'.length)));

  const writes: Promise<unknown>[] = [];
  // Upsert a marker for every current membership — unconditionally, so a changed
  // role/email on an existing membership refreshes the marker (not just new ones).
  for (const m of user.memberships) {
    writes.push(
      ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: {
            ...userTenantMarkerKey(user.sub, m.tenantId),
            ...userGsi1(m.tenantId, user.email),
            sub: user.sub,
            email: user.email,
            role: m.role,
          },
        }),
      ),
    );
  }
  // Remove markers for revoked memberships.
  for (const tenantId of have) {
    if (!wanted.has(tenantId)) {
      writes.push(
        ddb.send(
          new DeleteCommand({ TableName: TABLE, Key: userTenantMarkerKey(user.sub, tenantId) }),
        ),
      );
    }
  }
  await Promise.all(writes);
}

/**
 * Upsert a user: the META item (memberships = source of truth) plus one
 * tenant-marker item per membership so the user is listable under EVERY tenant
 * they belong to. Reconciles markers: removes markers for tenants no longer in
 * `memberships`, adds markers for new ones.
 */
export async function putUser(user: UserProfile): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      // META item carries memberships; no gsi1 (markers do the indexing).
      Item: { ...userKey(user.sub), ...user },
    }),
  );
  await reconcileUserMarkers(user);
}

/**
 * Stamp the user's first-ever sign-in. Writes `lastLoginAt` on the USER# META item
 * exactly ONCE per lifetime via `attribute_not_exists(lastLoginAt)` — subsequent
 * token refreshes hit the condition and no-op. Best-effort: swallows the conditional
 * failure AND every other error, because the caller (PreTokenGen) must never let a
 * failed write block token issuance / sign-in. Returns nothing.
 */
export async function stampFirstLogin(sub: string): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: userKey(sub),
        UpdateExpression: 'SET lastLoginAt = :now',
        // Once-per-lifetime: only the first sign-in (no lastLoginAt yet) writes.
        // attribute_exists(pk) keeps us from materializing a bare USER# row for a
        // user with no DynamoDB profile (e.g. a token minted before provisioning).
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(lastLoginAt)',
        ExpressionAttributeValues: { ':now': new Date().toISOString() },
      }),
    );
  } catch {
    // Expected on every refresh after the first sign-in (condition fails), and we
    // additionally swallow ALL errors: a sign-in must never break on this best-effort
    // status stamp. Not logged — the condition failure is the common, benign case.
  }
}

/**
 * Count a tenant's admins from the AUTHORITATIVE source (each user's `memberships`,
 * never the possibly-stale marker `role`) and write it to CONFIG.adminCount. Used to
 * lazily backfill the counter on legacy tenants before the lockout guard runs, and as
 * a repair. Returns the freshly-counted value.
 */
export async function recountAdmins(tenant: string): Promise<number> {
  const roster = await listTenantUsers(tenant);
  const profiles = await Promise.all(roster.map((u) => getUser(u.sub)));
  const count = profiles.filter((p) =>
    p?.memberships.some((m) => m.tenantId === tenant && m.role === 'admin'),
  ).length;
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: tenantConfigKey(tenant),
      UpdateExpression: 'SET adminCount = :n',
      ExpressionAttributeValues: { ':n': count },
    }),
  );
  return count;
}

/**
 * Conditionally decrement CONFIG.adminCount by one, refusing to drop below one admin
 * (the same `adminCount > 1` guard the transactional path uses). Used for a FULL
 * offboard DELETE, where the user's META item is deleted (not written) so there's no
 * user write to bundle into a transaction — the count is the only thing to adjust here.
 * Throws {@link LastAdminError} when it would remove the last admin.
 */
export async function decrementAdminCount(tenant: string): Promise<void> {
  await guardedConfigUpdate(tenant, {
    UpdateExpression: 'ADD adminCount :neg',
    ConditionExpression: 'adminCount > :one',
    ExpressionAttributeValues: { ':neg': -1, ':one': 1 },
  });
}

/**
 * Write a user's META item and adjust the tenant's CONFIG.adminCount ATOMICALLY in a
 * single TransactWriteItems, then reconcile the user's TENANT# markers.
 *
 * `adminDelta` is +1 (invite-as-admin / promote rep→admin), -1 (demote admin→rep /
 * remove an admin), or 0 (no role-tier change). For a -1 the CONFIG update carries
 * `ConditionExpression: adminCount > :one`, so the transaction is REJECTED — and the
 * user write rolled back — when it would drop the tenant to zero admins, surfacing as
 * {@link LastAdminError}. This makes the last-admin lockout race-free (no TOCTOU on a
 * point-in-time count). For +1/-1 the CONFIG must already carry adminCount; callers
 * backfill via recountAdmins first when it's absent (a legacy tenant).
 *
 * Markers are reconciled AFTER the transaction (they're a derived index, not part of
 * the atomic invariant) — same best-effort, self-healing reconciliation putUser uses.
 */
export async function writeUserWithAdminDelta(
  user: UserProfile,
  tenant: string,
  adminDelta: -1 | 0 | 1,
): Promise<void> {
  if (adminDelta === 0) {
    await putUser(user);
    return;
  }
  const configUpdate: AdminCountUpdate =
    adminDelta === 1
      ? {
          UpdateExpression: 'ADD adminCount :one',
          ExpressionAttributeValues: { ':one': 1 },
        }
      : {
          // Decrement guarded: refuse to go below one admin (last-admin lockout).
          UpdateExpression: 'ADD adminCount :neg',
          ConditionExpression: 'adminCount > :one',
          ExpressionAttributeValues: { ':neg': -1, ':one': 1 },
        };

  if (localEndpoint) {
    // Local DynamoDB (dynalite) has no TransactWriteItems support. Fall back to the
    // CONFIG update FIRST (its ConditionExpression still enforces the last-admin guard
    // on a decrement), then the user write. Not atomic — a crash between the two can
    // drift adminCount — but recountAdmins repairs it and this path is OFFLINE/TEST
    // only (production always has the real endpoint → the transaction below).
    await guardedConfigUpdate(tenant, configUpdate);
    await putUser(user);
    return;
  }

  try {
    await transactWrite([
      {
        Put: {
          TableName: TABLE,
          Item: { ...userKey(user.sub), ...user },
        },
      },
      {
        Update: {
          TableName: TABLE,
          Key: tenantConfigKey(tenant),
          ...configUpdate,
        },
      },
    ] as never);
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    // A guarded decrement that hit the floor cancels the whole transaction (so the
    // user write is rolled back too) — surface it as the typed last-admin error.
    if (name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException') {
      throw new LastAdminError();
    }
    throw err;
  }
  await reconcileUserMarkers(user);
}

/**
 * Apply a (possibly conditional) adminCount UpdateCommand to CONFIG, mapping a failed
 * `adminCount > 1` decrement guard to {@link LastAdminError}. Shared by the
 * dynalite fallback in writeUserWithAdminDelta and by decrementAdminCount.
 */
interface AdminCountUpdate {
  UpdateExpression: string;
  ConditionExpression?: string;
  ExpressionAttributeValues: Record<string, number>;
}

async function guardedConfigUpdate(tenant: string, update: AdminCountUpdate): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({ TableName: TABLE, Key: tenantConfigKey(tenant), ...update }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new LastAdminError();
    }
    throw err;
  }
}

/**
 * Prune one orphaned admin membership (a membership whose Cognito user is gone). The
 * caller passes `user` with this tenant's membership ALREADY removed; this writes that
 * META + `ADD adminCount -1` ATOMICALLY, then reconciles markers.
 *
 * UNLIKE the guarded decrement this is UNCONDITIONAL — removing a phantom admin must
 * always succeed (a tenant whose only "admin" was a phantom is already locked out, and
 * we still want the counter to reflect zero real admins). Using an `ADD` delta (never a
 * recompute-SET) keeps it race-free with concurrent invite/promote/remove; a double-prune
 * from two concurrent reconciles only drifts the counter LOW — the safe direction — and is
 * repaired by the next backfill. It NEVER deletes the user, so a multi-tenant user keeps
 * their other memberships; an emptied META item is harmless (no markers ⇒ unlistable) and
 * the reconcile CLI fully removes it.
 */
export async function pruneAdminMembership(user: UserProfile, tenant: string): Promise<void> {
  const decrement: AdminCountUpdate = {
    UpdateExpression: 'ADD adminCount :neg',
    ExpressionAttributeValues: { ':neg': -1 },
  };
  if (localEndpoint) {
    // dynalite has no TransactWriteItems — same non-atomic offline fallback shape as
    // writeUserWithAdminDelta (test/offline only; production uses the transaction below).
    await ddb.send(
      new UpdateCommand({ TableName: TABLE, Key: tenantConfigKey(tenant), ...decrement }),
    );
    await putUser(user);
    return;
  }
  await transactWrite([
    { Put: { TableName: TABLE, Item: { ...userKey(user.sub), ...user } } },
    { Update: { TableName: TABLE, Key: tenantConfigKey(tenant), ...decrement } },
  ] as never);
  await reconcileUserMarkers(user);
}

/**
 * Delete a user fully: the META record AND every TENANT# marker (so an offboarded user
 * leaves no listable trace in any tenant). Their Cognito account is removed separately.
 * (eraseTenantData deletes a single tenant's marker without touching META — different
 * intent; this is the whole-user delete.)
 */
export async function deleteUser(sub: string): Promise<void> {
  const markers = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': userKey(sub).pk, ':s': 'TENANT#' },
      ProjectionExpression: 'pk, sk',
    }),
  );
  await Promise.all([
    ddb.send(new DeleteCommand({ TableName: TABLE, Key: userKey(sub) })),
    ...(markers.Items ?? []).map((i) =>
      ddb.send(
        new DeleteCommand({ TableName: TABLE, Key: { pk: i.pk as string, sk: i.sk as string } }),
      ),
    ),
  ]);
}

/** List a tenant's users for offboarding/erasure (via the marker items). */
export async function listTenantUsers(
  tenant: string,
): Promise<Array<{ sub: string; email: string; role: string }>> {
  const items = await queryAll({
    TableName: TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': usersListGsi1pk(tenant) },
  });
  return items.map((i) => ({
    sub: String(i.sub),
    email: String(i.email),
    role: String(i.role),
  }));
}
// ── Entries (a school's entry into one tournament) ──

/**
 * Every entry for a tournament — the organiser's inbox, one query, no fan-out.
 * Entries and squad players share the tournament partition, so the sk prefix is
 * what keeps them apart.
 */
export async function listEntries(tenant: string, tournamentId: string): Promise<Entry[]> {
  const { pk, skPrefix } = entriesListKey(tenant, tournamentId);
  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': pk, ':s': skPrefix },
  });
  return items.map((i) => stripKeys<Entry>(i)!);
}

export async function getEntry(
  tenant: string,
  tournamentId: string,
  schoolId: string,
): Promise<Entry | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: entryKey(tenant, tournamentId, schoolId) }),
  );
  return stripKeys<Entry>(res.Item);
}

/**
 * Every tournament a school has entered, read from the school's own mirror
 * partition — so a visiting school's portal never scans the tournament space.
 * The mirrors carry only the pointer fields; callers that need the full entry
 * fetch it by (tournamentId, schoolId).
 */
export async function listSchoolEntries(tenant: string, schoolId: string): Promise<Entry[]> {
  const { pk, skPrefix } = schoolEntriesListKey(tenant, schoolId);
  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': pk, ':s': skPrefix },
  });
  return items.map((i) => stripKeys<Entry>(i)!);
}

/** Thrown when a school tries to enter a tournament it is already in. */
export class DuplicateEntryError extends Error {
  constructor() {
    super('this school has already entered this tournament');
    this.name = 'DuplicateEntryError';
  }
}

/**
 * Lodge an entry. Writes the canonical item (tournament partition) and the
 * school-side mirror in ONE transaction, so the two can never disagree — a
 * half-written entry would either vanish from the organiser's inbox or haunt the
 * school's portal forever.
 *
 * The canonical put is conditional on `attribute_not_exists(sk)`, which is what
 * makes "one entry per school per tournament" a structural guarantee rather than
 * a check-then-write race.
 */
export async function createEntry(tenant: string, entry: Entry): Promise<Entry> {
  const item = { ...entry, version: entry.version ?? 1 };
  try {
    await transactWrite([
      {
        Put: {
          TableName: TABLE,
          Item: { ...entryKey(tenant, entry.tournamentId, entry.schoolId), ...item },
          ConditionExpression: 'attribute_not_exists(sk)',
        },
      },
      {
        Put: {
          TableName: TABLE,
          Item: {
            ...schoolEntryKey(tenant, entry.schoolId, entry.tournamentId),
            tournamentId: entry.tournamentId,
            schoolId: entry.schoolId,
            status: item.status,
            createdAt: item.createdAt,
          },
        },
      },
    ] as never);
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === 'TransactionCanceledException' || name === 'ConditionalCheckFailedException') {
      throw new DuplicateEntryError();
    }
    throw err;
  }
  // Display-only denormalization on the school; recomputable from the mirrors,
  // so a failed bump (school concurrently deleted) is swallowed.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: schoolKey(tenant, entry.schoolId),
        UpdateExpression: 'ADD entryCount :one',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':one': 1 },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
  return item;
}

/**
 * Version-checked update of an entry. Shallow merge, same convention as
 * updateSchool: a patch key (e.g. `docMeta`) REPLACES the current value wholesale
 * rather than deep-merging, which is what makes the reversible "mark received"
 * undo work — it omits a doc key to remove the override.
 *
 * When the status changes, the school-side mirror is updated in the same
 * transaction so the portal never shows a stale decision.
 */
export async function updateEntry(
  tenant: string,
  tournamentId: string,
  schoolId: string,
  patch: Partial<Entry>,
  changedBy: string,
  changedAt: string,
): Promise<Entry> {
  const current = await getEntry(tenant, tournamentId, schoolId);
  if (!current) throw new Error('entry not found');
  const expectedVersion = patch.version ?? current.version ?? 0;
  const next: Entry = {
    ...current,
    ...patch,
    tournamentId,
    schoolId,
    version: expectedVersion + 1,
    changedBy,
    changedAt,
  };
  const writes: object[] = [
    {
      Put: {
        TableName: TABLE,
        Item: { ...entryKey(tenant, tournamentId, schoolId), ...next },
        ConditionExpression: 'version = :v',
        ExpressionAttributeValues: { ':v': expectedVersion },
      },
    },
  ];
  if (patch.status && patch.status !== current.status) {
    writes.push({
      Update: {
        TableName: TABLE,
        Key: schoolEntryKey(tenant, schoolId, tournamentId),
        UpdateExpression: 'SET #s = :status',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':status': patch.status },
      },
    });
  }
  try {
    await transactWrite(writes as never);
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === 'TransactionCanceledException' || name === 'ConditionalCheckFailedException') {
      throw new VersionConflictError();
    }
    throw err;
  }
  return next;
}

/**
 * Remove an entry and its squad entirely (organiser deleting a junk entry, or a
 * school withdrawing before the draw). Deletes the canonical item, the mirror,
 * every PLAYER# row for that (tournament, school), and purges the uploaded entry
 * pack + ID documents from S3.
 *
 * Ordering is the re-deletable invariant: the canonical entry is deleted only
 * AFTER the cascade succeeds, so a crash mid-way leaves an entry that still 200s
 * on re-delete rather than an orphaned squad no route can reach.
 */
export async function eraseEntryData(tenant: string, entry: Entry): Promise<{ players: number }> {
  if (entry.squadRegLink?.token) await deleteToken(entry.squadRegLink.token);

  const keys: Array<{ pk: string; sk: string }> = [];
  const objectKeys: string[] = [...entryDocObjectKeys(entry)];

  const players = await listSquad(tenant, entry.tournamentId, entry.schoolId);
  for (const p of players) {
    keys.push(playerKey(tenant, entry.tournamentId, entry.schoolId, p.naturalKey));
    if (p.idDocMeta?.objectKey) objectKeys.push(p.idDocMeta.objectKey);
  }
  keys.push(schoolEntryKey(tenant, entry.schoolId, entry.tournamentId));

  await batchDelete(keys);
  await deleteUploadObjects(objectKeys);
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: entryKey(tenant, entry.tournamentId, entry.schoolId),
    }),
  );
  return { players: players.length };
}

/**
 * Pull every stored objectKey off an entry's docMeta — used to purge S3 on
 * erasure. Multi-file docs (safeguarding, medical) store `{ files: [...] }`
 * instead of a single `objectKey`, so their per-file keys are collected too;
 * missing them would leave consent forms and safeguarding certificates (PII) in
 * the bucket after an erase. Exported for the test suite — the dynalite harness
 * has no S3, so collection is asserted directly.
 */
export function entryDocObjectKeys(entry: Entry): string[] {
  const docMeta = (entry.docMeta ?? {}) as Record<
    string,
    { objectKey?: string; files?: Array<{ objectKey?: string }> } | undefined
  >;
  const keys: string[] = [];
  for (const m of Object.values(docMeta)) {
    if (typeof m?.objectKey === 'string') keys.push(m.objectKey);
    if (Array.isArray(m?.files)) {
      for (const f of m.files) {
        if (typeof f?.objectKey === 'string') keys.push(f.objectKey);
      }
    }
  }
  return keys;
}

// ── Fixtures & results ──

/**
 * Capture one fixture's result with a targeted list-element update.
 *
 * Results arrive from several field-side scorers at once. Rewriting the whole
 * tournament item under a version guard would make every concurrent capture a
 * 409 for all but one scorer; instead this SETs a single `fixtures[i].result`,
 * guarded on `fixtures[i].id = :fid` so a concurrent draw regeneration that
 * reshuffled the array can never land a score on the wrong match.
 *
 * The index is resolved from a fresh read, and the guard revalidates it at write
 * time — the read is a lookup, not a lock.
 */
export async function captureFixtureResult(
  tenant: string,
  tournamentId: string,
  fixtureId: string,
  result: Record<string, unknown>,
): Promise<Tournament> {
  const current = await getTournament(tenant, tournamentId);
  if (!current) throw new Error('tournament not found');
  const index = (current.fixtures ?? []).findIndex((f) => f.id === fixtureId);
  if (index < 0) throw new Error('fixture not found');
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: tournamentKey(tenant, tournamentId),
        UpdateExpression: `SET fixtures[${index}].#r = :result ADD version :one`,
        ConditionExpression: `fixtures[${index}].#i = :fid`,
        ExpressionAttributeNames: { '#r': 'result', '#i': 'id' },
        ExpressionAttributeValues: { ':result': result, ':fid': fixtureId, ':one': 1 },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return stripKeys<Tournament>(res.Attributes)!;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // The draw moved under us — the caller refetches and retries.
      throw new VersionConflictError();
    }
    throw err;
  }
}

/**
 * Clear a captured result (a mis-keyed score). Same targeted-update discipline
 * as capture, so undoing one field's mistake doesn't disturb the others.
 */
export async function clearFixtureResult(
  tenant: string,
  tournamentId: string,
  fixtureId: string,
): Promise<Tournament> {
  const current = await getTournament(tenant, tournamentId);
  if (!current) throw new Error('tournament not found');
  const index = (current.fixtures ?? []).findIndex((f) => f.id === fixtureId);
  if (index < 0) throw new Error('fixture not found');
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: tournamentKey(tenant, tournamentId),
        UpdateExpression: `SET fixtures[${index}].#r = :null ADD version :one`,
        ConditionExpression: `fixtures[${index}].#i = :fid`,
        ExpressionAttributeNames: { '#r': 'result', '#i': 'id' },
        ExpressionAttributeValues: { ':null': null, ':fid': fixtureId, ':one': 1 },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return stripKeys<Tournament>(res.Attributes)!;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new VersionConflictError();
    }
    throw err;
  }
}

// ── Squad registrations ──

/** One entry's squad. */
export async function listSquad(
  tenant: string,
  tournamentId: string,
  schoolId: string,
): Promise<PlayerRegistration[]> {
  const { pk, skPrefix } = squadListKey(tenant, tournamentId, schoolId);
  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': pk, ':s': skPrefix },
  });
  return items.map((i) => stripKeys<PlayerRegistration>(i)!);
}

/** Every player across a tournament — the age-verification audit export. */
export async function listAllPlayers(
  tenant: string,
  tournamentId: string,
): Promise<PlayerRegistration[]> {
  const { pk, skPrefix } = allPlayersListKey(tenant, tournamentId);
  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': pk, ':s': skPrefix },
  });
  return items.map((i) => stripKeys<PlayerRegistration>(i)!);
}

/**
 * Register a squad member. Dedup on (tournament, school, naturalKey) via
 * `attribute_not_exists`, then atomically bump the entry's denormalized
 * `playerCount` so the organiser's inbox shows squad sizes without an N+1 of
 * COUNT queries.
 *
 * The two writes aren't transactional: a crash between them under-counts, but
 * `playerCount` is display-only — the PLAYER# items are the source of truth and
 * the count is recomputable from `listSquad` if it ever drifts. The bump is
 * conditioned on the entry still existing, because a bare ADD upserts and would
 * otherwise resurrect a phantom entry (pk + playerCount only) from a registration
 * racing a withdrawal.
 */
export async function createPlayer(tenant: string, player: PlayerRegistration): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...playerKey(tenant, player.tournamentId, player.schoolId, player.naturalKey),
        ...player,
      },
      ConditionExpression: 'attribute_not_exists(sk)',
    }),
  );
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: entryKey(tenant, player.tournamentId, player.schoolId),
        UpdateExpression: 'ADD playerCount :one',
        ConditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
        ExpressionAttributeValues: { ':one': 1 },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
}

export async function getPlayer(
  tenant: string,
  tournamentId: string,
  schoolId: string,
  naturalKey: string,
): Promise<PlayerRegistration | null> {
  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: playerKey(tenant, tournamentId, schoolId, naturalKey),
    }),
  );
  return stripKeys<PlayerRegistration>(res.Item);
}

/**
 * Version-checked update of a squad member (roster edits, ID-doc mark, captain
 * flag). Legacy rows without a version are treated as 0, same convention as
 * updateSchool. A lost race throws VersionConflictError (→ 409).
 */
export async function updatePlayer(
  tenant: string,
  tournamentId: string,
  schoolId: string,
  naturalKey: string,
  patch: Partial<PlayerRegistration>,
): Promise<PlayerRegistration> {
  const current = await getPlayer(tenant, tournamentId, schoolId, naturalKey);
  if (!current) throw new Error('player not found');
  const expectedVersion = patch.version ?? current.version ?? 0;
  const next: PlayerRegistration = {
    ...current,
    ...patch,
    naturalKey,
    tournamentId,
    schoolId,
    version: expectedVersion + 1,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { ...playerKey(tenant, tournamentId, schoolId, naturalKey), ...next },
        ConditionExpression:
          'attribute_exists(sk) AND (version = :v OR attribute_not_exists(version))',
        ExpressionAttributeValues: { ':v': expectedVersion },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new VersionConflictError();
    }
    throw err;
  }
  return next;
}

/**
 * Remove a squad member and decrement the entry's count. The delete is
 * conditional on the row existing so a double-submit doesn't drive the
 * denormalized count negative.
 */
export async function deletePlayer(
  tenant: string,
  tournamentId: string,
  schoolId: string,
  naturalKey: string,
): Promise<boolean> {
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: playerKey(tenant, tournamentId, schoolId, naturalKey),
        ConditionExpression: 'attribute_exists(sk)',
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: entryKey(tenant, tournamentId, schoolId),
        UpdateExpression: 'ADD playerCount :minusOne',
        ConditionExpression: 'attribute_exists(sk) AND playerCount > :zero',
        ExpressionAttributeValues: { ':minusOne': -1, ':zero': 0 },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
  return true;
}

// ── Tenant erasure (POPIA offboarding) ──

/** BatchWrite deletes in chunks of 25 (the DynamoDB per-request cap). */
async function batchDelete(keys: Array<{ pk: string; sk: string }>): Promise<void> {
  for (let i = 0; i < keys.length; i += 25) {
    const chunk = keys.slice(i, i + 25);
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: { [TABLE]: chunk.map((Key) => ({ DeleteRequest: { Key } })) },
      }),
    );
  }
}

/**
 * Erase every trace of a tenant: config, schools, tournaments, entries, squads,
 * invite markers, user-tenant markers, and the uploaded files behind them.
 *
 * The school SIGNUP token is tenant-enumerable via the CONFIG pointer and, left
 * alive, would still pass the signup route's token lookup — so it is revoked
 * FIRST, before the CONFIG row (and with it the pointer) is deleted. Per-entry
 * squad-registration tokens aren't enumerable that way, but they harmlessly
 * resolve to a now-deleted entry (404) after erasure.
 *
 * Note: this deletes only the tenant's marker for a user, not the user's META
 * record or Cognito account — a user who belongs to another tenant keeps it.
 */
export async function eraseTenantData(tenant: string): Promise<number> {
  const config = await getTenantConfig(tenant);
  if (config?.schoolSignupLink?.token) await deleteToken(config.schoolSignupLink.token);

  const keys: Array<{ pk: string; sk: string }> = [tenantConfigKey(tenant)];
  const objectKeys: string[] = [];

  for (const school of await listSchools(tenant)) {
    keys.push(schoolKey(tenant, school.id));
    // Mirror pointers live under the school and carry no gsi1 — enumerate them.
    for (const m of await listSchoolEntries(tenant, school.id)) {
      keys.push(schoolEntryKey(tenant, school.id, m.tournamentId));
    }
    // Invite markers aren't in the gsi1 listing either.
    for (const k of await listSchoolInviteKeys(tenant, school.id)) keys.push(k);
  }

  for (const t of await listTournaments(tenant)) {
    keys.push(tournamentKey(tenant, t.id));
    for (const e of await listEntries(tenant, t.id)) {
      keys.push(entryKey(tenant, t.id, e.schoolId));
      if (e.squadRegLink?.token) await deleteToken(e.squadRegLink.token);
      objectKeys.push(...entryDocObjectKeys(e));
    }
    for (const p of await listAllPlayers(tenant, t.id)) {
      keys.push(playerKey(tenant, t.id, p.schoolId, p.naturalKey));
      if (p.idDocMeta?.objectKey) objectKeys.push(p.idDocMeta.objectKey);
    }
  }

  // Facilities / ticketing / parking modules. Tickets carry buyer contact and
  // parking passes carry names + vehicle registrations — all PII — so they must
  // go, and their live QR scan tokens revoked before the records vanish.
  for (const a of await listAssessments(tenant)) {
    keys.push(assessmentKey(tenant, a.id));
    for (const ph of a.photos ?? []) if (ph.objectKey) objectKeys.push(ph.objectKey);
  }
  for (const tt of await listTicketTypes(tenant)) keys.push(ticketTypeKey(tenant, tt.id));
  for (const tk of await listTickets(tenant)) {
    keys.push(ticketKey(tenant, tk.id));
    if (tk.qrToken) await deleteToken(tk.qrToken);
  }
  for (const z of await listParkingZones(tenant)) keys.push(parkingZoneKey(tenant, z.id));
  for (const pp of await listParkingPasses(tenant)) {
    keys.push(parkingPassKey(tenant, pp.id));
    if (pp.qrToken) await deleteToken(pp.qrToken);
  }

  // Academic-support module. Student-athlete records, check-ins, interventions and
  // mentors are sensitive academic PII held under POPIA consent, so they must be
  // erased — along with any live mentor-plan link token.
  for (const a of await listAthletes(tenant)) keys.push(athleteKey(tenant, a.id));
  for (const m of await listMentors(tenant)) keys.push(mentorKey(tenant, m.id));
  for (const c of await listCheckIns(tenant)) {
    keys.push(checkInKey(tenant, c.id));
    if (c.token) await deleteToken(c.token);
  }
  for (const iv of await listInterventions(tenant)) keys.push(interventionKey(tenant, iv.id));

  for (const u of await listTenantUsers(tenant)) keys.push(userTenantMarkerKey(u.sub, tenant));

  await batchDelete(keys);
  await deleteUploadObjects(objectKeys);
  return keys.length;
}

/**
 * Blank a tenant's DATA (schools + tournaments + entries + squads) while KEEPING
 * the tenant config and all users/markers. Used to wipe demo data from a real
 * tenant. Builds the delete set independently of eraseTenantData (which also
 * removes config + users) and asserts no config/user key slips in. Idempotent.
 */
export async function clearCohort(tenant: string): Promise<number> {
  const keys: Array<{ pk: string; sk: string }> = [];
  const objectKeys: string[] = [];

  for (const school of await listSchools(tenant)) {
    keys.push(schoolKey(tenant, school.id));
    for (const m of await listSchoolEntries(tenant, school.id)) {
      keys.push(schoolEntryKey(tenant, school.id, m.tournamentId));
    }
    for (const k of await listSchoolInviteKeys(tenant, school.id)) keys.push(k);
  }
  for (const t of await listTournaments(tenant)) {
    keys.push(tournamentKey(tenant, t.id));
    for (const e of await listEntries(tenant, t.id)) {
      keys.push(entryKey(tenant, t.id, e.schoolId));
      objectKeys.push(...entryDocObjectKeys(e));
    }
    for (const p of await listAllPlayers(tenant, t.id)) {
      keys.push(playerKey(tenant, t.id, p.schoolId, p.naturalKey));
      if (p.idDocMeta?.objectKey) objectKeys.push(p.idDocMeta.objectKey);
    }
  }

  // Safety: never delete the tenant config or any user record.
  for (const k of keys) {
    if (k.sk === 'CONFIG' || k.pk.startsWith('USER#')) {
      throw new Error(`refusing to clear cohort: unexpected key ${k.pk} / ${k.sk}`);
    }
  }
  await batchDelete(keys);
  await deleteUploadObjects(objectKeys);
  return keys.length;
}

/**
 * Erase ONE school and everything it has ever entered (organiser deleting a junk
 * signup, or a POPIA "right to erasure" request). The caller passes the
 * already-read school so this never re-reads or guesses; user memberships are the
 * ROUTE's job (it must sweep them BEFORE calling this).
 *
 * Ordering is the re-deletable invariant: every step is idempotent and the school
 * META is deleted via a separate DeleteCommand only AFTER the cascade fully
 * succeeds (BatchWrite is unordered within a chunk, so "META last in the array"
 * would not actually be last). A crash at any point leaves a school that still
 * 200s on re-delete; only a complete cascade makes it 404.
 */
export async function eraseSchoolData(
  tenant: string,
  school: School,
): Promise<{ entries: number; players: number }> {
  const mirrors = await listSchoolEntries(tenant, school.id);
  let players = 0;

  for (const m of mirrors) {
    const entry = await getEntry(tenant, m.tournamentId, school.id);
    if (entry) {
      const res = await eraseEntryData(tenant, entry);
      players += res.players;
    } else {
      // Mirror with no canonical (a prior partial erase) — clear the pointer.
      await ddb.send(
        new DeleteCommand({
          TableName: TABLE,
          Key: schoolEntryKey(tenant, school.id, m.tournamentId),
        }),
      );
    }
  }

  const keys: Array<{ pk: string; sk: string }> = [];
  for (const k of await listSchoolInviteKeys(tenant, school.id)) keys.push(k);
  await batchDelete(keys);

  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: schoolKey(tenant, school.id) }));
  return { entries: mirrors.length, players };
}

/**
 * Erase ONE tournament: its entries, their squads, the uploaded entry packs and
 * the school-side mirrors that point at it. Same re-deletable ordering as
 * eraseSchoolData — the tournament META goes last.
 */
export async function eraseTournamentData(
  tenant: string,
  tournamentId: string,
): Promise<{ entries: number; players: number }> {
  const entries = await listEntries(tenant, tournamentId);
  let players = 0;
  for (const e of entries) {
    const res = await eraseEntryData(tenant, e);
    players += res.players;
  }
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: tournamentKey(tenant, tournamentId) }));
  return { entries: entries.length, players };
}

// ── QR scan tokens (global, for gate check-in) ──

/**
 * A ticket or parking QR token, in the same global TOKEN# keyspace as the reg
 * links but discriminated by `kind`. A gate marshal's scan resolves the token to
 * its tenant + record without the device knowing the tenant up front. Minted
 * alongside the ticket/pass and deleted when it is voided.
 */
export async function putScanToken(
  token: string,
  scope: { tenant: string; kind: 'ticket' | 'parking'; refId: string },
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...tokenKey(token), ...scope, createdAt: new Date().toISOString() },
    }),
  );
}

export async function getScanToken(token: string): Promise<{
  tenant: string;
  kind: 'ticket' | 'parking';
  refId: string;
} | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: tokenKey(token) }));
  const item = stripKeys<{ tenant: string; kind: 'ticket' | 'parking'; refId: string }>(res.Item);
  // A reg-link token in the same keyspace has no matching kind — reject it so a
  // squad link can never be used to check in at a gate.
  if (!item || (item.kind !== 'ticket' && item.kind !== 'parking')) return null;
  return item;
}

// ── Venue assessments (facilities module) ──

export async function listAssessments(tenant: string): Promise<VenueAssessment[]> {
  const items = await queryAll({
    TableName: TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': assessmentsListGsi1pk(tenant) },
  });
  return items.map((i) => stripKeys<VenueAssessment>(i)!);
}

export async function getAssessment(tenant: string, id: string): Promise<VenueAssessment | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: assessmentKey(tenant, id) }));
  return stripKeys<VenueAssessment>(res.Item);
}

export async function putAssessment(tenant: string, a: VenueAssessment): Promise<VenueAssessment> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...assessmentKey(tenant, a.id),
        ...assessmentGsi1(tenant, a.assessedAt),
        ...a,
        version: a.version ?? 1,
      },
    }),
  );
  return a;
}

export async function updateAssessment(
  tenant: string,
  id: string,
  patch: Partial<VenueAssessment>,
  changedBy: string,
  changedAt: string,
): Promise<VenueAssessment> {
  const current = await getAssessment(tenant, id);
  if (!current) throw new Error('assessment not found');
  const expectedVersion = patch.version ?? current.version ?? 0;
  const next: VenueAssessment = {
    ...current,
    ...patch,
    id,
    version: expectedVersion + 1,
    changedBy,
    changedAt,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          ...assessmentKey(tenant, id),
          ...assessmentGsi1(tenant, next.assessedAt),
          ...next,
        },
        ConditionExpression: 'version = :v',
        ExpressionAttributeValues: { ':v': expectedVersion },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new VersionConflictError();
    }
    throw err;
  }
  return next;
}

export async function deleteAssessment(tenant: string, id: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: assessmentKey(tenant, id) }));
}

// ── Ticketing: ticket types ──

export async function listTicketTypes(tenant: string): Promise<TicketType[]> {
  const items = await queryAll({
    TableName: TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': ticketTypesListGsi1pk(tenant) },
  });
  return items.map((i) => stripKeys<TicketType>(i)!);
}

export async function getTicketType(tenant: string, id: string): Promise<TicketType | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: ticketTypeKey(tenant, id) }));
  return stripKeys<TicketType>(res.Item);
}

export async function putTicketType(tenant: string, t: TicketType): Promise<TicketType> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...ticketTypeKey(tenant, t.id),
        ...ticketTypeGsi1(tenant, t.eventId),
        ...t,
        version: t.version ?? 1,
      },
    }),
  );
  return t;
}

export async function updateTicketType(
  tenant: string,
  id: string,
  patch: Partial<TicketType>,
): Promise<TicketType> {
  const current = await getTicketType(tenant, id);
  if (!current) throw new Error('ticket type not found');
  const expectedVersion = patch.version ?? current.version ?? 0;
  const next: TicketType = { ...current, ...patch, id, version: expectedVersion + 1 };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { ...ticketTypeKey(tenant, id), ...ticketTypeGsi1(tenant, next.eventId), ...next },
        ConditionExpression: 'version = :v',
        ExpressionAttributeValues: { ':v': expectedVersion },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new VersionConflictError();
    }
    throw err;
  }
  return next;
}

export async function deleteTicketType(tenant: string, id: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: ticketTypeKey(tenant, id) }));
}

/** Atomically bump a ticket type's denormalized `sold` count. */
export async function bumpTicketTypeSold(tenant: string, id: string, delta: number): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: ticketTypeKey(tenant, id),
        UpdateExpression: 'ADD sold :d',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':d': delta },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
}

// ── Ticketing: issued tickets ──

export async function listTickets(tenant: string): Promise<Ticket[]> {
  const items = await queryAll({
    TableName: TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': ticketsListGsi1pk(tenant) },
  });
  return items.map((i) => stripKeys<Ticket>(i)!);
}

export async function getTicket(tenant: string, id: string): Promise<Ticket | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: ticketKey(tenant, id) }));
  return stripKeys<Ticket>(res.Item);
}

/**
 * Issue a ticket and mint its scan token. Not transactional with the count bump:
 * `sold` is a display-only denormalization recomputable from the tickets, so a
 * crash between the two under-counts rather than corrupting anything.
 */
export async function createTicket(tenant: string, t: Ticket): Promise<Ticket> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...ticketKey(tenant, t.id),
        ...ticketGsi1(tenant, t.eventId),
        ...t,
        version: t.version ?? 1,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
  await putScanToken(t.qrToken, { tenant, kind: 'ticket', refId: t.id });
  await bumpTicketTypeSold(tenant, t.ticketTypeId, t.quantity);
  return t;
}

export async function updateTicket(
  tenant: string,
  id: string,
  patch: Partial<Ticket>,
): Promise<Ticket> {
  const current = await getTicket(tenant, id);
  if (!current) throw new Error('ticket not found');
  const expectedVersion = patch.version ?? current.version ?? 0;
  const next: Ticket = { ...current, ...patch, id, version: expectedVersion + 1 };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { ...ticketKey(tenant, id), ...ticketGsi1(tenant, next.eventId), ...next },
        ConditionExpression: 'version = :v',
        ExpressionAttributeValues: { ':v': expectedVersion },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new VersionConflictError();
    }
    throw err;
  }
  return next;
}

/** Void a ticket: mark it, revoke its scan token, and release its sold count. */
export async function voidTicket(tenant: string, id: string): Promise<Ticket> {
  const current = await getTicket(tenant, id);
  if (!current) throw new Error('ticket not found');
  const next = await updateTicket(tenant, id, {
    status: 'void',
    payment: current.payment === 'paid' ? 'refunded' : current.payment,
    version: current.version,
  });
  await deleteToken(current.qrToken);
  await bumpTicketTypeSold(tenant, current.ticketTypeId, -current.quantity);
  return next;
}

// ── Parking: zones ──

export async function listParkingZones(tenant: string): Promise<ParkingZone[]> {
  const items = await queryAll({
    TableName: TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': parkingZonesListGsi1pk(tenant) },
  });
  return items.map((i) => stripKeys<ParkingZone>(i)!);
}

export async function getParkingZone(tenant: string, id: string): Promise<ParkingZone | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: parkingZoneKey(tenant, id) }));
  return stripKeys<ParkingZone>(res.Item);
}

export async function putParkingZone(tenant: string, z: ParkingZone): Promise<ParkingZone> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...parkingZoneKey(tenant, z.id),
        ...parkingZoneGsi1(tenant, z.name),
        ...z,
        version: z.version ?? 1,
      },
    }),
  );
  return z;
}

export async function updateParkingZone(
  tenant: string,
  id: string,
  patch: Partial<ParkingZone>,
): Promise<ParkingZone> {
  const current = await getParkingZone(tenant, id);
  if (!current) throw new Error('parking zone not found');
  const expectedVersion = patch.version ?? current.version ?? 0;
  const next: ParkingZone = { ...current, ...patch, id, version: expectedVersion + 1 };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { ...parkingZoneKey(tenant, id), ...parkingZoneGsi1(tenant, next.name), ...next },
        ConditionExpression: 'version = :v',
        ExpressionAttributeValues: { ':v': expectedVersion },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new VersionConflictError();
    }
    throw err;
  }
  return next;
}

export async function deleteParkingZone(tenant: string, id: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: parkingZoneKey(tenant, id) }));
}

/** Atomically bump a zone's denormalized `allocated` count. */
export async function bumpZoneAllocated(tenant: string, id: string, delta: number): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: parkingZoneKey(tenant, id),
        UpdateExpression: 'ADD allocated :d',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':d': delta },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
}

// ── Parking: passes ──

export async function listParkingPasses(tenant: string): Promise<ParkingPass[]> {
  const items = await queryAll({
    TableName: TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': parkingPassesListGsi1pk(tenant) },
  });
  return items.map((i) => stripKeys<ParkingPass>(i)!);
}

export async function getParkingPass(tenant: string, id: string): Promise<ParkingPass | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: parkingPassKey(tenant, id) }));
  return stripKeys<ParkingPass>(res.Item);
}

export async function createParkingPass(tenant: string, p: ParkingPass): Promise<ParkingPass> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...parkingPassKey(tenant, p.id),
        ...parkingPassGsi1(tenant, p.eventId),
        ...p,
        version: p.version ?? 1,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
  await putScanToken(p.qrToken, { tenant, kind: 'parking', refId: p.id });
  await bumpZoneAllocated(tenant, p.zoneId, p.bays);
  return p;
}

export async function updateParkingPass(
  tenant: string,
  id: string,
  patch: Partial<ParkingPass>,
): Promise<ParkingPass> {
  const current = await getParkingPass(tenant, id);
  if (!current) throw new Error('parking pass not found');
  const expectedVersion = patch.version ?? current.version ?? 0;
  const next: ParkingPass = { ...current, ...patch, id, version: expectedVersion + 1 };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { ...parkingPassKey(tenant, id), ...parkingPassGsi1(tenant, next.eventId), ...next },
        ConditionExpression: 'version = :v',
        ExpressionAttributeValues: { ':v': expectedVersion },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new VersionConflictError();
    }
    throw err;
  }
  return next;
}

/** Void a pass: mark it, revoke its scan token, and release its bays. */
export async function voidParkingPass(tenant: string, id: string): Promise<ParkingPass> {
  const current = await getParkingPass(tenant, id);
  if (!current) throw new Error('parking pass not found');
  const next = await updateParkingPass(tenant, id, { status: 'void', version: current.version });
  await deleteToken(current.qrToken);
  await bumpZoneAllocated(tenant, current.zoneId, -current.bays);
  return next;
}

// ── Academic support: student-athletes ──

const athleteSortName = (a: StudentAthlete) =>
  `${a.lastName ?? ''} ${a.firstName ?? ''}`.trim().toLowerCase();

export async function listAthletes(tenant: string): Promise<StudentAthlete[]> {
  const items = await queryAll({
    TableName: TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': athletesListGsi1pk(tenant) },
  });
  return items.map((i) => stripKeys<StudentAthlete>(i)!);
}

export async function getAthlete(tenant: string, id: string): Promise<StudentAthlete | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: athleteKey(tenant, id) }));
  return stripKeys<StudentAthlete>(res.Item);
}

export async function putAthlete(tenant: string, a: StudentAthlete): Promise<StudentAthlete> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...athleteKey(tenant, a.id),
        ...athleteGsi1(tenant, athleteSortName(a)),
        ...a,
        version: a.version ?? 1,
      },
    }),
  );
  return a;
}

export async function updateAthlete(
  tenant: string,
  id: string,
  patch: Partial<StudentAthlete>,
  changedBy: string,
  changedAt: string,
): Promise<StudentAthlete> {
  const current = await getAthlete(tenant, id);
  if (!current) throw new Error('athlete not found');
  const expectedVersion = patch.version ?? current.version ?? 0;
  const next: StudentAthlete = {
    ...current,
    ...patch,
    id,
    version: expectedVersion + 1,
    changedBy,
    changedAt,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          ...athleteKey(tenant, id),
          ...athleteGsi1(tenant, athleteSortName(next)),
          ...next,
        },
        ConditionExpression: 'version = :v',
        ExpressionAttributeValues: { ':v': expectedVersion },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new VersionConflictError();
    }
    throw err;
  }
  return next;
}

export async function deleteAthlete(tenant: string, id: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: athleteKey(tenant, id) }));
}

// ── Academic support: external mentors ──

const mentorSortName = (m: Mentor) => (m.name ?? '').toLowerCase();

export async function listMentors(tenant: string): Promise<Mentor[]> {
  const items = await queryAll({
    TableName: TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': mentorsListGsi1pk(tenant) },
  });
  return items.map((i) => stripKeys<Mentor>(i)!);
}

export async function getMentor(tenant: string, id: string): Promise<Mentor | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: mentorKey(tenant, id) }));
  return stripKeys<Mentor>(res.Item);
}

export async function putMentor(tenant: string, m: Mentor): Promise<Mentor> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...mentorKey(tenant, m.id),
        ...mentorGsi1(tenant, mentorSortName(m)),
        ...m,
        version: m.version ?? 1,
      },
    }),
  );
  return m;
}

export async function updateMentor(
  tenant: string,
  id: string,
  patch: Partial<Mentor>,
): Promise<Mentor> {
  const current = await getMentor(tenant, id);
  if (!current) throw new Error('mentor not found');
  const next: Mentor = { ...current, ...patch, id, version: (current.version ?? 0) + 1 };
  await putMentor(tenant, next);
  return next;
}

export async function deleteMentor(tenant: string, id: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: mentorKey(tenant, id) }));
}

/**
 * Mint a mentor-plan token: it self-describes the tenant and the check-in it
 * completes, so the public completion page infers neither from the request.
 */
export async function putMentorPlanToken(
  token: string,
  scope: { tenant: string; checkInId: string; studentNumber: string },
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...tokenKey(token),
        ...scope,
        kind: 'mentor-plan',
        createdAt: new Date().toISOString(),
      },
    }),
  );
}

// ── Academic support: bi-weekly check-ins ──

export async function listCheckIns(tenant: string): Promise<AcademicCheckIn[]> {
  const items = await queryAll({
    TableName: TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': checkInsListGsi1pk(tenant) },
  });
  return items.map((i) => stripKeys<AcademicCheckIn>(i)!);
}

export async function getCheckIn(tenant: string, id: string): Promise<AcademicCheckIn | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: checkInKey(tenant, id) }));
  return stripKeys<AcademicCheckIn>(res.Item);
}

export async function putCheckIn(tenant: string, c: AcademicCheckIn): Promise<AcademicCheckIn> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...checkInKey(tenant, c.id),
        ...checkInGsi1(tenant, c.date),
        ...c,
        version: c.version ?? 1,
      },
    }),
  );
  return c;
}

export async function deleteCheckIn(tenant: string, id: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: checkInKey(tenant, id) }));
}

// ── Academic support: interventions ──

export async function listInterventions(tenant: string): Promise<AcademicIntervention[]> {
  const items = await queryAll({
    TableName: TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': interventionsListGsi1pk(tenant) },
  });
  return items.map((i) => stripKeys<AcademicIntervention>(i)!);
}

export async function getIntervention(
  tenant: string,
  id: string,
): Promise<AcademicIntervention | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: interventionKey(tenant, id) }),
  );
  return stripKeys<AcademicIntervention>(res.Item);
}

export async function putIntervention(
  tenant: string,
  iv: AcademicIntervention,
): Promise<AcademicIntervention> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...interventionKey(tenant, iv.id),
        ...interventionGsi1(tenant, iv.date),
        ...iv,
        version: iv.version ?? 1,
      },
    }),
  );
  return iv;
}

export async function updateIntervention(
  tenant: string,
  id: string,
  patch: Partial<AcademicIntervention>,
  changedBy: string,
  changedAt: string,
): Promise<AcademicIntervention> {
  const current = await getIntervention(tenant, id);
  if (!current) throw new Error('intervention not found');
  const expectedVersion = patch.version ?? current.version ?? 0;
  const next: AcademicIntervention = {
    ...current,
    ...patch,
    id,
    version: expectedVersion + 1,
    changedBy,
    changedAt,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          ...interventionKey(tenant, id),
          ...interventionGsi1(tenant, next.date),
          ...next,
        },
        ConditionExpression: 'version = :v',
        ExpressionAttributeValues: { ':v': expectedVersion },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new VersionConflictError();
    }
    throw err;
  }
  return next;
}

export async function deleteIntervention(tenant: string, id: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: interventionKey(tenant, id) }));
}
