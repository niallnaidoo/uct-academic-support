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

- **Dashboard** — squad RAG distribution, immediate-attention set, faculty
  analysis, mentor follow-ups, and a squad-wide **radar** across the four
  development areas pooled from every plan.
- **Athletes** — roster with filter chips; each athlete opens to a live academic
  tracker, a **Mentorship** card (assigned mentor, last seen, next session), and
  their development-plan **radar**.
- **Academic tracker** — capture attendance, assignments, semester average and
  faculty-warning status; risk (Green/Amber/Red/Critical) is computed with the
  tracker's exact formula.
- **Academic development plans** — assign a plan to a **mentor** and send them a
  link; track who's been done (awaiting / completed), the mentor, term, overall
  rating and next session. Open a completed plan for its summary.
- **The plan itself** — a module **screener** (type a UCT code and the title,
  convener, credits and an auto-assigned difficulty fill in from the **3,272**
  courses mined from the 2026 faculty handbooks; easy modules screen clear), then
  four development areas rated 1–5 with tailored per-category descriptors, a
  **question bank** to draw the student out, and an **intervention plan** (tutor,
  SI, alumni mentor, referral, leave of absence…) logged to a register.
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
- **Auth** — Cognito passwordless email OTP in production; a dev bypass
  (`x-dev-auth`) locally. Wire the production Cognito bearer in
  `apps/web/src/api.live.js` (`authHeaders`).
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
