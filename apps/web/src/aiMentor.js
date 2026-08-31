/**
 * AI mentor — framework for letting an ElevenLabs Conversational-AI voice agent
 * conduct the academic development-plan session in place of a human mentor.
 *
 * The agent talks the student through the plan; whenever it establishes a fact it
 * calls one of the CLIENT TOOLS below, which build up the same payload a human
 * mentor's wizard produces and submit it through the existing token-gated
 * mentor-plan API. That means an AI-run session lands on the roster exactly like a
 * human one — same report link, same checklist, same standing.
 *
 * Two transports share this contract:
 *   • ElevenLabs (production) — `aiMentorElevenLabs.js`, gated on config.
 *   • Scripted mock (this file) — drives the same tools so the demo works with no
 *     key, using the browser's speech synthesis for voice.
 */
import {
  ADP_SECTIONS,
  ADP_SECTION_META,
  ADP_KIND,
  moduleScreenStatus,
  isModuleFlagged,
  ACTION_SECTION_META,
} from './academic-model.js';

/* ───────────────────────────── The tool contract ────────────────────────── */

/**
 * The client tools the ElevenLabs agent is configured to call. This is the whole
 * integration surface: define these on the agent (name + parameters) in the
 * ElevenLabs dashboard, and provide the implementations from `makeCollector()`.
 */
export const AI_MENTOR_TOOLS = [
  {
    name: 'screen_module',
    description: "Record the quick triage for one of the student's modules.",
    parameters: {
      code: 'string — the module code, e.g. ECO1010F',
      attending: "one of: 'Yes' | 'Patchy' | 'No'",
      understanding: "one of: 'Comfortably' | 'Getting by' | 'Struggling'",
      assessments: "one of: 'On track' | 'Slightly behind' | 'Behind'",
      difficulty: "one of: 'Easy' | 'Manageable' | 'Hard'",
    },
  },
  {
    name: 'assess_area',
    description:
      "Record how the student is doing in one development area on a 1–5 scale (1 critical, 5 strong).",
    parameters: {
      area: "one of: 'content' | 'assessments' | 'worklife' | 'careers'",
      score: 'integer 1–5',
      note: 'optional short note in the student’s words',
    },
  },
  {
    name: 'add_action',
    description: 'Add one concrete action to the student’s checklist for an area.',
    parameters: {
      area: "one of: 'content' | 'assessments' | 'worklife' | 'careers'",
      text: 'the action, phrased as something the student will do',
    },
  },
  {
    name: 'flag_wellbeing',
    description:
      'Flag a wellbeing or safety concern for urgent HUMAN follow-up. Call this the moment the student sounds distressed, unsafe, or mentions crisis — then reassure and continue gently.',
    parameters: { concern: 'a short, factual description of the concern' },
  },
  {
    name: 'set_next_session',
    description: 'Record when the student should next be seen (ISO date).',
    parameters: { date: 'YYYY-MM-DD' },
  },
  {
    name: 'submit_plan',
    description:
      'Finalise and submit the plan once every area has been covered and actions agreed. Provide a one-paragraph summary.',
    parameters: { summary: 'a short summary of the session and the agreed support' },
  },
];

/* ─────────────────────────────── Agent prompt ────────────────────────────── */

/**
 * The system prompt that turns an ElevenLabs agent into the academic mentor. In
 * production, set this on the agent (or pass via `overrides.agent.prompt.prompt`)
 * and inject the per-student facts as dynamic variables ({{first_name}} etc.).
 */
