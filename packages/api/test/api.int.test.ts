/**
 * Integration tests for the tournament, entry, squad and result write paths.
 *
 * Boots an in-process dynalite (pure-JS DynamoDB clone), creates the single
 * table, seeds a tenant, and drives the REAL Hono app via `app.request()` — no
 * network, no AWS. Auth uses the dev bypass (LOCAL_AUTH=1, x-dev-auth header),
 * the same path the offline stack uses.
 *
 * Run with the API package's test runner (tsx --test), which resolves the
 * NodeNext ".js" import specifiers to their ".ts" sources.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4599; // distinct from the dev stack's 4567
const TABLE = 'SchoolTournamentTest';
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.LOCAL_AUTH = '1';
process.env.STAGE = 'local';
process.env.USER_POOL_ID = 'test-pool';
process.env.AWS_REGION ??= 'localhost';
// Entry-pack view-url presigns locally (no network); dummy creds let SigV4 sign.
// A failed delete-on-replace must not hang the suite — cap S3 retries.
process.env.UPLOADS_BUCKET = 'test-uploads';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_MAX_ATTEMPTS = '1';

const TENANT = 'school';

const devAuth = (memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email: 'admin@test', memberships })).toString('base64');
const ADMIN = devAuth([{ tenantId: TENANT, role: 'admin', schoolIds: [] }]);
const REP = devAuth([{ tenantId: TENANT, role: 'rep', schoolIds: ['kearsney'] }]);
const OTHER_REP = devAuth([{ tenantId: TENANT, role: 'rep', schoolIds: ['hilton'] }]);

const headers = (auth: string) => ({
  'x-tenant': TENANT,
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

const req = (path: string, auth: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: headers(auth) });

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

// Resolved in before().
let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');

/** Create a tournament straight through the repo — fast, and bypasses route validation. */
async function makeTournament(id: string, overrides: Record<string, unknown> = {}) {
  await repo.putTournament(TENANT, {
    id,
    name: `Test ${id}`,
    sport: 'hockey',
    season: '2026',
    format: 'round_robin',
    poolCount: 1,
    startDate: '2026-09-25',
    endDate: '2026-09-27',
    entryDeadline: '2026-09-11',
    entryFee: 0,
    maxEntrants: 8,
    venues: [],
    entryDocs: ['indemnity'],
    status: 'open',
    fixtures: [],
    released: false,
    releasedAt: null,
    entryCount: 0,
    version: 1,
    ...overrides,
  } as never);
}

async function makeSchool(id: string, name = id) {
  // Already present from a prior run of this suite is fine — the conditional
  // create is the dedup, not a precondition of the test.
  await repo.createSchool(TENANT, { id, name, version: 1 } as never).catch(() => undefined);
}

before(async () => {
  const dynalite = (await import('dynalite')).default as (opts?: unknown) => Server;
  ddbServer = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => ddbServer.listen(DDB_PORT, resolve));

  const { DynamoDBClient, CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  const admin = new DynamoDBClient({
    endpoint: process.env.DYNAMO_ENDPOINT,
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  await admin.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi1pk', AttributeType: 'S' },
        { AttributeName: 'gsi1sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );

  const seed = await import('../src/seed-core.js');
  await seed.seedTenantConfig(TENANT);
  ({ app } = await import('../src/index.js'));
  repo = await import('../src/repo.js');

  await makeSchool('kearsney', 'Kearsney College');
  await makeSchool('hilton', 'Hilton College');
  await makeSchool('grey-college', 'Grey College');
});

after(() => {
  ddbServer?.close();
});

/* ─────────────────────────── Tournaments ─────────────────────────── */

describe('tournaments', () => {
  test('organiser creates one; a rep cannot', async () => {
    const body = JSON.stringify({
      name: 'Spring Cup',
      sport: 'hockey',
      startDate: '2026-09-25',
      endDate: '2026-09-27',
      entryDeadline: '2026-09-01',
    });
    const denied = await req('/tournaments', REP, { method: 'POST', body });
    assert.equal(denied.status, 403);

    const res = await req('/tournaments', ADMIN, { method: 'POST', body });
    assert.equal(res.status, 201);
    const t = await json<{ id: string; status: string; format: string }>(res);
    assert.equal(t.status, 'draft');
    assert.equal(t.format, 'pool_playoff');
  });

  test('an unknown sport is rejected', async () => {
    const res = await req('/tournaments', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ name: 'Quidditch Cup', sport: 'quidditch', startDate: '2026-09-25' }),
    });
    assert.equal(res.status, 400);
  });

  test('a meet cannot be given a bracket format', async () => {
    const res = await req('/tournaments', ADMIN, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Autumn Meet',
        sport: 'athletics',
        format: 'pool_playoff',
        startDate: '2026-10-09',
      }),
    });
    assert.equal(res.status, 400);
  });

  test('an entry deadline after the start date is rejected', async () => {
    const res = await req('/tournaments', ADMIN, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Late Cup',
        sport: 'rugby',
        startDate: '2026-09-01',
        entryDeadline: '2026-09-20',
      }),
    });
    assert.equal(res.status, 400);
  });

  test('a rep never sees a draft tournament', async () => {
    await makeTournament('draft-cup', { status: 'draft' });
    assert.equal((await req('/tournaments/draft-cup', REP, {})).status, 404);
    assert.equal((await req('/tournaments/draft-cup', ADMIN, {})).status, 200);
  });
});

/* ───────────────────────────── Entries ───────────────────────────── */

