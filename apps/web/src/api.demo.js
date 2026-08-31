/**
 * In-browser demo backend — a localStorage-backed mock of the real API.
 *
 * Used when no VITE_API_URL is set (the GitHub Pages demo). Every function mirrors
 * the real endpoint's behaviour (id/token minting, upper-cased student numbers,
 * assessedAt stamping, the mentor-plan token flow) so the UI is exercised exactly
 * as it would be against the Hono backend — just with no server and no auth.
 */
import { demoAthletes, demoMentors, demoCheckIns, demoInterventions } from './demo-seed.js';
import { buildGradebook, standingFromPlan, markAverage } from './academic-model.js';

/**
 * Derive each athlete's academic standing from their latest completed development
 * plan + recorded marks — so risk is frictionless (no manual snapshot needed).
 */
function recomputeStandings(db) {
  const latest = {};
  for (const c of db.checkIns ?? []) {
    if (c.kind !== 'adp' || c.planStatus !== 'completed') continue;
    const t = c.completedAt ?? c.date ?? '';
    const cur = latest[c.studentNumber];
    if (!cur || t > (cur.completedAt ?? cur.date ?? '')) latest[c.studentNumber] = c;
  }
  for (const a of db.athletes ?? []) {
    const c = latest[a.studentNumber];
    a.standing = c ? standingFromPlan(c, markAverage(a.grades)) : undefined;
  }
  return db;
}

const KEY = 'uct-academic-demo-v1';

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return recomputeStandings(withDefaults(JSON.parse(raw)));
  } catch {
    /* fall through to seed */
  }
  const db = {
    athletes: demoAthletes(),
    mentors: demoMentors(),
    checkIns: demoCheckIns(),
    interventions: demoInterventions(),
    moduleProfiles: {},
    settings: { ...DEFAULT_SETTINGS },
  };
  save(db);
  return recomputeStandings(db);
}
/** Organisation settings — makes the platform scalable across schools/sports. */
export const DEFAULT_SETTINGS = {
  orgName: 'University of Cape Town',
  orgShort: 'UCT',
  sport: 'Rugby — Ikey Tigers',
  programmeName: 'Academic Support',
  contactEmail: 'academics@ikeys.uct.ac.za',
  squads: ['1st Team', 'U20s', 'Both', 'General'],
  admins: [{ name: 'Programme Administrator', email: 'admin@ikeys.uct.ac.za' }],
  // ElevenLabs public agent id — set this to turn on the AI voice mentor for
  // every AI-mentor link across the platform. Blank = the keyless demo voice.
  elevenAgentId: '',
};

/** Fill in any keys a persisted (older) db is missing. */
function withDefaults(db) {
  db.athletes ??= [];
  db.mentors ??= [];
  db.checkIns ??= [];
  db.interventions ??= [];
  db.moduleProfiles ??= {};
  db.settings = { ...DEFAULT_SETTINGS, ...(db.settings ?? {}) };
  // Every ADP plan needs a token so its no-password report link works — backfill
  // any legacy plan created before tokens were minted for in-house completions.
  for (const c of db.checkIns) {
    if ((c.kind === 'adp' || c.planStatus) && !c.token) c.token = tokenStr();
  }
  // Seeded demo athletes get a stable gradebook token so their demo link works
  // for any visitor (and for anyone who seeded before the token existed).
  for (const a of db.athletes) {
    const m = /^ath-demo-(\d+)$/.exec(a.id ?? '');
    if (m && !a.gradebookToken && Number(m[1]) <= 12) a.gradebookToken = `demo-${m[1]}`;
  }
  return db;
}
function save(db) {
  localStorage.setItem(KEY, JSON.stringify(db));
}
function mutate(fn) {
  const db = load();
  const result = fn(db);
  save(db);
  return result;
}

const uid = (prefix) =>
  `${prefix}-${(crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)).slice(0, 8)}`;
const tokenStr = () =>
  (Array.from(crypto.getRandomValues?.(new Uint8Array(18)) ?? []).map((b) => b.toString(36)).join('') ||
    Math.random().toString(36).slice(2)).slice(0, 24);
