/**
 * Seed CLI — provision tenants.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/src/seed.ts [tenant ...]
 *   …                                                              [tenant ...] --demo
 *   …                                                              [tenant ...] --venues-only [--force]
 *
 * Default: writes only each tenant's config (branding + deadline) — the cohort is
 * BLANK so real unions input their own schools/tournament. `--demo` additionally loads
 * the sample schools + tournament (for set/demo accounts). Idempotent (upserts).
 *
 * `--venues-only` is a MANUAL one-shot repair (not a post-deploy step): it backfills only
 * the league catalogue from the snapshot, leaving branding/deadline/adminCount untouched,
 * for a stage whose CONFIG predates the catalogue. It skips a populated catalogue, refuses
 * to silently refill an intentionally-emptied one (use `--force`), and errors loudly if a
 * tenant has no CONFIG row at all (run a full seed for that tenant first).
 */
import {
  seedTenantConfig,
  seedDemoData,
  seedVenuesOnly,
  BRANDING,
  SEED_TENANTS,
} from './seed-core.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const demo = args.includes('--demo');
  const venuesOnly = args.includes('--venues-only');
  const force = args.includes('--force');
  if (force && !venuesOnly) console.warn('--force has no effect without --venues-only; ignoring');
  const requested = args.filter((a) => !a.startsWith('--'));
  const toSeed = requested.length ? requested : SEED_TENANTS;

  for (const t of toSeed) {
    if (!BRANDING[t]) {
      console.warn(`no branding for tenant "${t}", skipping`);
      continue;
    }
    if (venuesOnly) {
      const r = await seedVenuesOnly(t, force);
      switch (r.status) {
        case 'config-missing':
          console.error(`ERROR ${t}: no CONFIG row — run a full seed (\`seed.ts ${t}\`) first`);
          process.exitCode = 1;
          break;
        case 'already-populated':
          console.log(`skipped ${t}: catalogue already populated (${r.count})`);
          break;
        case 'empty-skipped':
          console.log(
            `skipped ${t}: venues present but empty — possibly intentional; re-run with --force to overwrite`,
          );
          break;
        case 'backfilled':
          console.log(`backfilled ${t}: ${r.count} venues (config otherwise untouched)`);
          break;
      }
      continue;
    }
    const venues = await seedTenantConfig(t);
    if (demo) {
      const { schools, tournaments, entries, players } = await seedDemoData(t);
      console.log(
        `provisioned ${t} + demo data: ${schools} schools, ${tournaments} tournaments, ${entries} entries, ${players} players (${venues} venues)`,
      );
    } else {
      console.log(`provisioned ${t} (blank cohort, ${venues} venues)`);
    }
  }
  console.log('seed complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
