/**
 * ElevenLabs Conversational-AI transport for the AI mentor (PRODUCTION path).
 *
 * This is not exercised in the hosted demo (no key) — it documents and implements
 * exactly how to go live. Enable it by setting:
 *   VITE_ELEVENLABS_AGENT_ID   — your Conversational-AI agent id
 *   VITE_ELEVENLABS_SIGNED_URL — your server endpoint that mints a signed URL
 * and configuring the agent in the ElevenLabs dashboard with the prompt from
 * `AI_MENTOR_PROMPT` and the client tools from `AI_MENTOR_TOOLS`.
 *
 * The API key NEVER touches the browser: your server calls ElevenLabs'
 * `get_signed_url` with the key and returns the short-lived signed URL. See
 * docs/AI_MENTOR.md for the (tiny) server contract.
 */
import { AI_MENTOR_PROMPT } from './aiMentor.js';

const AGENT_ID = import.meta.env.VITE_ELEVENLABS_AGENT_ID;
const SIGNED_URL_ENDPOINT = import.meta.env.VITE_ELEVENLABS_SIGNED_URL;
// The SDK is loaded at runtime (only when a real session starts) so it never
// weighs on the demo build. In production, prefer bundling `@elevenlabs/client`
// and importing it directly instead of this URL.
const SDK_URL = import.meta.env.VITE_ELEVENLABS_SDK_URL || 'https://esm.sh/@elevenlabs/client@0.1';

export const elevenLabsConfigured = () => !!(AGENT_ID && SIGNED_URL_ENDPOINT);

/**
 * Start a live ElevenLabs mentor session.
 *
 * @param ctx        per-student context (firstName, period, modules, suggestedNext)
 * @param tools      the client-tool implementations from makeCollector()
 * @param callbacks  { onMessage({role,text}), onState('connecting'|'listening'|'speaking'|'ended'), onError(e) }
 * @returns          a controller with `end()`
 */
export async function startElevenLabsSession(ctx, tools, callbacks = {}) {
  const { onMessage = () => {}, onState = () => {}, onError = () => {} } = callbacks;
  onState('connecting');

  // 1. Ask OUR server for a short-lived signed URL (keeps the API key server-side).
  const res = await fetch(`${SIGNED_URL_ENDPOINT}?agent_id=${encodeURIComponent(AGENT_ID)}`);
  if (!res.ok) throw new Error('Could not start the AI mentor (signed-url endpoint failed).');
  const { signed_url: signedUrl } = await res.json();

  // 2. Load the SDK and open the realtime voice session.
  const { Conversation } = await import(/* @vite-ignore */ SDK_URL);

  const conversation = await Conversation.startSession({
    signedUrl,
    // Inject the per-student facts + prompt at runtime (or bake them into the agent).
    overrides: {
      agent: {
        prompt: { prompt: AI_MENTOR_PROMPT },
        firstMessage: `Hi ${ctx.firstName || 'there'} — ready when you are.`,
      },
    },
    dynamicVariables: {
      first_name: ctx.firstName ?? '',
      period: ctx.period ?? '',
      modules: (ctx.modules ?? []).map((m) => `${m.code}${m.name ? ` (${m.name})` : ''}`).join(', '),
    },
    // 3. The agent's function calls run OUR tool implementations, which build the
    //    plan and submit it — the same tools the mock uses. Wrap each so a plain
    //    string is returned to the model.
    clientTools: Object.fromEntries(
      Object.entries(tools).map(([name, fn]) => [name, async (params) => String(fn(params) ?? 'ok')]),
    ),
    onConnect: () => onState('listening'),
    onDisconnect: () => onState('ended'),
    onError: (e) => onError(e),
    onModeChange: ({ mode }) => onState(mode === 'speaking' ? 'speaking' : 'listening'),
    onMessage: ({ source, message }) =>
      onMessage({ role: source === 'ai' ? 'mentor' : 'student', text: message }),
  });

  return { end: () => conversation.endSession() };
}
