/**
 * Transactional email via Amazon SES.
 *
 * ⚠️ SES is NOT available in af-south-1 (where the rest of the stack runs), so the
 * client targets `SES_REGION` (default eu-west-1). A Lambda in af-south-1 calling
 * SES in eu-west-1 is fully supported — only the SES identity must be verified in
 * that region. See docs/guides/popia-compliance.md (cross-border transfer) and the
 * plan in /Users/carlton/.claude/plans.
 *
 * Dry-run: when NOTIFY_DRY_RUN=1 or FROM_EMAIL is unset (local/offline dev, or any
 * stage without SES wired) we log and return a synthetic id instead of calling SES,
 * mirroring the local-DynamoDB toggle in repo.ts. Callers must never treat dry-run
 * as real delivery — the route records the returned status truthfully.
 */
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { randomUUID } from 'node:crypto';

const SES_REGION = process.env.SES_REGION ?? 'eu-west-1';
const FROM_EMAIL = process.env.FROM_EMAIL;
export const EMAIL_DRY_RUN = process.env.NOTIFY_DRY_RUN === '1' || !FROM_EMAIL;

// Construct once at module load (matches repo.ts's client lifecycle); skip entirely
// in dry-run so no credentials/region are required offline.
const ses = EMAIL_DRY_RUN ? null : new SESClient({ region: SES_REGION });

/** Escape user-supplied values before interpolating into the HTML body. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface StaffInviteEmailInput {
  to: string;
  name: string;
  /** The union/tenant display name, e.g. "Dolphins Pipeline". */
  orgName: string;
  link: string;
}

/**
 * Generic "you've been added to {orgName}" email for a staff (admin/rep) invite.
 * The link is the app sign-in URL (validated by the caller).
 */
export async function sendStaffInviteEmail(
  input: StaffInviteEmailInput,
): Promise<{ messageId: string }> {
  const { to, name, orgName, link } = input;
  const subject = `You've been added to ${orgName}`;
  const greetName = name || 'there';

  const text =
    `Hi ${greetName},\n\n` +
    `You've been given access to ${orgName} on the Smart School platform.\n\n` +
    `Sign in here to get started:\n\n${link}\n\n` +
    `You'll sign in with a one-time code sent to this email address — no password to remember.\n\n` +
    `See you inside,\nThe ${orgName} office`;

  const safeName = escapeHtml(greetName);
  const safeOrg = escapeHtml(orgName);
  const safeLink = escapeHtml(link);
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2A4A;line-height:1.55;font-size:15px">` +
    `<p>Hi ${safeName},</p>` +
    `<p>You've been given access to <strong>${safeOrg}</strong> on the Smart School platform.</p>` +
    `<p>Sign in here to get started:</p>` +
    `<p><a href="${safeLink}" style="color:#1D9E75;font-weight:600">${safeLink}</a></p>` +
    `<p>You'll sign in with a one-time code sent to this email address — no password to remember.</p>` +
    `<p>See you inside,<br/>The ${safeOrg} office</p>` +
    `</div>`;

  if (EMAIL_DRY_RUN) {
    console.log(`[notify:email dry-run] would send staff invite to ${to} for ${orgName}`);
    return { messageId: `dry-run-${randomUUID()}` };
  }

  const res = await ses!.send(
    new SendEmailCommand({
      Source: FROM_EMAIL!,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' },
          Text: { Data: text, Charset: 'UTF-8' },
        },
      },
    }),
  );
  return { messageId: res.MessageId ?? '' };
}

export interface DrawEmailInput {
  to: string;
  /** The host school running the tournament. */
  orgName: string;
  /** The visiting school being written to. */
  schoolName: string;
  tournamentName: string;
  /** Pre-built plain-text schedule (newline-separated). Rendered verbatim into the body. */
  scheduleText: string;
}

/**
 * Send a visiting school its own fixtures once the draw is released. The full
 * schedule travels in the body — the recipient is a sport director planning a bus,
 * not someone who wants to log into a portal to find a kick-off time.
 */
export async function sendDrawEmail(input: DrawEmailInput): Promise<{ messageId: string }> {
  const { to, orgName, schoolName, tournamentName, scheduleText } = input;
  const subject = `${tournamentName} · your fixtures`;

  const text =
    `Hi ${schoolName},\n\n` +
    `The draw for ${tournamentName} is out. Here are your fixtures:\n\n` +
    `${scheduleText}\n\n` +
    `Please arrive at least 45 minutes before your first match.\n\n` +
    `See you there,\n${orgName}`;

  const safeName = escapeHtml(schoolName);
  const safeClub = escapeHtml(orgName);
  const safeSeason = escapeHtml(tournamentName);
  const safeSchedule = escapeHtml(scheduleText).replace(/\n/g, '<br/>');
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2A4A;line-height:1.55;font-size:15px">` +
    `<p>Hi ${safeName},</p>` +
    `<p>The draw for <strong>${safeSeason}</strong> is out. Here are your fixtures:</p>` +
    `<p style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px;white-space:pre-wrap">${safeSchedule}</p>` +
    `<p style="color:#5A6B8C;font-size:13px">Please arrive at least 45 minutes before your first match.</p>` +
    `<p>See you there,<br/>${safeClub}</p>` +
    `</div>`;

  if (EMAIL_DRY_RUN) {
    console.log(`[notify:email dry-run] would send the draw to ${to} for ${tournamentName}`);
    return { messageId: `dry-run-${randomUUID()}` };
  }

  const res = await ses!.send(
    new SendEmailCommand({
      Source: FROM_EMAIL!,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' },
          Text: { Data: text, Charset: 'UTF-8' },
        },
      },
    }),
  );
  return { messageId: res.MessageId ?? '' };
}