describe('entries', () => {
  test('a rep enters its own school, and only once', async () => {
    await makeTournament('entry-cup');
    const body = JSON.stringify({ schoolId: 'kearsney', teamName: 'Kearsney U16A' });

    const first = await req('/tournaments/entry-cup/entries', REP, { method: 'POST', body });
    assert.equal(first.status, 201);
    const entry = await json<{ status: string; teamName: string }>(first);
    assert.equal(entry.status, 'pending');
    assert.equal(entry.teamName, 'Kearsney U16A');

    const dup = await req('/tournaments/entry-cup/entries', REP, { method: 'POST', body });
    assert.equal(dup.status, 409);
  });

  test('a rep cannot enter a school it does not represent', async () => {
    await makeTournament('scope-cup');
    const res = await req('/tournaments/scope-cup/entries', REP, {
      method: 'POST',
      body: JSON.stringify({ schoolId: 'hilton' }),
    });
    assert.equal(res.status, 403);
  });

  test('entries close for schools but the organiser may still add one', async () => {
    await makeTournament('closed-cup', { status: 'closed' });
    const rep = await req('/tournaments/closed-cup/entries', REP, {
      method: 'POST',
      body: JSON.stringify({ schoolId: 'kearsney' }),
    });
    assert.equal(rep.status, 409);

    const organiser = await req('/tournaments/closed-cup/entries', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ schoolId: 'kearsney' }),
    });
    assert.equal(organiser.status, 201);
  });

  test('a rep sees only its own entry in the list', async () => {
    await makeTournament('list-cup');
    for (const schoolId of ['kearsney', 'hilton']) {
      await req('/tournaments/list-cup/entries', ADMIN, {
        method: 'POST',
        body: JSON.stringify({ schoolId }),
      });
    }
    const asAdmin = await json<unknown[]>(await req('/tournaments/list-cup/entries', ADMIN, {}));
    assert.equal(asAdmin.length, 2);

    const asRep = await json<{ schoolId: string }[]>(
      await req('/tournaments/list-cup/entries', REP, {}),
    );
    assert.equal(asRep.length, 1);
    assert.equal(asRep[0].schoolId, 'kearsney');
  });

  test('a rep cannot set the fields that decide its own fate', async () => {
    await makeTournament('decide-cup');
    await req('/tournaments/decide-cup/entries', REP, {
      method: 'POST',
      body: JSON.stringify({ schoolId: 'kearsney' }),
    });
    for (const patch of [{ status: 'accepted' }, { pool: 'A' }, { entryFeePaid: true }]) {
      const res = await req('/tournaments/decide-cup/entries/kearsney', REP, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      assert.equal(res.status, 403, `expected 403 for ${JSON.stringify(patch)}`);
    }
    // Its own logistics are fair game.
    const ok = await req('/tournaments/decide-cup/entries/kearsney', REP, {
      method: 'PATCH',
      body: JSON.stringify({ logistics: { partySize: 20, overnight: true } }),
    });
    assert.equal(ok.status, 200);
  });

  test('acceptance stops at the capacity cap but stays idempotent', async () => {
    await makeTournament('full-cup', { maxEntrants: 2 });
    for (const schoolId of ['kearsney', 'hilton', 'grey-college']) {
      await req('/tournaments/full-cup/entries', ADMIN, {
        method: 'POST',
        body: JSON.stringify({ schoolId }),
      });
    }
    const accept = (schoolId: string) =>
      req(`/tournaments/full-cup/entries/${schoolId}/decision`, ADMIN, {
        method: 'POST',
        body: JSON.stringify({ status: 'accepted' }),
      });

    assert.equal((await accept('kearsney')).status, 200);
    assert.equal((await accept('hilton')).status, 200);
    assert.equal((await accept('grey-college')).status, 409, 'third is over capacity');
    assert.equal((await accept('kearsney')).status, 200, 're-confirming must not trip the cap');
  });

  test('deleting an entry cascades its squad and the school-side mirror', async () => {
    await makeTournament('cascade-cup');
    await req('/tournaments/cascade-cup/entries', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ schoolId: 'kearsney' }),
    });
    await req('/tournaments/cascade-cup/entries/kearsney/players', ADMIN, {
      method: 'POST',
      body: JSON.stringify({
        firstName: 'Ayanda',
        lastName: 'Khumalo',
        dob: '2010-04-02',
        guardianName: 'N. Khumalo',
      }),
    });
    assert.equal((await repo.listSquad(TENANT, 'cascade-cup', 'kearsney')).length, 1);

    const res = await req('/tournaments/cascade-cup/entries/kearsney', ADMIN, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal((await repo.listSquad(TENANT, 'cascade-cup', 'kearsney')).length, 0);
    assert.equal(await repo.getEntry(TENANT, 'cascade-cup', 'kearsney'), null);
    const mirrors = await repo.listSchoolEntries(TENANT, 'kearsney');
    assert.equal(
      mirrors.some((m) => m.tournamentId === 'cascade-cup'),
      false,
      'a stale mirror would show a ghost entry in the school portal',
    );
  });
});

/* ────────────────────────────── Squads ───────────────────────────── */

