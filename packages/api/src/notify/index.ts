/**
 * Notification orchestrator. Validates recipients per channel and fans email +
 * WhatsApp out concurrently (each channel never throws — failures become a
 * `failed`/`skipped` result so one bad channel can't sink the other). The HTTP
 * routes record these results and return them to the caller verbatim, so the
 * toast reflects reality instead of optimism.
 */
import type { Channel, SendResult } from '../types.js';
import { sendStaffInviteEmail, sendDrawEmail } from './email.js';
import { sendStaffInviteWhatsApp, sendDrawWhatsApp, toE164 } from './whatsapp.js';

// Re-export so existing import sites (index.ts) keep resolving these from here.
export type { Channel, SendResult } from '../types.js';

// Kept identical to the backend EMAIL_RE (index.ts) / frontend so a value that
// passes the form can't be rejected here.
const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;

/** The staff (admin/rep) invite recipient. */
interface Contact {
  name: string;
  email: string;
  cell: string;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function sendEmailChannel(
  contact: Contact,
  orgName: string,
  link: string,
): Promise<SendResult> {
  if (!EMAIL_RE.test(contact.email)) {
    // Keep an invalid-but-present value for diagnostics; omit `to` entirely when blank.
    return {
      channel: 'email',
      status: 'skipped',
      ...(contact.email ? { to: contact.email } : {}),
      error: 'no valid staff email on file',
    };
  }
  try {
    const { messageId } = await sendStaffInviteEmail({
      to: contact.email,
      name: contact.name,
      orgName,
      link,
    });
    return { channel: 'email', status: 'sent', to: contact.email, messageId };
  } catch (err) {
    return { channel: 'email', status: 'failed', to: contact.email, error: errMessage(err) };
  }
}

async function sendWhatsAppChannel(
  contact: Contact,
  orgName: string,
  link: string,
): Promise<SendResult> {
  const e164 = toE164(contact.cell);
  if (!e164) {
    return {
      channel: 'whatsapp',
      status: 'skipped',
      ...(contact.cell ? { to: contact.cell } : {}),
      error: 'no valid staff cell on file',
    };
  }
  try {
    const { messageId } = await sendStaffInviteWhatsApp({
      to: e164,
      name: contact.name,
      orgName,
      link,
    });
    return { channel: 'whatsapp', status: 'sent', to: e164, messageId };
  } catch (err) {
    return { channel: 'whatsapp', status: 'failed', to: e164, error: errMessage(err) };
  }
}

/**
 * Send the generic staff (admin/rep) invite — "you've been added to {orgName}" — over
 * email and/or WhatsApp. Non-throwing per-channel results (a bad/blank contact becomes
 * a `skipped`/`failed` result, never sinking the other channel). Email is the primary
 * staff channel; WhatsApp is best-effort.
 */
export async function sendStaffInvite(args: {
  email: string;
  name?: string;
  cell?: string;
  orgName: string;
  channels: Channel[];
  link: string;
}): Promise<{ results: SendResult[] }> {
  const { email, name, cell, orgName, channels, link } = args;
  const contact: Contact = {
    name: (name ?? '').trim(),
    email: (email ?? '').trim(),
    cell: (cell ?? '').trim(),
  };
  // Concurrent fan-out keeps worst-case latency to the slowest single channel rather
  // than the sum (only ≤2 calls — one recipient × ≤2 channels). Order is preserved.
  // Note: WhatsApp retries on rate-limit; SES (email) does not.
  const results = await Promise.all(
    channels.map((channel) =>
      channel === 'email'
        ? sendEmailChannel(contact, orgName, link)
        : sendWhatsAppChannel(contact, orgName, link),
    ),
  );
  return { results };
}

// ───────────────────────── Draw broadcast ─────────────────────────

/**
 * Run thunks with a bounded concurrency pool. A twenty-school draw broadcast over
 * two channels is forty sends; firing them all at once would exceed SES's send
 * rate and thunder-herd Meta's rate limiter. A small pool keeps us inside both
 * providers' limits while staying parallel.
 */
async function runPool<T>(thunks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(thunks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < thunks.length) {
      const idx = next++;
      results[idx] = await thunks[idx]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker));
  return results;
}

const SEND_CONCURRENCY = 8;

/**
 * Send one school's draw over one channel. Non-throwing: a bad recipient becomes a
 * `failed`/`skipped` result so one unreachable sport director never sinks the batch.
 */
async function sendDrawChannel(
  channel: Channel,
  to: { email?: string; cell?: string },
  orgName: string,
  schoolName: string,
  tournamentName: string,
  schedule: string,
): Promise<SendResult> {
  if (channel === 'email') {
    const email = (to.email ?? '').trim();
    if (!EMAIL_RE.test(email)) {
      return {
        channel: 'email',
        status: 'skipped',
        ...(email ? { to: email } : {}),
        error: 'no valid contact email on file',
      };
    }
    try {
      const { messageId } = await sendDrawEmail({
        to: email,
        orgName,
        schoolName,
        tournamentName,
        scheduleText: schedule,
      });
      return { channel: 'email', status: 'sent', to: email, messageId };
    } catch (err) {
      return { channel: 'email', status: 'failed', to: email, error: errMessage(err) };
    }
  }
  const e164 = toE164(to.cell);
  if (!e164) {
    return {
      channel: 'whatsapp',
      status: 'skipped',
      ...(to.cell ? { to: to.cell } : {}),
      error: 'no valid contact cell on file',
    };
  }
  try {
    const { messageId } = await sendDrawWhatsApp({
      to: e164,
      schoolName,
      tournamentName,
      orgName,
    });
    return { channel: 'whatsapp', status: 'sent', to: e164, messageId };
  } catch (err) {
    return { channel: 'whatsapp', status: 'failed', to: e164, error: errMessage(err) };
  }
}

/**
 * Send one visiting school its own fixtures once the organiser releases the draw.
 *
 * The recipient is the school's staff contact, never the players: most of a school
 * squad are minors, and the host has no guardian contact for them (POPIA
 * data-minimisation). Runs the requested channels under the bounded pool.
 */
export async function sendSchoolDraw(args: {
  channels: Channel[];
  to: { email?: string; cell?: string };
  orgName: string;
  schoolName: string;
  tournamentName: string;
  schedule: string;
}): Promise<SendResult[]> {
  const { channels, to, orgName, schoolName, tournamentName, schedule } = args;
  return runPool(
    channels.map(
      (channel) => () =>
        sendDrawChannel(channel, to, orgName, schoolName, tournamentName, schedule),
    ),
    SEND_CONCURRENCY,
  );
}
