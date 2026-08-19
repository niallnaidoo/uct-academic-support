/**
 * API facade — routes every call to the in-browser demo (default) or the live
 * Hono backend when VITE_API_URL is set. The rest of the app imports only this.
 */
import * as demo from './api.demo.js';
import * as live from './api.live.js';

export const IS_DEMO = !import.meta.env.VITE_API_URL;
const impl = IS_DEMO ? demo : live;

export const getAthletes = (...a) => impl.getAthletes(...a);
export const getAthlete = (...a) => impl.getAthlete(...a);
export const createAthlete = (...a) => impl.createAthlete(...a);
export const patchAthlete = (...a) => impl.patchAthlete(...a);
export const deleteAthlete = (...a) => impl.deleteAthlete(...a);

export const getSettings = (...a) => impl.getSettings(...a);
export const updateSettings = (...a) => impl.updateSettings(...a);

export const getModuleProfiles = (...a) => impl.getModuleProfiles(...a);
export const submitOnboarding = (...a) => impl.submitOnboarding(...a);

export const getMentors = (...a) => impl.getMentors(...a);
export const createMentor = (...a) => impl.createMentor(...a);
export const patchMentor = (...a) => impl.patchMentor(...a);
export const deleteMentor = (...a) => impl.deleteMentor(...a);

export const getCheckIns = (...a) => impl.getCheckIns(...a);
export const createCheckIn = (...a) => impl.createCheckIn(...a);
export const deleteCheckIn = (...a) => impl.deleteCheckIn(...a);

export const getInterventions = (...a) => impl.getInterventions(...a);
export const createIntervention = (...a) => impl.createIntervention(...a);
export const patchIntervention = (...a) => impl.patchIntervention(...a);
export const deleteIntervention = (...a) => impl.deleteIntervention(...a);

export const getMentorPlan = (...a) => impl.getMentorPlan(...a);
export const submitMentorPlan = (...a) => impl.submitMentorPlan(...a);

export const resetDemo = demo.resetDemo;
/** No-op kept for compatibility with the shared query-key factory. */
export function setActiveTenant() {}
