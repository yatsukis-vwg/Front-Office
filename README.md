# Front Office — AI receptionist for Saudi clinics

An Arabic-first AI receptionist for medical and aesthetic clinics in Saudi Arabia.
It answers patient messages in Saudi colloquial Arabic, answers questions from a
clinic-specific knowledge base, and books, reschedules and cancels appointments
against real availability.

It runs today on **Telegram** and an **embeddable web chat widget**.
**WhatsApp Business API is implemented but switched off** — it needs Meta
Business verification. Turning it on is an environment variable, not a rewrite;
see [docs/MESSAGING.md](docs/MESSAGING.md).

```
┌── Telegram ──┐
│              │   ┌───────────────────────────────────────────────┐
├── Web widget ┼──▶│ ChannelAdapter → ingest pipeline              │
│              │   │   ├─ inbound tripwires (emergency / symptoms) │
└── WhatsApp ──┘   │   ├─ agent (Claude + booking tools)           │
    (wired, off)   │   ├─ PRE-SEND SAFETY CHECK  ← the hard gate   │
                   │   └─ channel.send()                           │
                   └───────────────┬───────────────────────────────┘
                                   │
              knowledge base (YAML) ├─ Postgres / Supabase (encrypted)
                                   └─ Next.js admin console
```

---

## Quick start — a running demo in two minutes

Requires Node 20+. No database, no API key needed for the first step.

```bash
npm install
cp .env.example .env      # fill in ANTHROPIC_API_KEY to make the agent live
npm run seed              # ~57 Arabic conversations, 30 appointments
npm run dev               # API on :8080
npm run dev:dashboard     # console on :3000  (in a second terminal)
```

Then open:

| What | Where |
|---|---|
| **Admin console** | http://localhost:3000 — password from `DASHBOARD_PASSWORD` |
| **Widget demo page** | http://localhost:8080/widget/demo.html |
| **API health** | http://localhost:8080/health |

The seed data is deliberately shaped like real clinic traffic — bookings
weighted towards evenings and after midnight, a handful of escalations, a few
threads a human took over — so the metrics page is worth looking at on open.

Without `ANTHROPIC_API_KEY` everything renders and the seeded history is
browsable; live replies need the key.

---

## The five things that matter

### 1. The knowledge base is the whole product

One file per clinic: [`clinics/noor-riyadh.yaml`](clinics/noor-riyadh.yaml).
Clinic details, hours, parking, services and their **published prices**, doctors
and their individual schedules, insurance, pre/post-appointment instructions,
35 Arabic FAQ answers, and the agent's own voice.

Onboarding a new clinic means writing that one file. Nothing else changes — no
code, no migration, no redeploy. See [docs/ONBOARDING.md](docs/ONBOARDING.md).

```bash
cp clinics/noor-riyadh.yaml clinics/my-clinic.yaml
$EDITOR clinics/my-clinic.yaml
npm run kb:validate            # schema + cross-references
```

### 2. Safety is enforced in code, not in the prompt

The system prompt asks the model to behave. `packages/core/src/safety/` is what
guarantees it. **Every outgoing message** passes `checkOutgoing()` before it
reaches a channel — there is no code path from the model to a patient that skips
it ([`messaging/pipeline.ts`](packages/core/src/messaging/pipeline.ts)).

| Rule | Enforcement |
|---|---|
| No medical advice, diagnosis or symptom interpretation | Pattern rules over the outgoing draft, Arabic + English |
| No price outside the published list | Every money figure in the draft must match the clinic's published prices or the fees it wrote into its own policy text |
| No statement about whether a treatment suits an individual | Suitability rules ("مناسب لك", "in your case", "you're a candidate") |
| No promised outcome | Guarantee rules ("نضمن", "١٠٠٪", "guaranteed results", "permanently") |

When a draft trips any rule, the patient gets the clinic's own **warm holding
reply** instead, and the conversation lands in the escalation queue tagged with
the rule that fired. The blocked text is never sent and never stored.

