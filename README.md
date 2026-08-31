# UCT Academic Support

Student-athlete academic support for a university sport programme: a live RAG
risk tracker, a course-catalogue-aware **development-plan** wizard, and an
**external-mentor** workflow where a mentor completes a plan for one athlete via
a private link — no login.

Built from the UCT RFC (Ikey Tigers) Academic Mentorship Tracker and Academic
Assistance SOP. Isolated from a larger sports-administration platform into this
standalone repo.

---

## What it does

- **Administrator login** — only administrators reach the platform. The demo
  accepts any email with the password `ikeys`; production wires UCT single
  sign-on (Cognito) in place of the stand-in.
- **Onboard students by link** — from the roster, *Onboard students* produces one
  shareable link (no login for the student). Students capture their details and
  screen their modules; each module’s **class times and assessment dates are
  saved and auto-fill for the next student** taking the same course. New
  registrations appear on the roster.
- **Dashboard** — squad RAG distribution, immediate-attention set, faculty
  analysis, mentor follow-ups, and a squad-wide **radar** across the four
  development areas pooled from every plan (development-plan summary sits at the
  foot of the dashboard).
- **Athletes** — roster with filter chips; each athlete opens to a live academic
  tracker, a **Mentorship** card (assigned mentor, last seen, next session), and
  their development-plan **radar**.
- **Academic tracker** — capture attendance, assignments, semester average and
  faculty-warning status; risk (Green/Amber/Red/Critical) is computed with the
  tracker's exact formula.
- **Academic development plans** — **search** and **multi-select** students, pick
  one mentor, and **bulk-send** them all a private link in one action; or assign a
  single plan and complete it in-house. Each plan's screener is pre-filled with
  the student's registered modules, so the mentor only triages which ones to
  focus on. The list is the full **history** (every plan, newest first): open a
  completed plan to **view or edit** it, pick up a **draft** where you left off,
  or resend an awaiting mentor's link. Both the mentor (on their link) and the
  office (in-house) can **save a draft** and finish later.
- **The plan itself** — a module **screener** (type a UCT code and the title,
  convener, credits and an auto-assigned difficulty fill in from the **3,272**
  courses mined from the 2026 faculty handbooks; easy modules screen clear), then
  four development areas rated 1–5 with tailored per-category descriptors, a
  **question bank** to draw the student out, and an **action checklist** — the
  mentor ticks concrete, per-area actions for the student (no dates/calendars).
  The student then ticks these off on their own report link, so progress is
  monitored proactively.
- **Academic standing (frictionless)** — an athlete's RAG standing is derived
  from the development plan's 1–5 ratings and their **real recorded marks** — no
  subjective, manually-captured attendance percentages to keep up to date. The
  athlete view leads with plan-derived metrics (standing, average mark, modules
  to watch, actions on track). `academicRisk` prefers `athlete.standing` (set by
  `standingFromPlan`), falling back to a manual snapshot only if there's no plan.
- **Gradebook** — assessment dates captured at onboarding (or seeded from a
  teammate who's taken the same module) drive a per-student **gradebook**. Three
  weeks after each assessment, marks are usually out, so the student is prompted
  to record them on a no-login page — where they can also **add their own
  assessments** and, on submit, get a **thank-you** confirmation. The admin's
  Gradebook tab flags who has marks due and generates each student's link (one,
  or all-due in bulk).
- **Mentors** — a registry of external mentors (add one, or bulk-upload a CSV).
  Mentors never log in.
- **Public mentor page** (`/#/mentor/:id?t=…`) — the external mentor opens their
  link, completes the plan with the student, submits, and sees the summary.

---

## Repo layout

```
apps/web/          Vite + React SPA (the whole UI)
packages/api/      Hono backend on DynamoDB single-table (for the dev team)
.github/workflows/ Pages deploy for the demo
```

The SPA talks to an API facade (`apps/web/src/api.js`) that runs in one of two
modes:

- **Demo (default)** — an in-browser mock backed by `localStorage`, seeded with
  **anonymised, synthetic** athletes and the real course catalogue. No server, no
  auth. This is what GitHub Pages hosts.
- **Live** — set `VITE_API_URL` (and `VITE_LOCAL_AUTH=1` for the local backend)
  and the same UI talks to the real Hono API instead.

---

## Run the demo locally

```bash
cd apps/web
npm install
npm run dev      # http://localhost:3200 — browser-only, data in localStorage
```