describe('squads', () => {
  before(async () => {
    await makeTournament('squad-cup', { sport: 'netball' });
    await req('/tournaments/squad-cup/entries', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ schoolId: 'kearsney' }),
    });
  });

  const addPlayer = (first: string) =>
    req('/tournaments/squad-cup/entries/kearsney/players', ADMIN, {
      method: 'POST',
      body: JSON.stringify({
        firstName: first,
        lastName: 'Player',
        dob: '2010-04-02',
        guardianName: 'A Guardian',
      }),
    });

  test('a minor without a guardian is rejected (POPIA)', async () => {
    const res = await req('/tournaments/squad-cup/entries/kearsney/players', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ firstName: 'No', lastName: 'Guardian', dob: '2012-01-01' }),
    });
    assert.equal(res.status, 400);
  });

  test('registering bumps the entry count, and a duplicate 409s', async () => {
    assert.equal((await addPlayer('Thandi')).status, 201);
    const entry = await json<{ players: number }>(
      await req('/tournaments/squad-cup/entries/kearsney', ADMIN, {}),
    );
    assert.equal(entry.players, 1);
    assert.equal((await addPlayer('Thandi')).status, 409, 'same name + dob is the same person');
  });

  test('submitting an under-strength squad is refused with the reason', async () => {
    const res = await req('/tournaments/squad-cup/entries/kearsney/squad/submit', ADMIN, {
      method: 'POST',
    });
    assert.equal(res.status, 400);
    const body = await json<{ error: string }>(res);
    assert.match(body.error, /minimum is 7/);
  });

  test('a full squad submits, and the cap then holds', async () => {
    for (const name of ['B', 'C', 'D', 'E', 'F', 'G']) await addPlayer(name);
    const ok = await req('/tournaments/squad-cup/entries/kearsney/squad/submit', ADMIN, {
      method: 'POST',
    });
    assert.equal(ok.status, 200);

    // Netball's max is 12: fill to the cap, then expect a refusal.
    for (const name of ['H', 'I', 'J', 'K', 'L']) await addPlayer(name);
    assert.equal((await addPlayer('M')).status, 409);
  });

  test('removing a player decrements the count', async () => {
    const before = await json<{ players: number }>(
      await req('/tournaments/squad-cup/entries/kearsney', ADMIN, {}),
    );
    const squad = await repo.listSquad(TENANT, 'squad-cup', 'kearsney');
    const res = await req(
      `/tournaments/squad-cup/entries/kearsney/players/${encodeURIComponent(squad[0].naturalKey)}`,
      ADMIN,
      { method: 'DELETE' },
    );
    assert.equal(res.status, 200);
    const after = await json<{ players: number }>(
      await req('/tournaments/squad-cup/entries/kearsney', ADMIN, {}),
    );
    assert.equal(after.players, before.players - 1);
  });

  test('another school’s rep cannot read a squad', async () => {
    const res = await req('/tournaments/squad-cup/entries/kearsney/players', OTHER_REP, {});
    assert.equal(res.status, 403);
  });
});

/* ─────────────────────── Entry-pack documents ────────────────────── */

describe('entry-pack documents', () => {
  before(async () => {
    await makeTournament('docs-cup');
    await req('/tournaments/docs-cup/entries', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ schoolId: 'kearsney' }),
    });
  });

  test('an unknown doc key is refused before any S3 work', async () => {
    const res = await req('/tournaments/docs-cup/entries/kearsney/docs/bribe/upload-url', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ contentType: 'application/pdf' }),
    });
    assert.equal(res.status, 400);
  });

  test('an objectKey from another entry is rejected', async () => {
    const res = await req('/tournaments/docs-cup/entries/kearsney/docs/indemnity', ADMIN, {
      method: 'PATCH',
      body: JSON.stringify({
        objectKey: `${TENANT}/docs-cup/hilton/indemnity-abc.pdf`,
        size: 1000,
      }),
    });
    assert.equal(res.status, 400);
  });

  test('an objectKey from another tournament is rejected', async () => {
    const res = await req('/tournaments/docs-cup/entries/kearsney/docs/indemnity', ADMIN, {
      method: 'PATCH',
      body: JSON.stringify({
        objectKey: `${TENANT}/other-cup/kearsney/indemnity-abc.pdf`,
        size: 1000,
      }),
    });
    assert.equal(res.status, 400);
  });

  test('a single-file doc records and completes', async () => {
    const res = await req('/tournaments/docs-cup/entries/kearsney/docs/indemnity', ADMIN, {
      method: 'PATCH',
      body: JSON.stringify({
        objectKey: `${TENANT}/docs-cup/kearsney/indemnity-1.pdf`,
        size: 2048,
        contentType: 'application/pdf',
      }),
    });
    assert.equal(res.status, 200);
    const entry = await json<{ docs: Record<string, boolean> }>(res);
    assert.equal(entry.docs.indemnity, true);
  });

  test('a multi-file doc only completes at its minimum', async () => {
    const put = (n: number) =>
      req('/tournaments/docs-cup/entries/kearsney/docs/safeguarding', ADMIN, {
        method: 'PATCH',
        body: JSON.stringify({
          objectKey: `${TENANT}/docs-cup/kearsney/safeguarding-${n}.pdf`,
          size: 1024,
          contentType: 'application/pdf',
        }),
      });

    const one = await json<{ docs: Record<string, boolean> }>(await put(1));
    assert.equal(one.docs.safeguarding, false, 'one certificate is not enough');

    const two = await json<{ docs: Record<string, boolean> }>(await put(2));
    assert.equal(two.docs.safeguarding, true, 'two certificates satisfy it');
  });

  test('removing a file drops the doc back below its minimum', async () => {
    const res = await req('/tournaments/docs-cup/entries/kearsney/docs/safeguarding/file', ADMIN, {
      method: 'DELETE',
      body: JSON.stringify({ objectKey: `${TENANT}/docs-cup/kearsney/safeguarding-2.pdf` }),
    });
    assert.equal(res.status, 200);
    const entry = await json<{ docs: Record<string, boolean> }>(res);
    assert.equal(entry.docs.safeguarding, false);
  });

  test('view-url refuses a key that is not on record', async () => {
    const res = await req('/tournaments/docs-cup/entries/kearsney/docs/insurance/view-url', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ objectKey: `${TENANT}/docs-cup/kearsney/insurance-ghost.pdf` }),
    });
    assert.equal(res.status, 404);
  });
});

/* ────────────────────────── Draws & results ──────────────────────── */

