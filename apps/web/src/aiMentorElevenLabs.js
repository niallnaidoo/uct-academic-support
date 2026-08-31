/**
 * ElevenLabs Conversational-AI transport for the AI mentor.
 *
 * For a demo, point it at a PUBLIC agent (created in the ElevenLabs dashboard):
 * the browser connects by agent id alone — no API key, nothing secret in the app
 * or the repo. The agent id is read at runtime so no rebuild is needed:
 *   • ?agent=<id> in the URL, or
 *   • localStorage 'uct-ai-agent' (set via the page's setup field), or
 *   • VITE_ELEVENLABS_AGENT_ID at build time.
 *
 * For a private agent, set VITE_ELEVENLABS_SIGNED_URL to your server endpoint
 * that mints a signed URL with your secret key (see docs/AI_MENTOR.md).
 */
import { Conversation } from '@elevenlabs/client';

const AGENT_STORE_KEY = 'uct-ai-agent';

/** Resolve the agent id from the URL, saved config, or build env (in that order). */
export function getAgentId() {
  try {
    const fromUrl = new URLSearchParams(window.location.hash.split('?')[1] || window.location.search).get('agent');
    if (fromUrl) return fromUrl.trim();
    const saved = localStorage.getItem(AGENT_STORE_KEY);
    if (saved) return saved.trim();
  } catch {
    /* ignore */
  }
  return import.meta.env.VITE_ELEVENLABS_AGENT_ID || '';
}

export function saveAgentId(id) {
  try {
    if (id) localStorage.setItem(AGENT_STORE_KEY, id.trim());
    else localStorage.removeItem(AGENT_STORE_KEY);
  } catch {
    /* ignore */
  }
}

const SIGNED_URL_ENDPOINT = import.meta.env.VITE_ELEVENLABS_SIGNED_URL;
const CONNECTION_TYPE = import.meta.env.VITE_ELEVENLABS_CONNECTION || 'webrtc';

/** True when a live session can be started (a public agent id, or a signed-url server). */
export const elevenLabsConfigured = () => !!(getAgentId() || SIGNED_URL_ENDPOINT);

/**
 * Start a live ElevenLabs mentor session.
 *
 * @param ctx        { firstName, period, modules }
 * @param tools      client-tool implementations from makeCollector()
 * @param callbacks  { onMessage({role,text}), onState('connecting'|'listening'|'speaking'|'ended'), onError(Error) }
 * @returns          { end() }
 */
export async function startElevenLabsSession(ctx, tools, callbacks = {}) {
  const { onMessage = () => {}, onState = () => {}, onError = () => {} } = callbacks;
  onState('connecting');

  // Wrap each tool so the SDK always gets a string back for the model.
  const clientTools = Object.fromEntries(
    Object.entries(tools).map(([name, fn]) => [name, async (params) => String(fn(params) ?? 'ok')]),
  );

  const common = {
    connectionType: CONNECTION_TYPE,
    clientTools,
    // The agent's prompt declares these; we fill in the real student.
    dynamicVariables: {
      first_name: ctx.firstName ?? '',
      period: ctx.period ?? '',
      modules: (ctx.modules ?? []).map((m) => `${m.code}${m.name ? ` (${m.name})` : ''}`).join(', ') || 'their registered modules',
    },
    onConnect: () => onState('listening'),
    onDisconnect: () => onState('ended'),
    onError: (msg) => onError(new Error(typeof msg === 'string' ? msg : 'Voice session error')),
    onModeChange: ({ mode }) => onState(mode === 'speaking' ? 'speaking' : 'listening'),
    onMessage: ({ message, source, role }) =>
      onMessage({ role: (source ?? role) === 'ai' || role === 'agent' ? 'mentor' : 'student', text: message }),
  };

  let session;
  if (SIGNED_URL_ENDPOINT) {
    const res = await fetch(`${SIGNED_URL_ENDPOINT}?agent_id=${encodeURIComponent(getAgentId())}`);
    if (!res.ok) throw new Error('Could not start the AI mentor (signed-url endpoint failed).');
    const { signed_url: signedUrl } = await res.json();
    session = await Conversation.startSession({ signedUrl, ...common });
  } else {
    session = await Conversation.startSession({ agentId: getAgentId(), ...common });
  }

  return { end: () => session.endSession() };
}
