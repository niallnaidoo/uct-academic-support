# AI mentor — ElevenLabs integration framework

An **ElevenLabs Conversational-AI voice agent** that runs the academic
development-plan session with a student in place of a human mentor. The agent
talks the student through the plan; whenever it establishes a fact it calls a
**client tool**, and those tools build and submit the *same* plan a human mentor
would — so an AI-run session lands on the roster identically (same report link,
checklist, standing, and the same “a person reviews it” safety net).

> A real person still reviews every AI-run plan, and any wellbeing concern is
> escalated to a human immediately (see **Safety**).

---

## The shape of it

```
Student  ──voice──►  ElevenLabs agent  ──function calls──►  client tools
   ▲                     (LLM + TTS/STT)                        │
   └──────voice──────────────┘                                  ▼
                                             makeCollector() builds the ADP payload
                                                                │
                                                                ▼
                                             submitMentorPlan(id, token, payload)
                                                (the existing token-gated API)
```

- **One link per student.** The office assigns a plan (as today) and shares the
  **AI-mentor link** `#/ai-mentor/:id?t=<token>` instead of (or alongside) the
  human mentor link. Same token, same plan record.
- **The agent drives; the tools record.** The agent’s only job is the
  conversation. Every fact it establishes is written through a small, fixed set
  of client tools — that’s the entire integration surface.
- **Two transports, one contract.** `aiMentor.js` defines the contract (prompt +
  tools + payload builder). `aiMentorElevenLabs.js` is the production transport;
  a scripted mock (also in `aiMentor.js`) runs the exact same tools so the demo
  works with no key, using the browser’s speech synthesis for voice.

---

## The tool contract (the whole integration surface)

Configure these as **client tools** on your ElevenLabs agent (name + params);
the browser provides the implementations from `makeCollector()`.

| Tool | When the agent calls it | Params |
|------|------------------------|--------|
| `screen_module` | after triaging a module | `code`, `attending`, `understanding`, `assessments`, `difficulty` |
| `assess_area` | after gauging an area 1–5 | `area` (content/assessments/worklife/careers), `score` 1–5, `note` |
| `add_action` | when agreeing an action | `area`, `text` |
| `flag_wellbeing` | the moment distress/crisis appears | `concern` |
| `set_next_session` | agreeing the next check-in | `date` (YYYY-MM-DD) |
| `submit_plan` | at the end | `summary` |

`submit_plan` triggers `submitMentorPlan(id, token, buildPayload())`. The exact
schemas are in `AI_MENTOR_TOOLS` (`aiMentor.js`); the system prompt is
`AI_MENTOR_PROMPT`.

---

## Quick demo (public agent — no server, no key in the app)

For an illustration you don't need the signed-URL server. Create a **public
agent** in the ElevenLabs dashboard and connect to it by id:

1. **ElevenLabs → Conversational AI → Create agent.**
   - **System prompt:** paste `AI_MENTOR_PROMPT` from `aiMentor.js` verbatim (it
     declares the `{{first_name}}`, `{{period}}`, `{{modules}}` variables).
   - **First message:** e.g. `Hi {{first_name}} — ready when you are?`
   - **Voice / language:** pick a warm English voice.
   - *(Optional, for the plan to auto-fill/submit)* add the six **client tools**
     from `AI_MENTOR_TOOLS` (name + params). Skip them for a conversation-only
     illustration.
2. **Security → make the agent public** (allow connection without a signed URL).
   Leave overrides off — the prompt lives on the agent.
3. **Copy the agent id** (`agent_…`).
4. **Run it** — no rebuild needed. Open a plan's AI-mentor link with the id
   appended, or paste the id into the page's *Connect a live ElevenLabs agent*
   field:
   ```
   …/#/ai-mentor/<planId>?t=<token>&agent=<agent_id>
   ```
   The page shows **“ElevenLabs voice”**, asks for the microphone, and the agent
   talks the student through the plan. Test it first with the dashboard's own
   *Test agent* button.

The API key is used **only in the dashboard** to build the agent — never in the
browser or the repo. Rotate any key that's been shared in chat/email.

## Going live (production)

1. **Create the agent** in the ElevenLabs dashboard. Paste `AI_MENTOR_PROMPT` as
   the system prompt (it uses `{{first_name}}`, `{{period}}`, `{{modules}}`
   dynamic variables), pick a warm voice, and add the six client tools above.
2. **Add a signed-URL endpoint** on your backend (the only server piece). It
   calls ElevenLabs with your **secret API key** and returns a short-lived signed
   URL — the key never reaches the browser:

   ```
   GET /ai/eleven-signed-url?agent_id=...   →   { "signed_url": "wss://…" }

   # server-side (pseudo):
   GET https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=...
       header: xi-api-key: <SECRET>
   ```
3. **Set the env** and rebuild the web app:
   ```
   VITE_ELEVENLABS_AGENT_ID=<agent id>
   VITE_ELEVENLABS_SIGNED_URL=/ai/eleven-signed-url
   # optional: VITE_ELEVENLABS_SDK_URL to bundle @elevenlabs/client instead of the CDN
   ```
   With those set, `elevenLabsConfigured()` is true and the AI-mentor page opens
   a live voice session automatically; without them it runs the demo mock.
4. **Persist as normal.** Nothing else changes — the agent’s `submit_plan` writes
   through the same `submitMentorPlan` used by the human mentor.

Prefer bundling the SDK (`npm i @elevenlabs/client`) over the runtime CDN import
for production; the CDN import in `aiMentorElevenLabs.js` is only to keep the
demo build dependency-free.

---

## Safety, consent & review — non-negotiable

- **Human in the loop.** Every AI-run plan is reviewed by the office; the student
  is told this up front and in the closing message.
- **Wellbeing escalation.** The prompt instructs the agent to call
  `flag_wellbeing` the instant a student sounds distressed, unsafe, or mentions a
  money/housing/self-harm crisis. That stamps the plan for **same-day human
  follow-up** (surfaced in the plan note and the office’s follow-up view) — the
  AI never “handles” a crisis alone.
- **Scope guard.** The agent gives no medical, legal or financial advice — it
  routes to the relevant university service.
- **POPIA.** The session runs under the same consent captured at onboarding; the
  student can stop any time; audio is handled per your ElevenLabs data settings
  (turn off retention/training for a student cohort).

---

## Files

| File | Role |
|------|------|
| `apps/web/src/aiMentor.js` | Contract: tools schema, system prompt, `makeCollector()` (tool impls + `buildPayload()`), and the scripted mock. |
| `apps/web/src/aiMentorElevenLabs.js` | Production transport — signed-URL fetch + SDK session, config-gated. |
| `apps/web/src/AiMentorPage.jsx` | The `#/ai-mentor/:id?t=` page (voice UI + live plan panel + submit). |

The demo (no key) runs the mock so you can experience the flow end to end; wiring
the three env vars above swaps in the real ElevenLabs voice with no other change.