describe('draws and results', () => {
  const fixtures = [
    {
      id: 'f1',
      stage: 'pool',
      pool: 'A',
      round: 1,
      date: '2026-09-25',
      home: 'kearsney',
      away: 'hilton',
      venueId: null,
      time: null,
      result: null,
    },
    {
      id: 'f2',
      stage: 'pool',
      pool: 'A',
      round: 2,
      date: '2026-09-26',
      home: 'kearsney',
      away: 'grey-college',
      venueId: null,
      time: null,
      result: null,
    },
  ];

  before(async () => {
    await makeTournament('draw-cup');
    for (const schoolId of ['kearsney', 'hilton', 'grey-college']) {
      await req('/tournaments/draw-cup/entries', ADMIN, {
        method: 'POST',
        body: JSON.stringify({ schoolId }),
      });
    }
  });

  test('the draw stores, and duplicate fixture ids are refused', async () => {
    const bad = await req('/tournaments/draw-cup/draw', ADMIN, {
      method: 'PUT',
      body: JSON.stringify({ fixtures: [fixtures[0], { ...fixtures[1], id: 'f1' }] }),
    });
    assert.equal(bad.status, 400);

    const res = await req('/tournaments/draw-cup/draw', ADMIN, {
      method: 'PUT',
      body: JSON.stringify({ fixtures }),
    });
    assert.equal(res.status, 200);
    const t = await json<{ fixtures: unknown[] }>(res);
    assert.equal(t.fixtures.length, 2);
  });

  test('a fixture with the same team on both sides is refused', async () => {
    const res = await req('/tournaments/draw-cup/draw', ADMIN, {
      method: 'PUT',
      body: JSON.stringify({ fixtures: [{ ...fixtures[0], id: 'f9', away: 'kearsney' }] }),
    });
    assert.equal(res.status, 400);
  });

  test('a result captures without disturbing the other fixture; a rep may not capture', async () => {
    const denied = await req('/tournaments/draw-cup/fixtures/f1/result', REP, {
      method: 'POST',
      body: JSON.stringify({ status: 'played', homeScore: 3, awayScore: 1 }),
    });
    assert.equal(denied.status, 403);

    const res = await req('/tournaments/draw-cup/fixtures/f1/result', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ status: 'played', homeScore: 3, awayScore: 1 }),
    });
    assert.equal(res.status, 200);
    const t = await json<{ fixtures: { id: string; result: { homeScore: number } | null }[] }>(res);
    assert.equal(t.fixtures.find((f) => f.id === 'f1')?.result?.homeScore, 3);
    assert.equal(t.fixtures.find((f) => f.id === 'f2')?.result, null);
  });

  test('a malformed result is refused', async () => {
    for (const body of [
      { status: 'played', homeScore: 3 }, // missing away
      { status: 'played', homeScore: -1, awayScore: 0 }, // negative
      { status: 'played', homeScore: 1.5, awayScore: 0 }, // fractional
      { status: 'forfeit' }, // no forfeiting team
      { status: 'forfeit', forfeitBy: 'grey-college' }, // not in this fixture
    ]) {
      const res = await req('/tournaments/draw-cup/fixtures/f1/result', ADMIN, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
  });

  test('regenerating a draw over captured results needs an explicit force', async () => {
    const blocked = await req('/tournaments/draw-cup/draw', ADMIN, {
      method: 'PUT',
      body: JSON.stringify({ fixtures }),
    });
    assert.equal(blocked.status, 409);

    const forced = await req('/tournaments/draw-cup/draw?force=1', ADMIN, {
      method: 'PUT',
      body: JSON.stringify({ fixtures }),
    });
    assert.equal(forced.status, 200);
  });

  test('a rep sees neither an unreleased draw nor unpublished results', async () => {
    await req('/tournaments/draw-cup/fixtures/f1/result', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ status: 'played', homeScore: 3, awayScore: 1 }),
    });

    const hidden = await json<{ fixtures: unknown[] }>(await req('/tournaments/draw-cup', REP, {}));
    assert.equal(hidden.fixtures.length, 0, 'an unreleased draw is not shown at all');

    await req('/tournaments/draw-cup', ADMIN, {
      method: 'PATCH',
      body: JSON.stringify({ released: true }),
    });
    const released = await json<{ fixtures: { result: unknown }[] }>(
      await req('/tournaments/draw-cup', REP, {}),
    );
    assert.equal(released.fixtures.length, 2, 'a released draw is visible');
    assert.equal(
      released.fixtures.every((f) => f.result === null),
      true,
      'results stay hidden until published',
    );

    await req('/tournaments/draw-cup', ADMIN, {
      method: 'PATCH',
      body: JSON.stringify({ resultsReleased: true }),
    });
    const withResults = await json<{ fixtures: { id: string; result: unknown }[] }>(
      await req('/tournaments/draw-cup', REP, {}),
    );
    assert.notEqual(withResults.fixtures.find((f) => f.id === 'f1')?.result, null);
  });

  test('a meet has no draw to store', async () => {
    await makeTournament('meet-cup', { sport: 'athletics', format: 'meet' });
    const res = await req('/tournaments/meet-cup/draw', ADMIN, {
      method: 'PUT',
      body: JSON.stringify({ fixtures }),
    });
    assert.equal(res.status, 400);
  });
});

/* ─────────────────────── Public squad registration ───────────────── */

