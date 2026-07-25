/**
 * Repair: reconcile a tenant's admins against Cognito + sweep emptied user records.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/src/reconcile-users.ts <tenant>
 *
 * Runs the same `reconcileTenantAdmins` the live decrement path uses — pruning admin
 * memberships whose Cognito user is gone (atomic adminCount `ADD -1`) — then additionally
 * fully deletes any USER# record left with NO memberships (the harmless empties that the
 * live prune intentionally leaves behind). Idempotent and safe to run repeatedly; a clean
 * tenant is a no-op. Read-only against Cognito (only `AdminGetUser`), no `--confirm` gate.
 */
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import * as repo from './repo.js';
import { reconcileTenantAdmins } from './reconcile.js';
import { cognitoUserExists } from './cognito-users.js';
import { userPoolId } from './env.js';

async function main(): Promise<void> {
  const [tenant] = process.argv.slice(2);
  if (!tenant) {
    console.error('usage: reconcile-users <tenant>');
    process.exit(1);
  }
  const cognito = new CognitoIdentityProviderClient({});
  const pool = userPoolId();

  await reconcileTenantAdmins(tenant, (email) => cognitoUserExists(cognito, pool, email));

  // Sweep any now-empty-membership USER# records the prune left behind (a user whose only
  // membership was the pruned phantom). These are unlistable (no markers) but tidy to drop.
  const roster = await repo.listTenantUsers(tenant);
  let swept = 0;
  for (const u of roster) {
    const profile = await repo.getUser(u.sub);
    if (profile && profile.memberships.length === 0) {
      await repo.deleteUser(u.sub);
      swept++;
    }
  }
  console.log(`reconciled tenant "${tenant}": swept ${swept} empty user record(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
