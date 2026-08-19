/**
 * Live API client — used when VITE_API_URL points at the deployed Hono backend.
 *
 * Auth: in local dev the backend trusts an x-dev-auth header (VITE_LOCAL_AUTH=1);
 * in production the dev team wires the Cognito bearer token here (see the note in
 * `authHeaders`). The public /mentor-plan routes need no auth.
 */
const BASE = import.meta.env.VITE_API_URL ?? '';
const TENANT = import.meta.env.VITE_TENANT ?? '';

function authHeaders() {
  const h = { 'content-type': 'application/json' };
  if (TENANT) h['x-tenant'] = TENANT;
  if (import.meta.env.VITE_LOCAL_AUTH === '1') h['x-dev-auth'] = btoa('{}');
  // Production: attach the Cognito ID token here, e.g.
  //   h.authorization = `Bearer ${await getIdToken()}`;
  return h;
}

async function req(path, { method = 'GET', body, auth = true } = {}) {
  const headers = auth ? authHeaders() : { 'content-type': 'application/json' };
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).error || message;
    } catch {
      /* non-JSON */
    }
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json();
}

export const getAthletes = () => req('/admin/academic/athletes');
export const getAthlete = (id) => req(`/admin/academic/athletes/${id}`);
export const createAthlete = (body) => req('/admin/academic/athletes', { method: 'POST', body });
export const patchAthlete = (id, patch) =>
  req(`/admin/academic/athletes/${id}`, { method: 'PATCH', body: patch });
export const deleteAthlete = (id) => req(`/admin/academic/athletes/${id}`, { method: 'DELETE' });

// Organisation settings — per-tenant config (name, sport, squads, admins).
export const getSettings = () => req('/admin/academic/settings');
export const updateSettings = (patch) =>
  req('/admin/academic/settings', { method: 'PUT', body: patch });

// Module profiles power the onboarding auto-populate. `getModuleProfiles` is admin
// (the roster view); onboarding submission is public (the student's link is the
// credential). Endpoints for the dev team to add server-side; see README.
export const getModuleProfiles = () => req('/admin/academic/module-profiles');
export const submitOnboarding = (body) =>
  req('/onboarding', { method: 'POST', body, auth: false });

export const getMentors = () => req('/admin/academic/mentors');
export const createMentor = (body) => req('/admin/academic/mentors', { method: 'POST', body });
export const patchMentor = (id, patch) =>
  req(`/admin/academic/mentors/${id}`, { method: 'PATCH', body: patch });
export const deleteMentor = (id) => req(`/admin/academic/mentors/${id}`, { method: 'DELETE' });

export const getCheckIns = () => req('/admin/academic/check-ins');
export const createCheckIn = (body) => req('/admin/academic/check-ins', { method: 'POST', body });
export const deleteCheckIn = (id) => req(`/admin/academic/check-ins/${id}`, { method: 'DELETE' });

export const getInterventions = () => req('/admin/academic/interventions');
export const createIntervention = (body) =>
  req('/admin/academic/interventions', { method: 'POST', body });
export const patchIntervention = (id, patch) =>
  req(`/admin/academic/interventions/${id}`, { method: 'PATCH', body: patch });
export const deleteIntervention = (id) =>
  req(`/admin/academic/interventions/${id}`, { method: 'DELETE' });

export const getMentorPlan = (id, token) =>
  req(`/mentor-plan/${id}?t=${encodeURIComponent(token)}`, { auth: false });
export const submitMentorPlan = (id, token, body) =>
  req(`/mentor-plan/${id}?t=${encodeURIComponent(token)}`, { method: 'POST', body, auth: false });

export const resetDemo = () => {};