describe('public squad registration', () => {
  let token: string;

  before(async () => {
    await makeTournament('public-cup');
    await req('/tournaments/public-cup/entries', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ schoolId: 'kearsney' }),
    });
    const res = await req('/tournaments/public-cup/entries/kearsney/squad-link', ADMIN, {
      method: 'POST',
    });
    const body = await json<{ squadRegLink: { token: string } }>(res);
    token = body.squadRegLink.token;
  });

  test('the link resolves without auth', async () => {
    const res = await app.request(`/register/public-cup/kearsney?t=${token}`);
    assert.equal(res.status, 200);
    const body = await json<{ schoolName: string; tournamentName: string }>(res);
    assert.equal(body.schoolName, 'Kearsney College');
    assert.equal(body.tournamentName, 'Test public-cup');
  });

  test('a token for one entry does not open another', async () => {
    await req('/tournaments/public-cup/entries', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ schoolId: 'hilton' }),
    });
    const res = await app.request(`/register/public-cup/hilton?t=${token}`);
    assert.equal(res.status, 404);
  });

  test('registration works, dedups, and enforces guardian consent', async () => {
    const post = (body: unknown) =>
      app.request(`/register/public-cup/kearsney?t=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    assert.equal(
      (await post({ firstName: 'A', lastName: 'B', dob: '2012-01-01' })).status,
      400,
      'a minor needs a guardian',
    );

    const player = {
      firstName: 'Sipho',
      lastName: 'Ndlovu',
      dob: '2011-03-04',
      guardianName: 'M. Ndlovu',
    };
    assert.equal((await post(player)).status, 201);
    assert.equal((await post(player)).status, 409);
  });

  test('rotating the link kills the old one', async () => {
    const res = await req('/tournaments/public-cup/entries/kearsney/squad-link', ADMIN, {
      method: 'POST',
    });
    const { squadRegLink } = await json<{ squadRegLink: { token: string } }>(res);
    assert.notEqual(squadRegLink.token, token);

    assert.equal((await app.request(`/register/public-cup/kearsney?t=${token}`)).status, 404);
    assert.equal(
      (await app.request(`/register/public-cup/kearsney?t=${squadRegLink.token}`)).status,
      200,
    );
    token = squadRegLink.token;
  });

  test('a withdrawn entry stops collecting children’s data', async () => {
    await req('/tournaments/public-cup/entries/kearsney/decision', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ status: 'withdrawn' }),
    });
    const gone = await app.request(`/register/public-cup/kearsney?t=${token}`);
    assert.equal(gone.status, 410);
  });
});

/* ────────────────────────── Tenant isolation ─────────────────────── */

describe('tenant isolation', () => {
  test('a membership in another tenant cannot reach this one', async () => {
    const outsider = devAuth([{ tenantId: 'someone-else', role: 'admin', schoolIds: [] }]);
    const res = await req('/tournaments', outsider, {});
    assert.equal(res.status, 403);
  });
});

/* ═══════════════════════ Venue assessment (facilities) ═══════════════════ */

describe('venue assessment', () => {
  before(async () => {
    // The seeded 'school' tenant has venues in its config; but this test tenant
    // was created blank, so add a venue to assess.
    const cfg = await repo.getTenantConfig(TENANT);
    assert.ok(cfg, 'the tenant was provisioned in the outer before()');
    await repo.putTenantConfig({
      ...cfg,
      venues: [{ id: 'v-oval', name: 'Main Oval', kind: 'Field' }],
    });
  });

  test('an assessment can only reference a real venue', async () => {
    const bad = await req('/admin/assessments', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ venueId: 'v-ghost', scores: [{ key: 'surface', score: 4 }] }),
    });
    assert.equal(bad.status, 404);
  });

  test('a rep cannot reach the module at all', async () => {
    assert.equal((await req('/admin/assessments', REP, {})).status, 403);
  });

  test('an out-of-range or unknown score is rejected', async () => {
    for (const scores of [[{ key: 'surface', score: 9 }], [{ key: 'bribe', score: 3 }]]) {
      const res = await req('/admin/assessments', ADMIN, {
        method: 'POST',
        body: JSON.stringify({ venueId: 'v-oval', scores }),
      });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(scores)}`);
    }
  });

  test('create, update and delete an assessment', async () => {
    const res = await req('/admin/assessments', ADMIN, {
      method: 'POST',
      body: JSON.stringify({
        venueId: 'v-oval',
        assessedAt: '2026-08-18',
        verdict: 'ready',
        overall: 85,
        scores: [
          { key: 'surface', score: 5 },
          { key: 'safety', score: 4 },
        ],
        actions: [{ text: 'Mow the outfield', priority: 'medium' }],
      }),
    });
    assert.equal(res.status, 201);
    const a = await json<{ id: string; version: number; actions: { id: string }[] }>(res);
    assert.ok(a.actions[0].id, 'the action got an id');

    const patched = await req(`/admin/assessments/${a.id}`, ADMIN, {
      method: 'PATCH',
      body: JSON.stringify({ verdict: 'conditional', version: a.version }),
    });
    assert.equal(patched.status, 200);

    assert.equal(
      (await req(`/admin/assessments/${a.id}`, ADMIN, { method: 'DELETE' })).status,
      200,
    );
    assert.equal((await req(`/admin/assessments/${a.id}`, ADMIN, {})).status, 404);
  });
});

/* ═══════════════════════════════ Ticketing ══════════════════════════════ */

