# Onboarding a new clinic

**Onboarding is editing one file.** No code changes, no migration, no redeploy
of business logic. This document walks that file field by field.

```bash
cp clinics/noor-riyadh.yaml clinics/my-clinic.yaml
$EDITOR clinics/my-clinic.yaml
npm run kb:validate -- my-clinic
```

Then either restart the API, or call `POST /api/admin/clinics/sync` — the API
creates the database row for any clinic file it does not already know about.

Set `DEFAULT_CLINIC_SLUG=my-clinic` if it is the only clinic on the deployment.

---

## Before you start: collect this from the clinic

A 30-minute call gets you everything:

- [ ] Trading name in Arabic and English, address, Google Maps link, parking
- [ ] Opening hours per day, and the break, if any
- [ ] Phone, WhatsApp, Instagram
- [ ] **The published price list** — this is the one that matters. Get the exact
      figures the clinic is willing to state over chat, and whether each is a
      fixed price, a "from" price, or a range.
- [ ] Doctors: name, speciality, languages, and each one's own working days and
      hours
- [ ] Insurers accepted, direct billing or reimbursement, and what is not covered
- [ ] Cancellation, late, deposit and no-show policies, with the exact fees
- [ ] Pre- and post-appointment instructions per treatment type
- [ ] The 20–30 questions reception answers every day, **in the words patients
      actually use**
- [ ] The clinic's emergency line, and the nearest ER

---

## The file, section by section

### `clinic` — identity, hours, emergency contacts

```yaml
clinic:
  slug: my-clinic              # must match the filename
  name_ar: "عيادات ..."
  name_en: "..."
  timezone: "Asia/Riyadh"
  avg_ticket_sar: 1150         # drives the revenue figure on the metrics page
  retention_days: 730          # PDPL retention; data older than this is purged
  address:
    ar / en / district_ar / city_ar
    map_url: "https://maps.google.com/?q=..."
    landmark_ar: "مقابل ..."   # patients navigate by landmark, not by street
    parking_ar: "..."
  contact:
    phone / whatsapp / email / instagram / website
  hours:
    - days: [0, 1, 2, 3, 4]    # 0 = Sunday … 6 = Saturday
      open: "09:00"
      close: "21:00"
      breaks:
        - { start: "13:00", end: "16:00" }
    - days: [6]
      open: "12:00"
      close: "21:00"
      breaks: []
  holidays: ["2026-09-23"]     # no slots offered on these dates
  emergency:
    ambulance_number: "997"
    urgent_line: "+966..."
    nearest_er_ar: "..."
```

**A day with no `hours` entry is closed.** In the example, Friday (5) is absent,
so the clinic is closed on Fridays — and the availability engine, the metrics
page and the "are we open right now?" check all agree without being told twice.

The emergency numbers are substituted into the emergency directive via
`{{ambulance}}`, `{{urgent_line}}` and `{{nearest_er}}`, so the numbers a patient
in trouble is told to call can never drift out of sync with the clinic's actual
contact details.

### `services` — the published price list

This is the highest-stakes section. **The agent may not quote any figure that is
not derived from here** (or from a fee the clinic wrote into its own policy text
or FAQ answers). Anything else is blocked before sending and the conversation is
escalated.

```yaml
- id: zoom_whitening          # stable; appointments reference it
  name_ar: "تبييض الأسنان بالليزر (زوم)"
  name_en: "Zoom laser whitening"
  category_ar: "أسنان"
  description_ar: "..."
  duration_min: 75            # how long the chair is occupied
  buffer_min: 15              # turnaround reserved after the appointment
  price:
    type: fixed               # fixed | from | range
    amount: 1800
    max_amount: 2400          # required when type is `range`
    currency: SAR
    unit_ar: "للسن الواحد"     # shown with the price, e.g. "2200 ريال للسن الواحد"
  doctor_ids: [dr_reem]       # who can perform it
  bookable: true
  requires_consultation: true # the agent offers a consultation first
  aliases: ["تبييض", "زوم", "whitening"]
```

Notes from practice:

- **`aliases` earn their keep.** Patients type "زوم", "ابتسامة هوليوود", "فلر
  شفايف". Every phrasing you add is a booking that does not need a clarifying
  question.
- **Prices the clinic will not state over chat**: set `price: null`. The agent
  then says the price is set after an assessment and offers a consultation,
  rather than inventing a number.
- **`buffer_min`** is applied on both sides when checking conflicts, so
  back-to-back bookings always leave turnaround time.

### `doctors`

