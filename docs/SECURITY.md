# Data protection

Saudi PDPL treats health data as a **sensitive category**. This document
describes what the system does about that, and — just as importantly — what it
does not yet do.

---

## What is treated as sensitive

Everything a patient sends, and everything the clinic stores about them:

| Data | Where it lives | Protection |
|---|---|---|
| Patient name | `patients.name_enc` | AES-256-GCM |
| Phone number | `patients.phone_enc` | AES-256-GCM |
| Phone lookup key | `patients.phone_hash` | Salted HMAC-SHA256, not reversible |
| Message bodies | `messages.body_enc` | AES-256-GCM |
| Appointment notes | `appointments.notes_enc` | AES-256-GCM |

Everything else — service ids, doctor ids, timestamps, booking references,
counts — is operational metadata and is stored in the clear.

## Encryption at rest

`packages/core/src/crypto/encryption.ts`. AES-256-GCM with a random 96-bit IV
per value, stored as `v1:<iv>:<tag>:<ciphertext>`, all base64. The version
prefix exists so a future key rotation can read `v1` rows while writing `v2`.

The key is `DATA_ENCRYPTION_KEY` — base64, exactly 32 bytes
(`openssl rand -base64 32`). Postgres never sees plaintext, so **a database dump
is not a patient data breach**. The corollary: lose the key and the data is
gone. Store it in the platform's secret manager, not in the repository.

Production start-up refuses to boot if the key is still the development default.

### The deliberate trade-off: search

Because message bodies are ciphertext, there is no server-side index to search.
Transcript search in the console fetches candidate rows and decrypts them in the
API process. That is slower than a Postgres full-text index and it is the right
call: searchable-encryption schemes leak far more than they are worth at a
single clinic's message volume. If this ever needs to scale, the answer is a
separate encrypted search index with its own key — not plaintext bodies.

## Phone numbers without storing phone numbers

Finding "the patient with this number" without decrypting every row is done with
a deterministic salted HMAC (`PHONE_HASH_SALT`) over the E.164-normalised
number. The hash is a lookup key only — it cannot be reversed, and the salt is
not derivable from the database. Set the salt once: changing it orphans every
existing patient lookup.

Normalisation handles the formats Saudi patients actually type: `0501234567`,
`501234567`, `+966501234567`, `00966...`, and Arabic-Indic digits.

## Per-clinic isolation

Enforced in three independent places, on purpose:

1. **Repository layer** — every method takes `clinicId` first and adds it to the
   filter set. There is no query in the codebase that reaches the store without
   it.
2. **Admin API** — the clinic is resolved once per request from the
   authenticated context, and handlers read it from `res.locals`, never from
   user-supplied body fields.
3. **Postgres RLS** — every table has a policy restricting `authenticated` to
   rows matching the `clinic_id` claim in the JWT. The API uses the service role
   and bypasses RLS by design; the policies protect every *other* client — the
   anon key, an analytics tool, a future staff app.

## Never logging message content

`packages/core/src/logger.ts` emits structured JSON and **drops** a fixed set of
keys rather than truncating them: `body`, `text`, `message`, `content`,
`transcript`, `name`, `phone`, `notes`, `reply`, `draft`, `answer`, `question`.
Anything matching `/token|secret|key$|password|authorization/` is replaced with
`[secret]`. Logs carry identifiers — clinic id, conversation id, rule labels,
counts — and nothing a person could read as a patient's words.

The escalation queue follows the same rule: `escalations.detail` holds the rule
label that fired and a short evidence fragment for staff triage, never a copy of
the message.

## Audit log

Every read *and* write of patient data writes an `audit_log` row: who, what,
which entity, when. That includes listing conversations, opening a transcript,
listing patients, exporting a record, erasing a record, editing the knowledge
base, and every appointment change.

`meta` carries identifiers and counts only. The audit log is retained for twice
the clinic's `retention_days`, because it holds no content of its own.

Visible in the console; readable via `GET /api/admin/audit`.

## Retention and auto-purge

Each clinic sets `retention_days` in its knowledge base file (default 730). The
nightly job (`/jobs/nightly`, or the in-process scheduler):

- deletes messages and escalations for conversations with no activity inside the
  window, then the conversations themselves;
- anonymises patients with no activity in the window — name, phone and phone
  hash are cleared and `deleted_at` is set, leaving a tombstone so appointment
  history stays referentially intact;
- **skips any patient with a future appointment**, so a purge can never orphan a
  booking;
- purges audit entries older than twice the window;
- records the purge in the audit log.

## Data subject rights

| Right | Endpoint | Console |
|---|---|---|
| Access / portability | `GET /api/admin/patients/:id/export` | "Export record (PDPL)" on the conversation page |
| Erasure | `DELETE /api/admin/patients/:id` | Same page |

The export is a single JSON document: the patient record, every appointment, and
every transcript, decrypted. Erasure deletes message bodies and conversations
outright, clears appointment notes, cancels pending reminders, and anonymises
the patient row. Both are audited.

## Transport and access control

- The admin API is behind `ADMIN_API_KEY`, compared in constant time.
- The console holds that key **server-side only**. Client components call
  `/api/proxy/*`, a Next.js route handler that re-signs the request. The key
  never reaches a browser.
- Job endpoints are behind `CRON_SECRET`.
- Telegram webhooks are verified against the secret token Telegram echoes back;
  WhatsApp webhooks are verified against the app-secret HMAC signature.
- Session cookies are `httpOnly`, `sameSite=lax`, and `secure` in production.
- The chat API is rate-limited per session.

---

## Known gaps — read this before real patient data

Stated plainly rather than buried, because these are the things that would
matter in a real deployment:

1. **The console has one shared password, not per-user accounts.** The audit log
   records the name typed at sign-in, which is a convention, not an
   authentication. Before real patient data: SSO or per-user credentials, so the
   audit log is evidence rather than a note.
2. **The encryption key is a single static key.** There is a version prefix
   ready for rotation but no rotation tooling, and no envelope encryption with a
   KMS. For a production clinic, wrap the data key with AWS KMS / GCP KMS and
   rotate on a schedule.
3. **Rate limiting is in-process.** Fine on one instance; move it to Redis or
   the platform edge before scaling out.
4. **`STORE_DRIVER=file` is development only.** That store has no access control
   of its own beyond file permissions, and on a serverless host its directory is
   read-only and ephemeral. Every entry point rejects it in production —
   `assertProductionSafety()` runs inside `createApp()`, so both the
   long-running server and the serverless function refuse to start rather than
   fail later, and the same check catches development defaults left in
   `DATA_ENCRYPTION_KEY`, `PHONE_HASH_SALT`, `ADMIN_API_KEY` and `CRON_SECRET`.
   It is covered by tests in `packages/core/src/config.test.ts`, because it is
   the last thing standing between a careless deploy and patient records
   encrypted with a key published in `.env.example`.
5. **No data residency guarantee.** PDPL has requirements around cross-border
   transfer of personal data. Both the database region and the LLM inference
   region are deployment decisions this codebase does not make for you — pick
   them deliberately, and note that message content is sent to the Anthropic API
   for the agent to work at all. That last point should be in the clinic's
   privacy notice and, depending on the clinic's legal advice, in its patient
   consent flow.
6. **Backups are the platform's.** Whatever backs up Postgres holds the same
   ciphertext, which is good — but the retention purge does not reach into
   backups. Backup retention needs to be set to match the clinic's policy.