describe('ticketing', () => {
  let typeId: string;

  test('a tier is created and a ticket issued against it, with a QR + code', async () => {
    const tierRes = await req('/admin/ticket-types', ADMIN, {
      method: 'POST',
      body: JSON.stringify({
        eventId: 'gala-day',
        eventName: 'Gala Day',
        name: 'Adult',
        priceCents: 5000,
        capacity: 3,
      }),
    });
    assert.equal(tierRes.status, 201);
    ({ id: typeId } = await json<{ id: string }>(tierRes));

    const res = await req('/admin/tickets', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ ticketTypeId: typeId, buyerName: 'D Pillay', quantity: 2 }),
    });
    assert.equal(res.status, 201);
    const t = await json<{ code: string; qrToken: string; payment: string }>(res);
    assert.match(t.code, /^RC-[A-Z0-9]{4}$/);
    assert.ok(t.qrToken);
    assert.equal(t.payment, 'unpaid');
  });

  test('capacity is a hard gate', async () => {
    // Tier capacity is 3; 2 already sold. A 2-ticket order must be refused.
    const res = await req('/admin/tickets', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ ticketTypeId: typeId, buyerName: 'Too Many', quantity: 2 }),
    });
    assert.equal(res.status, 409);
    // But one more fits exactly.
    const ok = await req('/admin/tickets', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ ticketTypeId: typeId, buyerName: 'Last One', quantity: 1 }),
    });
    assert.equal(ok.status, 201);
  });

  test('a free tier issues comps', async () => {
    const tier = await json<{ id: string }>(
      await req('/admin/ticket-types', ADMIN, {
        method: 'POST',
        body: JSON.stringify({
          eventId: 'open-day',
          eventName: 'Open Day',
          name: 'Entry',
          priceCents: 0,
          capacity: 0,
        }),
      }),
    );
    const t = await json<{ payment: string }>(
      await req('/admin/tickets', ADMIN, {
        method: 'POST',
        body: JSON.stringify({ ticketTypeId: tier.id, buyerName: 'Guest' }),
      }),
    );
    assert.equal(t.payment, 'comp');
  });

  test('a marshal checks a ticket in by its code, and a second scan is idempotent', async () => {
    const issued = await json<{ code: string }>(
      await req('/admin/tickets', ADMIN, {
        method: 'POST',
        body: JSON.stringify({
          ticketTypeId: typeId,
          buyerName: 'Gate Test',
          quantity: 1,
          payment: 'paid',
        }),
      }),
    ).catch(() => ({ code: '' }));
    // (that issue may 409 on capacity; issue against the free tier instead if so)
    let code = issued.code;
    if (!code) {
      const free = await json<{ id: string }>(
        await req('/admin/ticket-types', ADMIN, {
          method: 'POST',
          body: JSON.stringify({
            eventId: 'gate-ev',
            eventName: 'Gate',
            name: 'Free',
            priceCents: 0,
            capacity: 0,
          }),
        }),
      );
      const t = await json<{ code: string }>(
        await req('/admin/tickets', ADMIN, {
          method: 'POST',
          body: JSON.stringify({ ticketTypeId: free.id, buyerName: 'Gate Test' }),
        }),
      );
      code = t.code;
    }

    const first = await json<{ kind: string; already: boolean }>(
      await req('/admin/scan', ADMIN, { method: 'POST', body: JSON.stringify({ code }) }),
    );
    assert.equal(first.kind, 'ticket');
    assert.equal(first.already, false);

    const second = await json<{ already: boolean }>(
      await req('/admin/scan', ADMIN, { method: 'POST', body: JSON.stringify({ code }) }),
    );
    assert.equal(second.already, true);
  });

  test('an unknown code is a 404', async () => {
    const res = await req('/admin/scan', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ code: 'RC-ZZZZ' }),
    });
    assert.equal(res.status, 404);
  });

  test('voiding a ticket releases its scan token', async () => {
    const t = await json<{ id: string; qrToken: string }>(
      await req('/admin/tickets', ADMIN, {
        method: 'POST',
        body: JSON.stringify({
          ticketTypeId: (
            await json<{ id: string }>(
              await req('/admin/ticket-types', ADMIN, {
                method: 'POST',
                body: JSON.stringify({
                  eventId: 'void-ev',
                  eventName: 'Void',
                  name: 'Free',
                  priceCents: 0,
                  capacity: 0,
                }),
              }),
            )
          ).id,
          buyerName: 'To Void',
        }),
      }),
    );
    assert.equal((await req(`/admin/tickets/${t.id}/void`, ADMIN, { method: 'POST' })).status, 200);
    // The token no longer resolves — a scan of the voided QR finds nothing.
    assert.equal(await repo.getScanToken(t.qrToken), null);
  });
});

/* ═══════════════════════════════ Parking ════════════════════════════════ */

describe('parking', () => {
  let zoneId: string;

  test('a zone is created and a pass allocated, capacity-checked', async () => {
    const zone = await json<{ id: string }>(
      await req('/admin/parking/zones', ADMIN, {
        method: 'POST',
        body: JSON.stringify({ name: 'Bus bay', kind: 'bus', capacity: 2 }),
      }),
    );
    zoneId = zone.id;

    const pass = await json<{ code: string; status: string }>(
      await req('/admin/parking/passes', ADMIN, {
        method: 'POST',
        body: JSON.stringify({ zoneId, eventId: 'gala-day', allocatedTo: 'Kearsney', bays: 2 }),
      }),
    );
    assert.match(pass.code, /^P-[A-Z0-9]{4}$/);
    assert.equal(pass.status, 'allocated');

    // The zone is now full — a further bay is refused.
    const full = await req('/admin/parking/passes', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ zoneId, eventId: 'gala-day', allocatedTo: 'Overflow', bays: 1 }),
    });
    assert.equal(full.status, 409);
  });

  test('a parking pass checks in through the same scan endpoint', async () => {
    const pass = await json<{ code: string }>(
      await req('/admin/parking/passes', ADMIN, {
        method: 'POST',
        body: JSON.stringify({
          zoneId: (
            await json<{ id: string }>(
              await req('/admin/parking/zones', ADMIN, {
                method: 'POST',
                body: JSON.stringify({ name: 'Overflow', kind: 'general', capacity: 0 }),
              }),
            )
          ).id,
          eventId: 'gala-day',
          allocatedTo: 'VIP guest',
          bays: 1,
        }),
      }),
    );
    const res = await json<{ kind: string; already: boolean }>(
      await req('/admin/scan', ADMIN, {
        method: 'POST',
        body: JSON.stringify({ code: pass.code }),
      }),
    );
    assert.equal(res.kind, 'parking');
    assert.equal(res.already, false);
  });

  test('a zone with live passes cannot be deleted', async () => {
    const res = await req(`/admin/parking/zones/${zoneId}`, ADMIN, { method: 'DELETE' });
    assert.equal(res.status, 409);
  });
});