const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
const clone = (v) => JSON.parse(JSON.stringify(v));
const ok = (v) => Promise.resolve(clone(v));

/* Reset helper the demo banner can call. */
export function resetDemo() {
  localStorage.removeItem(KEY);
}

/* ── Athletes ── */
export const getAthletes = () => ok(load().athletes);
export const getAthlete = (id) => ok(load().athletes.find((a) => a.id === id) ?? null);
export const createAthlete = (body) =>
  ok(
    mutate((db) => {
      const assessed =
        body.lectureAttendance != null ||
        body.semesterAverage != null ||
        body.assignmentCompletion != null;
      const a = {
        ...body,
        id: uid('ath'),
        studentNumber: String(body.studentNumber ?? '').trim().toUpperCase(),
        status: body.status ?? 'active',
        assessedAt: assessed ? now() : undefined,
        version: 1,
      };
      db.athletes.push(a);
      return a;
    }),
  );
export const patchAthlete = (id, patch) =>
  ok(
    mutate((db) => {
      const a = db.athletes.find((x) => x.id === id);
      if (!a) throw new Error('athlete not found');
      Object.assign(a, patch, { id, version: (a.version ?? 1) + 1 });
      const touched = ['lectureAttendance', 'tutorialAttendance', 'assignmentCompletion', 'semesterAverage', 'facultyWarning'];
      if (touched.some((k) => k in patch)) a.assessedAt = now();
      return a;
    }),
  );
export const deleteAthlete = (id) =>
  ok(
    mutate((db) => {
      db.athletes = db.athletes.filter((a) => a.id !== id);
      return { ok: true };
    }),
  );

/* ── Organisation settings ── */
export const getSettings = () => ok(load().settings ?? DEFAULT_SETTINGS);
export const updateSettings = (patch) =>
  ok(
    mutate((db) => {
      db.settings = { ...DEFAULT_SETTINGS, ...(db.settings ?? {}), ...patch };
      return db.settings;
    }),
  );

/* ── Module profiles (shared, auto-populate) ──
 * Course-level detail a student captures once at onboarding — class times and
 * assessment dates — keyed by course code. The next student who registers the
 * same module gets it pre-filled, so the office only ever types a module once. */
export const getModuleProfiles = () => ok(load().moduleProfiles ?? {});

/* ── Student self-onboarding (public link) ──
 * A student opens the onboarding link, screens their modules and captures their
 * details. This upserts the athlete (by student number) and folds every module's
 * times + assessment dates into the shared module-profile store. */
export const submitOnboarding = (body) =>
  ok(
    mutate((db) => {
      db.moduleProfiles ??= {};
      const modules = (body.modules ?? [])
        .filter((m) => String(m.code ?? '').trim())
        .map((m) => ({
          code: String(m.code).trim().toUpperCase(),
          name: m.name?.trim() || undefined,
          convener: m.convener || undefined,
          credits: m.credits ?? undefined,
          faculty: m.faculty || undefined,
          nqf: m.nqf ?? undefined,
          difficulty: m.difficulty ?? undefined,
          sessions: (m.sessions ?? []).filter((s) => s.day && s.time),
          times: m.times?.trim() || undefined,
          assessments: (m.assessments ?? []).filter((a) => a.date || a.label),
        }));
      // Fold each module into the shared profile store (auto-populate source).
      for (const m of modules) {
        const prev = db.moduleProfiles[m.code] ?? {};
        db.moduleProfiles[m.code] = {
          code: m.code,
          name: m.name ?? prev.name,
          convener: m.convener ?? prev.convener,
          credits: m.credits ?? prev.credits,
          faculty: m.faculty ?? prev.faculty,
          nqf: m.nqf ?? prev.nqf,
          difficulty: m.difficulty ?? prev.difficulty,
          sessions: m.sessions?.length ? m.sessions : prev.sessions,
          times: m.times ?? prev.times,
          assessments: m.assessments?.length ? m.assessments : prev.assessments,
        };
      }
      const studentNumber = String(body.studentNumber ?? '').trim().toUpperCase();
      const creditsRegistered =
        modules.reduce((t, m) => t + (Number(m.credits) || 0), 0) || undefined;
      const identity = {
        firstName: body.firstName?.trim() || '',
        lastName: body.lastName?.trim() || '',
        studentNumber,
        squad: body.squad || 'General',
        faculty: body.faculty || undefined,
        degree: body.degree || undefined,
        yearOfStudy: body.yearOfStudy || undefined,
        creditsRegistered,
        modules,
        facultyWarning: 'No',
        onboardedAt: now(),
        // Consent is implicit — academic support is part of the programme.
        consentAt: now(),
      };
      const existing = db.athletes.find((a) => a.studentNumber === studentNumber);
      if (existing) {
        Object.assign(existing, identity, { id: existing.id, version: (existing.version ?? 1) + 1 });
        return existing;
      }
      const a = { id: uid('ath'), status: 'active', version: 1, ...identity };
      db.athletes.push(a);
      return a;
    }),
  );