**Emergency language** is handled before the model is called at all. `"ألم شديد"`,
`"نزيف"`, `"طوارئ"`, `"chest pain"`, `"bleeding"` and friends trigger an immediate
directive built from the clinic's structured contact details — ambulance number,
the clinic's urgent line, the nearest ER — and page a human. The model is never
asked to handle an emergency.

Proof, not promises:

```bash
npm test    # 44 tests
```

The pipeline tests deliberately stub the model to return unsafe text
(`packages/core/src/messaging/pipeline.test.ts`) and assert it never reaches the
patient.

### 3. Real availability, no double bookings

Slots come from the knowledge base — clinic hours, per-doctor schedules, the
afternoon break, days off, holidays, service durations and turnaround buffers —
minus what is already booked. Double-booking is blocked three times over:
availability never offers a taken slot, the booking service re-checks inside a
lock immediately before insert, and Postgres holds an exclusion constraint on
`(doctor_id, time range)` for booked rows. There is a test that fires five
concurrent bookings at one slot and asserts exactly one wins.

### 4. Human takeover

Any staff member can open a conversation in the console and reply. That flips
the thread's owner to `human` and the agent goes silent on it until it is handed
back. Staff messages go out on whatever channel the patient is using.

### 5. The metrics page is the sales tool

Headline number: **bookings captured outside working hours** — the enquiries a
clinic loses today because nobody is at the desk at 11pm. Plus messages handled,
bookings, average response time, escalation rate, and estimated captured revenue
(bookings × the clinic's configured average ticket).

---

## Telegram bot registration

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Put it in `.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456789:AA...
   TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 24)
   ```
3. Expose the API publicly (`ngrok http 8080` locally, or your deployed URL).
4. Register the webhook:
   ```bash
   npm run telegram:register -- https://your-host.example.com
   ```
   That points Telegram at `POST /webhooks/telegram/<clinic-slug>` and installs
   the secret token, which the adapter checks on every inbound update.
5. Message your bot. It should answer in Arabic.

Optional polish in BotFather: `/setdescription`, `/setabouttext`,
`/setuserpic`, and `/setcommands` with `start - ابدأ المحادثة`.

**Several clinics from one deployment?** Give each its own bot and set
per-clinic variables using the slug in upper snake case — for `noor-riyadh`:
`TELEGRAM_BOT_TOKEN_NOOR_RIYADH`, `TELEGRAM_WEBHOOK_SECRET_NOOR_RIYADH`.

---

## Embedding the web chat widget

One tag on any page on the clinic's site:

```html
<script src="https://your-api-host/widget/widget.js"
        data-api="https://your-api-host"
        data-clinic="noor-riyadh"
        data-locale="ar"
        data-accent="#0f766e"
        data-title="عيادات نور الرياض"
        defer></script>
```

No dependencies, no cookies, no build step. Everything is inside a shadow root,
so the clinic's CSS cannot break the widget and the widget cannot break the
site. `data-position`, `data-auto-open` and a small `window.FrontOfficeWidget`
API (`.open()`, `.close()`, `.send(text)`) let a clinic wire it to their own CTA.

---

## Environment variables

Full list with comments in [`.env.example`](.env.example). The ones that matter:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | The agent. Without it the console works but no replies are generated. |
| `ANTHROPIC_MODEL` | Default `claude-opus-5`. |
| `ANTHROPIC_EFFORT` | `low` / `medium` / `high`. `medium` is the default; `low` is noticeably faster and fine for FAQ-heavy traffic. |
| `STORE_DRIVER` | `file` for the zero-setup demo, `supabase` for anything real. Production refuses to start on `file`. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Postgres. |
| `DATA_ENCRYPTION_KEY` | **base64, 32 bytes** — `openssl rand -base64 32`. Encrypts patient data at rest. Lose it and the data is unreadable. |
| `PHONE_HASH_SALT` | Salt for the phone lookup hash. Set once; changing it orphans existing patient lookups. |
| `ADMIN_API_KEY` | Guards the admin API. The dashboard holds it server-side only. |
| `DASHBOARD_PASSWORD` | Console sign-in. |
| `CRON_SECRET` | Guards `/jobs/tick` and `/jobs/nightly`. |
| `DEFAULT_CLINIC_SLUG` | Which clinic file the widget and console use by default. |
| `ENABLE_INPROCESS_JOBS` | `true` runs reminders and the retention purge inside the API process. Set `false` when a platform scheduler drives the job endpoints. |
| `ENABLE_WHATSAPP` | `false`. Flip when Meta verification lands — see docs/MESSAGING.md. |

Production start-up refuses to boot if `DATA_ENCRYPTION_KEY`, `PHONE_HASH_SALT`,
`ADMIN_API_KEY` or `CRON_SECRET` are still on their development defaults.

---

## Deployment

The API and the console deploy independently. The console only ever talks to the
API over HTTP, so they can live on different platforms.

### API → Railway / Render / Fly

```bash
npm run build          # builds @front-office/core and @front-office/api
npm start -w @front-office/api
```

- Start command: `node apps/api/dist/server.js`
- Health check: `GET /health`
- Set every variable from `.env.example`, with `STORE_DRIVER=supabase`.
- Leave `ENABLE_INPROCESS_JOBS=true` on a single instance; set it to `false` and
  add platform cron entries when you scale past one:

  ```
  */5 * * * *  curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" $API/jobs/tick
  15 2 * * *   curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" $API/jobs/nightly
  ```

### API → Vercel

`apps/api/src/server.ts` exports the Express `app`, so it runs behind a single
serverless function. On Vercel, set `ENABLE_INPROCESS_JOBS=false` and use Vercel
Cron for the two job endpoints — serverless instances do not stay alive to run
timers.

### Console → Vercel

Root directory `apps/dashboard`, framework Next.js, and set `API_BASE_URL`,
`ADMIN_API_KEY`, `DASHBOARD_PASSWORD` and `DEFAULT_CLINIC_SLUG`.

### Database

```bash
supabase db push
# or: psql "$DATABASE_URL" -f supabase/migrations/0001_init.sql
```

The migration creates the schema, the double-booking exclusion constraint, the
advisory-lock functions and per-clinic RLS policies.

---

## Repository layout

```
clinics/                        one YAML file per clinic — the onboarding surface
packages/core/src/
  agent/          prompt construction, tool definitions, the tool-use loop
  safety/         tripwires, the pre-send check, language detection
  scheduling/     availability engine, booking / reschedule / cancel
  messaging/      ChannelAdapter contract, Telegram, web chat, WhatsApp, pipeline
  kb/             knowledge base schema, validator, loader
  db/             Store interface + file and Supabase implementations, repositories
  crypto/         AES-256-GCM encryption, phone hashing, booking references
  jobs/           reminders, PDPL retention purge, export and erasure
  metrics/        the numbers behind the metrics page
apps/api/                       Express: webhooks, chat API, admin API, jobs
apps/dashboard/                 Next.js admin console
widget/                         embeddable chat widget + demo page
supabase/migrations/            Postgres schema, RLS, exclusion constraint
scripts/                        seed, KB validation, Telegram registration
docs/                           messaging abstraction, onboarding, data protection
```

---

## Commands

| Command | Does |
|---|---|
| `npm run dev` | API with reload on :8080 |
| `npm run dev:dashboard` | Console on :3000 |
| `npm run seed` | Reset and load the demo dataset |
| `npm run seed -- --keep` | Add demo data without wiping |
| `npm test` | 44 unit and integration tests |
| `npm run typecheck` | Type-check core + API |
| `npm run kb:validate` | Validate every clinic file |
| `npm run telegram:register -- <url>` | Point Telegram at your webhook |
| `npm run build` | Build core + API for deployment |

---

## Documentation

- **[docs/MESSAGING.md](docs/MESSAGING.md)** — the channel abstraction, and
  exactly what turning on WhatsApp involves.
- **[docs/ONBOARDING.md](docs/ONBOARDING.md)** — onboarding a new clinic,
  field by field.
- **[docs/SECURITY.md](docs/SECURITY.md)** — PDPL: encryption, retention,
  audit logging, per-clinic isolation, export and erasure, and the gaps that
  remain before real patient data.