/* ═══════════════════ Academic support (university module) ════════════════ */

describe('academic support', () => {
  let athleteId: string;

  test('a rep cannot reach the academic module (sensitive PII)', async () => {
    assert.equal((await req('/admin/academic/athletes', REP, {})).status, 403);
  });

  test('an athlete needs a name and student number', async () => {
    const bad = await req('/admin/academic/athletes', ADMIN, {
      method: 'POST',
      body: JSON.stringify({ firstName: 'No', squad: 'General' }),
    });
    assert.equal(bad.status, 400);
  });

  test('an unknown faculty or out-of-range metric is rejected', async () => {
    assert.equal(
      (
        await req('/admin/academic/athletes', ADMIN, {
          method: 'POST',
          body: JSON.stringify({
            firstName: 'A',
            lastName: 'B',
            studentNumber: 'X1',
            faculty: 'Hogwarts',
          }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await req('/admin/academic/athletes', ADMIN, {
          method: 'POST',
          body: JSON.stringify({
            firstName: 'A',
            lastName: 'B',
            studentNumber: 'X2',
            semesterAverage: 140,
          }),
        })
      ).status,
      400,
    );
  });

  test('create an athlete; the student number is upper-cased and assessedAt stamped', async () => {
    const res = await req('/admin/academic/athletes', ADMIN, {
      method: 'POST',
      body: JSON.stringify({
        firstName: 'Christopher',
        lastName: 'Anderson',
        studentNumber: 'andchr020',
        squad: '1st Team',
        faculty: 'Humanities',
        degree: 'BSocSci',
        yearOfStudy: '2nd Year',
        creditsRegistered: 72,
        mentor: 'Thabo Nkosi',
        lectureAttendance: 60,
        tutorialAttendance: 90,
        assignmentCompletion: 90,
        semesterAverage: 64,
        facultyWarning: 'No',
      }),
    });
    assert.equal(res.status, 201);
    const a = await json<{ id: string; studentNumber: string; assessedAt?: string }>(res);
    assert.equal(a.studentNumber, 'ANDCHR020');
    assert.ok(a.assessedAt, 'a snapshot was captured, so assessedAt is stamped');
    athleteId = a.id;
  });

  test('updating any metric re-stamps assessedAt', async () => {
    const before = await json<{ assessedAt: string; version: number }>(
      await req(`/admin/academic/athletes/${athleteId}`, ADMIN, {}),
    );
    const res = await req(`/admin/academic/athletes/${athleteId}`, ADMIN, {
      method: 'PATCH',
      body: JSON.stringify({ facultyWarning: 'Yes', version: before.version }),
    });
    assert.equal(res.status, 200);
    const after = await json<{ assessedAt: string }>(res);
    assert.ok(after.assessedAt >= before.assessedAt);
  });

  test('a bi-weekly check-in denormalizes the athlete name and mentor', async () => {
    const res = await req('/admin/academic/check-ins', ADMIN, {
      method: 'POST',
      body: JSON.stringify({
        athleteId,
        studentNumber: 'ANDCHR020',
        date: '2026-08-18',
        followUpRequired: 'Yes',
        answers: { supportRequired: 'Yes', copingAcademically: 'No' },
      }),
    });
    assert.equal(res.status, 201);
    const c = await json<{ athleteName: string; mentor: string }>(res);
    assert.equal(c.athleteName, 'Christopher Anderson');
    assert.equal(c.mentor, 'Thabo Nkosi');
  });

  test('a check-in answer outside Yes/No/N/A is rejected', async () => {
    const res = await req('/admin/academic/check-ins', ADMIN, {
      method: 'POST',
      body: JSON.stringify({
        studentNumber: 'ANDCHR020',
        answers: { copingAcademically: 'Maybe' },
      }),
    });
    assert.equal(res.status, 400);
  });

  test('an ADP check-in round-trips its modules, sections and plan', async () => {
    const res = await req('/admin/academic/check-ins', ADMIN, {
      method: 'POST',
      body: JSON.stringify({
        athleteId,
        studentNumber: 'ANDCHR020',
        date: '2026-08-25',
        kind: 'adp',
        period: 'Semester 2 2026',
        followUpRequired: 'Yes',
        answers: {},
        modules: [
          {
            code: 'ECO1010',
            name: 'Microeconomics',
            status: 'at_risk',
            screener: { understanding: 'Struggling' },
          },
          { code: 'CSC1015', status: 'on_track', screener: { understanding: 'Comfortably' } },
        ],
        sections: {
          content: {
            modules: { ECO1010: { concepts: { self: 4, mentor: 2 } } },
            note: 'Behind on demand curves',
          },
          worklife: { ratings: { load: { self: 3, mentor: 3 } } },
        },
        plan: [
          { type: 'course_tutor', module: 'ECO1010', owner: 'Thabo Nkosi', dueDate: '2026-09-01' },
        ],
      }),
    });
    assert.equal(res.status, 201);
    const c = await json<{
      kind: string;
      period: string;
      modules: { code: string }[];
      sections: Record<string, unknown>;
      plan: { type: string }[];
    }>(res);
    assert.equal(c.kind, 'adp');
    assert.equal(c.period, 'Semester 2 2026');
    assert.equal(c.modules.length, 2);
    assert.equal(c.plan[0].type, 'course_tutor');
    assert.ok(c.sections.content, 'the content section survives the round trip');
  });

  test('an ADP rating outside 1–5 is rejected', async () => {
    const res = await req('/admin/academic/check-ins', ADMIN, {
      method: 'POST',
      body: JSON.stringify({
        studentNumber: 'ANDCHR020',
        kind: 'adp',
        answers: {},
        sections: { worklife: { ratings: { load: { self: 9 } } } },
      }),
    });
    assert.equal(res.status, 400);
  });

  test('an ADP plan with an unknown intervention type is rejected', async () => {
    const res = await req('/admin/academic/check-ins', ADMIN, {
      method: 'POST',
      body: JSON.stringify({
        studentNumber: 'ANDCHR020',
        kind: 'adp',
        answers: {},
        plan: [{ type: 'teleport_to_lecture' }],
      }),
    });
    assert.equal(res.status, 400);
  });

  test('an intervention runs open → in progress → resolved', async () => {
    const created = await json<{ id: string; status: string; version: number }>(
      await req('/admin/academic/interventions', ADMIN, {
        method: 'POST',
        body: JSON.stringify({
          athleteId,
          studentNumber: 'ANDCHR020',
          concern: 'Missed three tutorials',
          referredTo: 'Academic Development Programme',
        }),
      }),
    );
    assert.equal(created.status, 'open');

    const started = await json<{ status: string; version: number }>(
      await req(`/admin/academic/interventions/${created.id}`, ADMIN, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'in_progress', version: created.version }),
      }),
    );
    assert.equal(started.status, 'in_progress');

    const resolved = await req(`/admin/academic/interventions/${created.id}`, ADMIN, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'resolved', version: started.version }),
    });
    assert.equal(resolved.status, 200);
  });

  test('deleting an athlete removes them from the roster', async () => {
    assert.equal(
      (await req(`/admin/academic/athletes/${athleteId}`, ADMIN, { method: 'DELETE' })).status,
      200,
    );
    assert.equal((await req(`/admin/academic/athletes/${athleteId}`, ADMIN, {})).status, 404);
  });
});