/* ── Mentors ── */
export const getMentors = () => ok(load().mentors);
export const createMentor = (body) => {
  if (!body.name?.trim()) return Promise.reject(new Error('a name is required'));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email ?? '').trim()))
    return Promise.reject(new Error('a valid email address is required'));
  return ok(
    mutate((db) => {
      const m = {
        id: uid('mtr'),
        name: body.name.trim(),
        email: body.email.trim().toLowerCase(),
        phone: body.phone?.trim() || undefined,
        organisation: body.organisation?.trim() || undefined,
        version: 1,
      };
      db.mentors.push(m);
      return m;
    }),
  );
};
export const patchMentor = (id, patch) =>
  ok(
    mutate((db) => {
      const m = db.mentors.find((x) => x.id === id);
      if (!m) throw new Error('mentor not found');
      Object.assign(m, patch, { id, version: (m.version ?? 1) + 1 });
      return m;
    }),
  );
export const deleteMentor = (id) =>
  ok(
    mutate((db) => {
      db.mentors = db.mentors.filter((m) => m.id !== id);
      return { ok: true };
    }),
  );

/* ── Development plans (check-ins) ── */
export const getCheckIns = () =>
  ok([...load().checkIns].sort((a, b) => String(b.date).localeCompare(String(a.date))));
export const createCheckIn = (body) =>
  ok(
    mutate((db) => {
      const athlete = db.athletes.find((a) => a.id === body.athleteId);
      const id = uid('chk');
      // Every ADP plan (assigned OR completed in-house) gets a token so its
      // no-password report link works for the student and mentor.
      const token = body.planStatus === 'sent' || body.kind === 'adp' ? tokenStr() : undefined;
      const c = {
        id,
        studentNumber: String(body.studentNumber ?? '').trim().toUpperCase(),
        athleteName:
          body.athleteName ?? (athlete ? `${athlete.firstName} ${athlete.lastName}` : body.studentNumber),
        date: body.date || today(),
        mentor: body.mentor ?? athlete?.mentor,
        followUpRequired: body.followUpRequired,
        answers: body.answers ?? {},
        note: body.note,
        kind: body.kind,
        period: body.period,
        modules: body.modules,
        sections: body.sections,
        plan: body.plan,
        mentorEmail: body.mentorEmail,
        planStatus: body.planStatus,
        token,
        scheduledNext: body.scheduledNext,
        sentAt: body.planStatus === 'sent' ? now() : undefined,
        completedAt: body.planStatus === 'completed' ? now() : undefined,
        createdAt: now(),
        version: 1,
      };
      db.checkIns.push(c);
      return c;
    }),
  );
/** Patch an existing plan — used to continue a draft, or edit a completed plan. */
export const updateCheckIn = (id, patch) =>
  ok(
    mutate((db) => {
      const c = db.checkIns.find((x) => x.id === id);
      if (!c) throw new Error('plan not found');
      const becomingCompleted = patch.planStatus === 'completed' && c.planStatus !== 'completed';
      Object.assign(c, patch, { id, version: (c.version ?? 1) + 1 });
      if (becomingCompleted) c.completedAt = now();
      if (patch.planStatus === 'draft') c.draftSavedAt = now();
      if ((c.kind === 'adp' || c.planStatus) && !c.token) c.token = tokenStr();
      return c;
    }),
  );