Reset the seeded data any time from the **Reset** button in the top bar.

## Run against the real backend

```bash
# Terminal 1 — the API on an in-process DynamoDB (dynalite), no AWS needed
cd packages/api
npm install
npm run dev:local          # API on http://localhost:3333, seeded

# Terminal 2 — the web app pointed at it
cd apps/web
VITE_API_URL=http://localhost:3333 VITE_LOCAL_AUTH=1 npm run dev
```

---

## Backend (for the dev team to take over)

`packages/api` is a working, tested [Hono](https://hono.dev) app over a DynamoDB
single-table design, packaged for AWS Lambda via [SST](https://sst.dev).

- **Data model & routes** — `src/types.ts`, `src/keys.ts`, `src/repo.ts`,
  `src/catalogue.ts` (validation), `src/index.ts` (routes).
- **Academic surface** — `/admin/academic/athletes`, `/mentors`, `/check-ins`
  (development plans), `/interventions`, and the public `/mentor-plan/:id`
  (token-gated, no auth). These are the routes this app uses; the package also
  carries the parent platform's other modules, which the dev team can remove.
- **To build server-side** — endpoints the demo mocks and `api.live.js` stubs:
  `GET /admin/academic/module-profiles` (shared class-times/assessment-dates
  store, keyed by course code) and public `POST /onboarding` (upserts an athlete
  and folds each module's detail into the profile store — powers auto-populate);
  `GET`/`PUT /admin/academic/settings` (per-tenant org config — see below).
- **No-password report link** — every ADP plan carries a `token`; the public
  route `#/report/:id?t=<token>` renders the completed plan read-only for the
  student and mentor (no auth), reusing the same `GET /mentor-plan/:id` handler.
  Mint the token when the plan is created (assigned *or* completed in-house), not
  only on assignment.
- **Gradebook** — `POST /admin/academic/athletes/:id/gradebook-link` mints a
  per-student token; public `GET`/`POST /gradebook/:id?t=<token>` read and write
  the student's marks (no auth). The 3-week "marks due" prompt is pure client
  logic in `academic-model.js` (`buildGradebook` / `assessmentStatus`,
  `MARK_READY_DAYS`). Marks are stored keyed by `module|label|date`.
- **Multi-tenant / scalable** — a Settings tab configures the organisation
  (institution, sport/code, programme name, squads, administrators) so the same
  platform serves any school or sporting code. In this demo it's one shared
  settings record; server-side, scope settings (and every row) per tenant and
  drive the admin allow-list off the `admins` list against your SSO.
- **Auth** — Cognito passwordless email OTP in production; a dev bypass
  (`x-dev-auth`) locally. Wire the production Cognito bearer in
  `apps/web/src/api.live.js` (`authHeaders`). The admin login screen
  (`apps/web/src/main.jsx`) is a stand-in — replace `DEMO_PASSWORD` with the real
  Cognito sign-in.
- **Tests** — `npm test` (node:test + dynalite) covers the academic and mentor
  flows, including the public completion round-trip.

### Deploy to AWS (af-south-1)

The package targets SST. To deploy, add an `sst.config.ts` (region `af-south-1`)
that wires an API + DynamoDB table + Cognito pool to `src/index.ts`, then:

```bash
cd packages/api
npx sst deploy --stage dev
```

Point the web build at the deployed API URL via `VITE_API_URL`.

---

## Hosting

- **Demo** — GitHub Actions (`.github/workflows/pages.yml`) builds the browser-only
  demo and publishes it to GitHub Pages on every push to `main`.
- **Private-repo note** — GitHub Pages on a private repo needs a paid GitHub plan.
  If the deploy fails on entitlement, either make the repo **public** (the demo
  carries no personal data — it's anonymised) or host the built `apps/web/dist/`
  on any static host (Netlify, S3, Cloudflare Pages).

## Data & privacy

- The hosted demo uses **synthetic** athletes only — no real student data leaves
  the browser (it lives in each visitor's `localStorage`).
- The backend seed (`packages/api/seed-data/school.json`) is likewise anonymised.
- For real use, the platform is **POPIA-aware**: consent is tracked, academic PII
  is treated as sensitive, and a tenant-erasure sweep removes athletes, mentors,
  plans, interventions and any live mentor-link tokens.

## Email

Assigning a plan produces a **copy-link** and a prefilled **mailto**. Automated
email delivery (AWS SES, af-south-1) is a small addition for the dev team on
deploy.
