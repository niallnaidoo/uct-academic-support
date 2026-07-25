/**
 * Blank a tenant's cohort (remove demo/seeded schools + players + tournament) while
 * keeping its branding config and all admin/rep logins.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/src/clear-cohort.ts <tenant> --confirm
 *
 * Idempotent. Reg-link tokens are global and left in place (stale links 404).
 * Use this to wipe sample data from a real tenant so the union starts fresh.
 */
import * as repo from './repo.js';

async function main(): Promise<void> {
  const [tenant, flag] = process.argv.slice(2);
  if (!tenant) {
    console.error('usage: clear-cohort <tenant> --confirm');
    process.exit(1);
  }
  if (flag !== '--confirm') {
    console.error(`Refusing to clear "${tenant}" without --confirm. This is irreversible.`);
    process.exit(1);
  }
  const config = await repo.getTenantConfig(tenant);
  if (!config) {
    console.error(`tenant "${tenant}" not found`);
    process.exit(1);
  }

  const deleted = await repo.clearCohort(tenant);

  console.log(`cleared cohort for "${tenant}": ${deleted} school/tournament/entry items removed.`);
  console.log('branding config + users retained.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