export const deleteCheckIn = (id) =>
  ok(
    mutate((db) => {
      db.checkIns = db.checkIns.filter((c) => c.id !== id);
      return { ok: true };
    }),
  );

/* ── Interventions ── */
export const getInterventions = () =>
  ok([...load().interventions].sort((a, b) => String(b.date).localeCompare(String(a.date))));
export const createIntervention = (body) =>
  ok(
    mutate((db) => {
      const athlete = db.athletes.find((a) => a.id === body.athleteId);
      const iv = {
        id: uid('int'),
        studentNumber: String(body.studentNumber ?? '').trim().toUpperCase(),
        athleteName:
          body.athleteName ?? (athlete ? `${athlete.firstName} ${athlete.lastName}` : body.studentNumber),
        date: body.date || today(),
        concern: body.concern,
        actionTaken: body.actionTaken,
        referredTo: body.referredTo,
        followUpDate: body.followUpDate,
        status: body.status ?? 'open',
        createdAt: now(),
        version: 1,
      };
      db.interventions.push(iv);
      return iv;
    }),
  );
export const patchIntervention = (id, patch) =>
  ok(
    mutate((db) => {
      const iv = db.interventions.find((x) => x.id === id);
      if (!iv) throw new Error('intervention not found');
      Object.assign(iv, patch, { id, version: (iv.version ?? 1) + 1 });
      return iv;
    }),
  );
export const deleteIntervention = (id) =>
  ok(
    mutate((db) => {
      db.interventions = db.interventions.filter((iv) => iv.id !== id);
      return { ok: true };
    }),
  );

/* ── Student gradebook (token-gated, no auth) ── */
function resolveGradebook(id, token, db) {
  const a = db.athletes.find((x) => x.id === id);
  if (!a) throw new Error('this link is not valid');
  // Seeded demo students always accept their stable `demo-N` link, whatever else
  // is (or isn't) stored — so the shared demo link never goes stale.
  const m = /^ath-demo-(\d+)$/.exec(id ?? '');
  const demoAlias = m ? `demo-${m[1]}` : null;
  if (a.gradebookToken === token || (demoAlias && token === demoAlias)) return a;
  throw new Error('this link is not valid');
}
/** Admin: mint (once) and return the student's gradebook link token. */
export const createGradebookLink = (id) =>
  ok(
    mutate((db) => {
      const a = db.athletes.find((x) => x.id === id);
      if (!a) throw new Error('athlete not found');
      if (!a.gradebookToken) a.gradebookToken = tokenStr();
      return { id: a.id, token: a.gradebookToken, athleteName: `${a.firstName} ${a.lastName}` };
    }),
  );
export const getGradebook = (id, token) => {
  const db = load();
  let a;
  try {
    a = resolveGradebook(id, token, db);
  } catch (e) {
    return Promise.reject(e);
  }
  const gb = buildGradebook(a, db.moduleProfiles ?? {});
  return ok({
    athleteName: `${a.firstName} ${a.lastName}`,
    studentNumber: a.studentNumber,
    faculty: a.faculty,
    allModules: (a.modules ?? []).map((m) => ({ code: m.code, name: m.name })),
    ...gb,
  });
};
export const submitGrades = (id, token, body) =>
  ok(
    mutate((db) => {
      const a = resolveGradebook(id, token, db);
      a.modules = a.modules ?? [];
      // Assessments the student added themselves — fold into their module record.
      for (const na of body.newAssessments ?? []) {
        const code = String(na.code ?? '').trim().toUpperCase();
        if (!code || (!na.label && !na.date)) continue;
        let mod = a.modules.find((m) => m.code === code);
        if (!mod) {
          mod = { code, assessments: [] };
          a.modules.push(mod);
        }
        mod.assessments = mod.assessments ?? [];
        const dup = mod.assessments.some(
          (x) => (x.label ?? '') === (na.label ?? '') && (x.date ?? '') === (na.date ?? ''),
        );
        if (!dup) mod.assessments.push({ label: na.label ?? '', date: na.date ?? '' });
      }
      a.grades = a.grades ?? {};
      for (const g of body.grades ?? []) {
        if (!g.key) continue;
        if (g.mark === '' || g.mark == null) delete a.grades[g.key];
        else a.grades[g.key] = Number(g.mark);
      }
      a.gradesUpdatedAt = now();
      a.version = (a.version ?? 1) + 1;
      const gb = buildGradebook(a, db.moduleProfiles ?? {});
      return { ok: true, recorded: gb.recorded, total: gb.total };
    }),
  );