```yaml
- id: dr_khalid
  name_ar: "د. خالد الدوسري"
  name_en: "Dr. Khalid Al-Dosari"
  title_ar: "استشاري"
  speciality_ar: "جراحة فم وزراعة أسنان"
  gender: male                 # patients ask; the FAQ can answer from this
  languages: ["ar", "en"]
  bio_ar: "..."
  working_hours:               # overrides clinic hours for this doctor
    - days: [0, 1, 2, 3, 4]
      open: "16:00"
      close: "21:00"
      breaks: []
  days_off: ["2026-09-28"]
```

Leave `working_hours` empty and the doctor follows clinic hours. When set, the
doctor's window is **intersected** with the clinic's — a doctor cannot be
bookable while the clinic is shut.

### `insurance`, `instructions`, `policies`

Straightforward, but two things pay off:

- Put the **exact fee amounts** in `policies` (`cancellation_ar`, `no_show_ar`,
  `deposit_ar`). The safety layer treats numbers the clinic wrote into its own
  policy text as published, so the agent can quote the late-cancellation fee
  without tripping the price guard.
- `instructions.pre` / `.post` take `service_ids: ["*"]` for rules that apply to
  everything, or specific ids for treatment-specific prep.

### `faqs` — 30+ answers, in the words patients use

```yaml
- id: faq_parking
  q_ar: "فيه مواقف؟"
  a_ar: "إيه فيه مواقف مجانية للمراجعين في قبو المبنى B1، والدخول من البوابة الخلفية."
  q_en: "Is there parking?"    # optional
  a_en: "..."                  # optional
  tags: ["parking", "مواقف"]
```

Write `a_ar` as the answer you want the patient to receive — the agent uses it
almost verbatim. Write `q_ar` the way a patient would actually type it
("وش دوامكم؟", not "ما هي ساعات العمل؟").

Clinic staff can edit these later in the console's **Knowledge base** page
without touching the file.

### `agent` — the voice

```yaml
agent:
  persona_name_ar: "نورة"
  greeting_ar: "هلا وغلا! معك نورة من ..."
  holding_reply_ar: "..."      # sent whenever the safety layer blocks a message
  emergency_reply_ar: "⚠️ ... {{ambulance}} ... {{urgent_line}}"
  style_notes_ar:
    - "استخدم كلمات أهل الرياض: هلا، أبشر، تم، وش، ليه، كذا."
    - "لا تستخدم عبارات فصحى ثقيلة مثل: يسعدنا أن نبلغكم."
```

The default register is **Najdi colloquial** — it should read like a receptionist
texting, not like a press release. `style_notes_ar` is the per-clinic dial: a
Jeddah clinic would swap in Hijazi vocabulary here, and a high-end aesthetics
clinic might want a more formal register. Nothing in the code assumes Najdi;
it is all in this list and the base prompt.

---

## Wiring the channels

**Telegram** — create a bot with @BotFather, then either set `TELEGRAM_BOT_TOKEN`
(single clinic) or the per-clinic form for multi-tenant deployments. For slug
`my-clinic`, that is `TELEGRAM_BOT_TOKEN_MY_CLINIC` and
`TELEGRAM_WEBHOOK_SECRET_MY_CLINIC`. Then:

```bash
npm run telegram:register -- https://your-api-host my-clinic
```

**Web widget** — one script tag on the clinic's site with
`data-clinic="my-clinic"`. See the README.

---

## Validating and going live

```bash
npm run kb:validate -- my-clinic
```

The validator checks the schema **and** the cross-references the schema cannot
express: services pointing at unknown doctors, instructions pointing at unknown
services, `range` prices missing `max_amount`, closing times before opening
times, duplicate ids, and an invalid timezone. A clinic file that fails
validation is never loaded — the API logs the error and skips that clinic rather
than starting the agent on a broken knowledge base.

A five-minute pre-launch check that catches most real problems:

1. `npm run kb:validate -- my-clinic` — clean.
2. Ask the bot for the three most-requested prices. Each answer must match the
   price list exactly.
3. Book, reschedule and cancel one appointment end to end.
4. Ask a question with symptoms in it. You should get the holding reply and see
   the thread appear in the escalation queue.
5. Send `"عندي ألم شديد"`. You should get the emergency directive with the right
   numbers, immediately.
6. Ask for a slot on a day the clinic is closed. The agent should offer the next
   real opening, not invent one.

---

## Running several clinics on one deployment

Drop one YAML file per clinic in `clinics/`. Every table is keyed by
`clinic_id`, every repository query is scoped by it, and Postgres RLS enforces
it independently. Each clinic gets its own Telegram bot via the per-clinic
environment variables, and the widget selects a clinic with `data-clinic`.

The console currently shows one clinic at a time, selected by
`DEFAULT_CLINIC_SLUG`; the admin API already accepts `?clinic=<slug>` on every
route, so a clinic switcher in the console is a UI change, not a backend one.