export const AI_MENTOR_PROMPT = `You are a warm, encouraging academic mentor for a university sport programme, running a one-on-one academic development check-in with a student-athlete by voice. You are NOT a human — if asked, say you're the programme's AI mentor and that a real person reviews every plan.

The student is {{first_name}}, in {{period}}. Their registered modules are: {{modules}}.

Run the session in this order, ONE question at a time, in plain, friendly language:
1. Warmly welcome them and explain this takes about ten minutes and helps line up support.
2. For each module, quickly triage it — are they attending, following the material, on track with assessments, and how hard it feels — and call screen_module.
3. For each of the four areas — understanding the content, assessments, work-life balance, careers — draw them out with an open question, reflect back what you hear, agree a 1–5 sense of how it's going, and call assess_area.
4. Where an area is a 3 or below, propose one or two concrete, doable actions, check they're happy with them, and call add_action.
5. Agree when you'll next check in and call set_next_session.
6. Summarise what you heard and the support you agreed, thank them, and call submit_plan.

Rules: never lecture; keep turns short; always reflect feelings before moving on. If the student sounds distressed, overwhelmed, unsafe, or mentions self-harm, money or housing crisis, immediately call flag_wellbeing, tell them you're making sure a person from the office reaches out today, and gently continue only if they're comfortable. Do not give medical, legal or financial advice — route to the relevant service instead. Record facts with the tools as you go; don't wait until the end.`;

/* ─────────────────────── Tool implementations + payload ──────────────────── */

const clampScore = (v) => Math.max(1, Math.min(5, Math.round(Number(v) || 0)));

/**
 * Builds the shared collected-state + tool implementations for a session, plus
 * `buildPayload()` which turns it into the exact shape `submitMentorPlan` expects
 * (same as the human mentor wizard). Both transports use this.
 */
export function makeCollector(ctx) {
  const moduleByCode = new Map((ctx.modules ?? []).map((m) => [m.code, m]));
  const collected = {
    screener: {}, // code -> { attending, understanding, assessments, difficulty }
    areas: {}, // areaKey -> { score, note }
    actions: [], // { section, text }
    wellbeing: [], // concerns for human follow-up
    next: '',
    summary: '',
  };

  const tools = {
    screen_module: ({ code, attending, understanding, assessments, difficulty }) => {
      const c = String(code || '').toUpperCase();
      collected.screener[c] = { attending, understanding, assessments, difficulty };
      return `Noted ${c}.`;
    },
    assess_area: ({ area, score, note }) => {
      if (!ADP_SECTION_META[area]) return `Unknown area "${area}".`;
      collected.areas[area] = { score: clampScore(score), note: note || '' };
      return `Recorded ${area}.`;
    },
    add_action: ({ area, text }) => {
      if (!text?.trim()) return 'No action text.';
      collected.actions.push({ section: ADP_SECTION_META[area] ? area : 'content', text: text.trim() });
      return `Added: ${text}`;
    },
    flag_wellbeing: ({ concern }) => {
      collected.wellbeing.push(concern || 'wellbeing concern');
      return 'Flagged for the office to follow up today.';
    },
    set_next_session: ({ date }) => {
      collected.next = date || '';
      return `Next session ${date}.`;
    },
    submit_plan: ({ summary }) => {
      collected.summary = summary || '';
      return 'Ready to submit.';
    },
  };

  function buildPayload() {
    // Modules + their screener triage → status.
    const modules = Object.entries(collected.screener).map(([code, screener]) => {
      const known = moduleByCode.get(code) ?? {};
      return {
        code,
        name: known.name,
        convener: known.convener,
        credits: known.credits,
        difficulty: known.difficulty,
        screener,
        status: moduleScreenStatus(screener),
      };
    });
    const flaggedCodes = modules.filter(isModuleFlagged).map((m) => m.code);

    // Area scores → the sections shape (module areas apply to the flagged modules).
    const sections = {};
    for (const sec of ADP_SECTIONS) {
      const rec = collected.areas[sec.key];
      if (!rec) continue;
      const attrs = Object.fromEntries(sec.attrs.map((a) => [a.key, rec.score]));
      if (sec.scope === 'module') {
        const mods = {};
        for (const code of flaggedCodes.length ? flaggedCodes : modules.map((m) => m.code)) {
          mods[code] = attrs;
        }
        sections[sec.key] = { modules: mods, note: rec.note || undefined };
      } else {
        sections[sec.key] = { ratings: attrs, note: rec.note || undefined };
      }
    }

    const plan = collected.actions.map((a) => ({ section: a.section, text: a.text, done: false }));
    const wellbeingNote = collected.wellbeing.length
      ? `⚠ Wellbeing follow-up needed: ${collected.wellbeing.join('; ')}. `
      : '';

    return {
      kind: ADP_KIND,
      modules,
      sections,
      plan,
      note: `${wellbeingNote}${collected.summary}`.trim() || undefined,
      scheduledNext: collected.next || undefined,
      followUpRequired: collected.wellbeing.length || plan.length ? 'Yes' : 'No',
      answers: {},
    };
  }

  return { collected, tools, buildPayload };
}