/* ── Public mentor-plan flow (token-gated) ── */
function resolvePlan(id, token, db) {
  const c = db.checkIns.find((x) => x.id === id);
  if (!c || !c.token || c.token !== token) throw new Error('this link is not valid');
  return c;
}
export const getMentorPlan = (id, token) => {
  const db = load();
  let c;
  try {
    c = resolvePlan(id, token, db);
  } catch (e) {
    return Promise.reject(e);
  }
  const athlete = db.athletes.find((a) => a.studentNumber === c.studentNumber);
  return ok({
    athleteName: c.athleteName,
    studentNumber: c.studentNumber,
    faculty: athlete?.faculty,
    degree: athlete?.degree,
    squad: athlete?.squad,
    period: c.period,
    mentor: c.mentor,
    scheduledNext: c.scheduledNext,
    planStatus: c.planStatus,
    completedAt: c.completedAt,
    modules: c.modules ?? [],
    sections: c.sections ?? {},
    plan: c.plan ?? [],
    note: c.note,
  });
};
export const submitMentorPlan = (id, token, body) =>
  ok(
    mutate((db) => {
      const c = resolvePlan(id, token, db);
      const status = body.status === 'draft' ? 'draft' : 'completed';
      const wasCompleted = c.planStatus === 'completed';
      Object.assign(c, {
        modules: body.modules ?? c.modules,
        sections: body.sections ?? c.sections,
        plan: body.plan ?? c.plan,
        note: body.note ?? c.note,
        scheduledNext: body.scheduledNext ?? c.scheduledNext,
        followUpRequired: body.followUpRequired ?? c.followUpRequired,
        planStatus: status,
        version: (c.version ?? 1) + 1,
      });
      if (status === 'draft') {
        c.draftSavedAt = now();
        return { ok: true, athleteName: c.athleteName, status };
      }
      c.completedAt = now();
      c.date = today();
      // Log only legacy (typed) interventions — checklist actions live on the plan.
      if (!wasCompleted) {
        for (const item of (body.plan ?? []).filter((i) => i.type && !i.text)) {
          db.interventions.push({
            id: uid('int'),
            studentNumber: c.studentNumber,
            athleteName: c.athleteName,
            date: today(),
            concern: `${item.type ?? 'intervention'}${item.module ? ` · ${item.module}` : ''}${c.period ? ` · ${c.period}` : ''}`,
            actionTaken: item.type,
            referredTo: item.referredTo,
            followUpDate: item.dueDate,
            status: 'open',
            version: 1,
          });
        }
      }
      return { ok: true, athleteName: c.athleteName, status };
    }),
  );

/** Student ticks off their action checklist — proactive monitoring, no login. */
export const setPlanProgress = (id, token, body) =>
  ok(
    mutate((db) => {
      const c = resolvePlan(id, token, db);
      const done = body.done ?? []; // booleans, by plan-item index
      c.plan = (c.plan ?? []).map((it, i) => (i < done.length ? { ...it, done: !!done[i] } : it));
      c.progressAt = now();
      c.version = (c.version ?? 1) + 1;
      return { ok: true, done: c.plan.filter((i) => i.done).length, total: c.plan.length };
    }),
  );
