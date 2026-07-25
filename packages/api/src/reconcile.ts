/**
 * Orphan reconciliation for the last-admin guard.
 *
 * A tenant's `adminCount` is a trustworthy lockout guard ONLY while it counts
 * sign-in-capable admins. An admin membership whose Cognito user was deleted out-of-band
 * (or stale seed/test data) is a PHANTOM that inflates the count and could let the real
 * last admin be removed. `reconcileTenantAdmins` prunes such phantoms — via
 * `repo.pruneAdminMembership`'s atomic `ADD -1` (never a recompute-SET, so it stays
 * race-free with concurrent invite/promote/remove) — and is run BEFORE a guarded decrement
 * evaluates the floor, so the real last admin can't be removed behind a phantom co-admin.
 *
 * `exists` is INJECTED (production binds `cognitoUserExists`; tests pass a stub) so the
 * orphan logic is unit-testable without Cognito and `repo.ts` stays Cognito-free.
 */
import type { UserProfile } from './types.js';
import * as repo from './repo.js';

// Don't prune a membership younger than this: a just-invited admin can briefly read as
// "missing" while Cognito propagates AdminCreateUser. The grace window makes pruning safe
// against that race (the membership's `invitedAt` is the create time).
const PRUNE_GRACE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Prune every orphaned ADMIN membership in `tenant` (Cognito user gone, past the grace
 * window) and atomically decrement `adminCount` for each. Idempotent: a double-prune from
 * concurrent reconciles only drifts the counter low (the safe direction — the guard gets
 * stricter, never enabling a lockout). Reps are left alone — only the admin count gates
 * lockout.
 *
 * Failure model is fail-CLOSED on purpose (this runs *before* a guarded decrement, so a
 * silent miss could let a phantom mask the floor): a PER-USER error is logged and skipped
 * (that admin just isn't pruned this pass), but a failure to LIST the roster propagates and
 * aborts the surrounding remove/demote — safe, since nothing is removed behind an
 * unverified roster. A transient throttle therefore blocks the op (retryable) rather than
 * risking a lockout.
 */
export async function reconcileTenantAdmins(
  tenant: string,
  exists: (email: string) => Promise<boolean>,
): Promise<void> {
  const roster = await repo.listTenantUsers(tenant);
  for (const entry of roster) {
    try {
      const profile = await repo.getUser(entry.sub);
      const membership = profile?.memberships.find((m) => m.tenantId === tenant);
      if (!profile || !membership || membership.role !== 'admin') continue;

      // Skip just-created admins (Cognito may not have propagated yet).
      const invitedMs = membership.invitedAt ? Date.parse(membership.invitedAt) : NaN;
      if (!Number.isNaN(invitedMs) && Date.now() - invitedMs < PRUNE_GRACE_MS) continue;

      if (await exists(profile.email)) continue; // real account — keep

      // Phantom: drop ONLY this tenant's membership (a multi-tenant user keeps the rest)
      // and atomically decrement adminCount.
      const pruned: UserProfile = {
        ...profile,
        memberships: profile.memberships.filter((m) => m.tenantId !== tenant),
      };
      await repo.pruneAdminMembership(pruned, tenant);
    } catch (err) {
      console.warn(`reconcile skipped ${entry.sub} in ${tenant}:`, (err as Error).message);
    }
  }
}