/* ────────────────────────── Scripted mock transport ─────────────────────── */

/**
 * A scripted stand-in for the ElevenLabs agent so the demo works with no API key.
 * It's an async generator: it yields conversation turns (a line the mentor says,
 * with optional quick-reply `choices`) and receives the student's answer back —
 * calling the same tools the real agent would. The page pumps it and speaks each
 * line aloud with the browser's speech synthesis.
 */
export async function* mockMentorScript(ctx, tools) {
  const first = ctx.firstName || 'there';
  yield { text: `Hi ${first}, I'm your academic mentor. This'll take about ten minutes — no wrong answers, I just want to line up the right support for you. Ready?`, choices: ["Let's go"] };

  const modules = (ctx.modules ?? []).slice(0, 2);
  for (const m of modules) {
    const attending = yield { text: `Let's start with ${m.code}${m.name ? ` — ${m.name}` : ''}. Are you making it to the lectures and tutorials?`, choices: ['Yes', 'Patchy', 'No'] };
    const understanding = yield { text: `Got it. And are you following the material in ${m.code}?`, choices: ['Comfortably', 'Getting by', 'Struggling'] };
    const assessments = yield { text: `Thanks for being honest. Are you on track with the tests and assignments?`, choices: ['On track', 'Slightly behind', 'Behind'] };
    tools.screen_module({ code: m.code, attending, understanding, assessments, difficulty: 'Manageable' });
  }

  const AREAS = [
    { key: 'content', q: 'Now, thinking about actually understanding your coursework — how is that going, on a scale of 1 to 5?' },
    { key: 'assessments', q: 'And your tests, assignments and exam prep — where would you put that, 1 to 5?' },
    { key: 'worklife', q: 'How about balancing training, matches and study — 1 to 5?' },
    { key: 'careers', q: 'Last one — how clear are you on where this degree is taking you, 1 to 5?' },
  ];
  for (const area of AREAS) {
    const raw = yield { text: area.q, choices: ['1', '2', '3', '4', '5'] };
    const score = Number(raw) || 3;
    tools.assess_area({ area: area.key, score });
    if (score <= 3) {
      const suggestion = ACTION_SECTION_META[area.key]?.items?.[0];
      if (suggestion) {
        const ans = yield { text: `Okay — that's exactly what I'm here for. How about we set this: "${suggestion}"?`, choices: ['Add it', 'Skip'] };
        if (ans === 'Add it') tools.add_action({ area: area.key, text: suggestion });
      }
      if (area.key === 'worklife' && score <= 2) {
        tools.flag_wellbeing({ concern: 'Student rated work-life balance low' });
        yield { text: `That sounds like a lot to carry. I'm flagging this so someone from the office checks in with you today — you don't have to handle it alone. Shall we keep going?`, choices: ["Yes, let's continue"] };
      }
    } else {
      yield { text: `Love that — keep doing what's working.`, choices: ['👍'] };
    }
  }

  yield { text: `Great. I'll set a check-in for a few weeks' time to see how the actions are landing.` };
  tools.set_next_session({ date: ctx.suggestedNext });
  yield { text: `Here's what I heard: you're engaged and putting the work in, with some targeted support lined up. I'm saving your plan now — you'll get a link to see it and tick off your actions. Thanks for the honesty, ${first}.`, choices: ['Thanks!'] };
  tools.submit_plan({ summary: `AI-mentor session with ${first}. Support agreed across the areas that needed it; actions set for the student to action.` });
}
