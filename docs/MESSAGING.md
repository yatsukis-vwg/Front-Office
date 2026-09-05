# The messaging abstraction

## Why it exists

The clinic needs WhatsApp. WhatsApp Business API needs Meta Business
verification, which takes weeks. So the product ships on Telegram and a web chat
widget, and the messaging layer is built so that adding WhatsApp later is one
file plus an environment variable — not a rewrite.

The rule the codebase holds to: **nothing above `messaging/channels/` knows that
Telegram exists.** The agent, the safety checks, booking, reminders, the
dashboard and the metrics all deal in two types.

---

## The contract

[`packages/core/src/messaging/types.ts`](../packages/core/src/messaging/types.ts)

```ts
interface InboundMessage {
  channel: ChannelId;            // 'telegram' | 'webchat' | 'whatsapp'
  threadId: string;              // channel-native conversation key
  externalMessageId: string;     // for webhook-redelivery idempotency
  text: string;
  sender: { externalId: string; displayName?: string | null; phone?: string | null };
  receivedAt: Date;
}

interface OutboundMessage {
  text: string;
  quickReplies?: string[];       // Telegram keyboard, widget chips, ignored elsewhere
  kind?: 'reply' | 'reminder' | 'confirmation' | 'system';
}

interface ChannelAdapter {
  readonly id: ChannelId;
  readonly displayName: string;

  verify(request, credentials): boolean;                      // is this really from the platform?
  handleVerificationChallenge?(request, credentials): string | null;  // Meta's hub.challenge
  parseInbound(request): InboundMessage[];                    // wire format → normalised
  send(threadId, message, credentials): Promise<SendResult>;  // must not throw
  indicateTyping?(threadId, credentials): Promise<void>;
}
```

Adapters are **stateless translators**. They never touch the database, never
call the agent, and never make a safety decision. That is what keeps them
cheap to add and impossible to get subtly wrong.

Credentials come from the clinic's `settings` column via
`credentialsForClinic(clinic)`, so two clinics on one deployment can run two
different bots.

---

## The pipeline every channel feeds

[`packages/core/src/messaging/pipeline.ts`](../packages/core/src/messaging/pipeline.ts)

```
adapter.parseInbound()
  └─▶ handleInbound(clinic, inbound)
        1. idempotency check (webhook redeliveries are dropped)
        2. resolve patient + conversation, store the inbound message
        3. inbound tripwires
             emergency? → clinic's emergency directive, escalate, STOP
        4. human owns this thread? → store only, agent stays silent, STOP
        5. run the agent (Claude + booking tools)
        6. PRE-SEND SAFETY CHECK on the draft
             blocked? → warm holding reply + escalation, STOP
        7. adapter.send()
```

Steps 3 and 6 are the reason a channel adapter must not be allowed to send
anything itself. Every outbound message — agent replies, holding replies,
emergency directives, staff replies, reminders — goes through `deliver()`, which
persists it and then calls the adapter. That is why the dashboard transcript is
always the complete record of what the patient actually received.

---

## The three adapters

| Adapter | File | State |
|---|---|---|
| Telegram | `channels/telegram.ts` | **Live.** Verifies `X-Telegram-Bot-Api-Secret-Token`, handles messages, edited messages, callback queries and shared contact cards. |
| Web chat | `channels/webchat.ts` | **Live.** The widget polls, so `send()` persists and buffers; the poll endpoint drains the buffer. |
| WhatsApp | `channels/whatsapp.ts` | **Implemented, not registered.** Full Cloud API request/response shapes, HMAC signature verification, `hub.challenge` handshake. |

---

## Turning on WhatsApp

Nothing above the adapter changes. Concretely:

### 1. Meta side

- Complete Meta Business verification for the clinic.
- Create a WhatsApp Business app, add a phone number, and get:
  `WHATSAPP_ACCESS_TOKEN` (a permanent system-user token, not a 24h one),
  `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`.
- Choose any string for `WHATSAPP_VERIFY_TOKEN`.

### 2. Environment

```bash
ENABLE_WHATSAPP=true
WHATSAPP_ACCESS_TOKEN=EAAG...
WHATSAPP_PHONE_NUMBER_ID=1234567890
WHATSAPP_APP_SECRET=...
WHATSAPP_VERIFY_TOKEN=...
```

`apps/api/src/context.ts` registers the adapter when the flag is on. The generic
webhook route already serves `/webhooks/whatsapp/:clinicSlug` for both the GET
handshake and POST deliveries — no route to add.

### 3. Meta webhook configuration

Callback URL: `https://your-api-host/webhooks/whatsapp/<clinic-slug>`
Verify token: the value above. Subscribe to the `messages` field.

### 4. What you get for free

Because the abstraction is real, WhatsApp inherits without any further work:

- the Arabic agent, its prompt and its booking tools
- every safety rule, including the emergency tripwires
- the escalation queue, human takeover and staff replies
- appointments, reminders and the retention purge
- the dashboard, transcripts, search and the metrics breakdown by channel
- **verified phone numbers**: WhatsApp gives a real E.164 number on every
  message, so the pipeline links a returning patient to their existing record
  and the agent never has to ask for a number.

### 5. The two things that genuinely need work

Called out honestly rather than buried:

1. **The 24-hour customer-service window.** Outside it, Meta only accepts
   pre-approved *template* messages. Free-form replies inside an active
   conversation use the existing `send()` path, but the **24h and 2h reminders
   will need an approved template** and a `sendTemplate()` branch in the
   adapter. This is a Meta policy constraint, not an architectural one — the
   change is contained entirely inside `channels/whatsapp.ts`.
2. **Rate limits and messaging tiers.** New numbers start at a low daily
   conversation cap that scales with quality rating. Worth knowing before a
   launch campaign.

---

## Adding any other channel

Instagram DM, SMS via Unifonic, a native iOS app — the same three steps:

1. Write `channels/<name>.ts` implementing `ChannelAdapter`.
2. Add the id to the `ChannelId` union in `types.ts` (and to the `channel` check
   constraint in the migration).
3. `registerChannel(new YourChannel())` in `apps/api/src/context.ts`.

Add the id to the `SUPPORTED` array in `apps/api/src/routes/webhooks.ts` and the
generic webhook route serves it. Nothing else in the codebase needs to change.