describe('external mentor plan flow', () => {
  const STUDENT = 'MTRSTU001';
  let athleteId: string;
  let checkInId: string;
  let token: string;

  test('set up an athlete to assign', async () => {
    const a = await json<{ id: string }>(
      await req('/admin/academic/athletes', ADMIN, {
        method: 'POST',
        body: JSON.stringify({
          firstName: 'Mentee',
          lastName: 'Test',
          studentNumber: STUDENT,
          squad: '1st Team',
          faculty: 'Science',
        }),
      }),
    );
    athleteId = a.id;
  });

  test('a mentor needs a name and a valid email', async () => {
    assert.equal(
      (
        await req('/admin/academic/mentors', ADMIN, {
          method: 'POST',
          body: JSON.stringify({ name: 'No Email' }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await req('/admin/academic/mentors', ADMIN, {
          method: 'POST',
          body: JSON.stringify({ name: 'Bad', email: 'not-an-email' }),
        })
      ).status,
      400,
    );
  });

  test('create a mentor; the email is lower-cased', async () => {
    const m = await json<{ email: string }>(
      await req('/admin/academic/mentors', ADMIN, {
        method: 'POST',
        body: JSON.stringify({ name: 'Jane Coach', email: 'Jane@Example.com' }),
      }),
    );
    assert.equal(m.email, 'jane@example.com');
    const list = await json<unknown[]>(await req('/admin/academic/mentors', ADMIN, {}));
    assert.ok(list.length >= 1);
  });

  test('assigning a plan (planStatus=sent) mints a completion token', async () => {
    const res = await req('/admin/academic/check-ins', ADMIN, {
      method: 'POST',
      body: JSON.stringify({
        athleteId,
        studentNumber: STUDENT,
        kind: 'adp',
        planStatus: 'sent',
        mentor: 'Jane Coach',
        mentorEmail: 'jane@example.com',
        period: 'Semester 2 2026',
        scheduledNext: '2026-09-01',
        answers: {},
      }),
    });
    assert.equal(res.status, 201);
    const c = await json<{ id: string; token: string; planStatus: string }>(res);
    checkInId = c.id;
    token = c.token;
    assert.equal(c.planStatus, 'sent');
    assert.ok(token, 'a token was minted');
  });

  test('the public link resolves the plan without any auth', async () => {
    const res = await app.request(`/mentor-plan/${checkInId}?t=${token}`);
    assert.equal(res.status, 200);
    const p = await json<{ studentNumber: string; planStatus: string }>(res);
    assert.equal(p.studentNumber, STUDENT);
    assert.equal(p.planStatus, 'sent');
  });

  test('a wrong or missing token is rejected', async () => {
    assert.equal((await app.request(`/mentor-plan/${checkInId}?t=wrong`)).status, 404);
    assert.equal((await app.request(`/mentor-plan/${checkInId}`)).status, 400);
  });

  test('the mentor submits; the plan is marked completed and interventions logged', async () => {
    const res = await app.request(`/mentor-plan/${checkInId}?t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'adp',
        sections: { worklife: { ratings: { load: 4, time: 3 } } },
        plan: [{ type: 'course_tutor', module: 'ECO1010' }],
      }),
    });
    assert.equal(res.status, 200);

    const list = await json<Array<{ id: string; planStatus: string; completedAt?: string }>>(
      await req('/admin/academic/check-ins', ADMIN, {}),
    );
    const ours = list.find((x) => x.id === checkInId);
    assert.equal(ours?.planStatus, 'completed');
    assert.ok(ours?.completedAt, 'completedAt is stamped');

    const ivs = await json<Array<{ studentNumber: string }>>(
      await req('/admin/academic/interventions', ADMIN, {}),
    );
    assert.ok(ivs.some((i) => i.studentNumber === STUDENT), 'the plan intervention was logged');
  });
});
