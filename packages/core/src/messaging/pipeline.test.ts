import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { setAnthropicClient } from '../agent/runner.js';
import { FileStore, setStore } from '../db/index.js';
import { clinics, conversations, escalations, messages } from '../db/repos.js';
import { loadKnowledgeBaseFile } from '../kb/loader.js';
import { registerChannel } from './registry.js';
import { WebChatChannel } from './channels/webchat.js';
import { handleInbound, sendStaffReply } from './pipeline.js';
import type { Clinic, InboundMessage } from '../index.js';

/**
 * End-to-end pipeline tests with a stubbed model.
 *
 * These are the tests that matter most: they prove the safety rules are
 * enforced by the *pipeline*, not by the prompt. The stub is told to produce
 * unsafe text on purpose; the assertions are that it never reaches the patient.
 */

const kb = loadKnowledgeBaseFile('noor-riyadh', 'clinics');

let dir: string;
let clinic: Clinic;
let threadCounter = 0;

/** Minimal fake of the Messages API: returns whatever text the test queues. */
function stubModel(replies: string[]): void {
  const queue = [...replies];
  setAnthropicClient({
    messages: {
      create: async () => ({
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        model: 'stub',
        content: [{ type: 'text', text: queue.shift() ?? 'تمام' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    },
  } as unknown as Anthropic);
}

function inbound(text: string, threadId?: string): InboundMessage {
  const id = threadId ?? `web_test_${++threadCounter}`;
  return {
    channel: 'webchat',
    threadId: id,
    externalMessageId: `${id}:${Math.random().toString(36).slice(2)}`,
    text,
    sender: { externalId: id, displayName: null },
    receivedAt: new Date(),
  };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fo-pipe-'));
  setStore(new FileStore(join(dir, 'db.json')));
  registerChannel(new WebChatChannel());
  clinic = await clinics.create({
    slug: kb.clinic.slug,
    name: kb.clinic.name_en,
    timezone: kb.clinic.timezone,
    avg_ticket_sar: kb.clinic.avg_ticket_sar,
    retention_days: kb.clinic.retention_days,
    settings: {},
  });
});

beforeEach(() => {
  stubModel([]);
});

after(() => {
  setAnthropicClient(undefined);
  setStore(undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('emergency language bypasses the model entirely', async () => {
  let modelCalled = false;
  setAnthropicClient({
    messages: {
      create: async () => {
        modelCalled = true;
        throw new Error('the model must not be called on an emergency');
      },
    },
  } as unknown as Anthropic);

  const result = await handleInbound(clinic, inbound('عندي ألم شديد ما أقدر أتحمله وفيه نزيف'));

  assert.equal(result.status, 'emergency');
  assert.equal(modelCalled, false, 'the emergency path must not reach the model');
  assert.ok(result.reply?.includes(kb.clinic.emergency.ambulance_number));
  assert.ok(result.reply?.includes(kb.clinic.emergency.urgent_line));

  const open = await escalations.list(clinic.id, 'open');
  assert.equal(open.some((row) => row.reason === 'emergency_language'), true);
});

test('a safe reply is delivered as-is', async () => {
  stubModel(['هلا وغلا 🌿 دوامنا من الأحد إلى الخميس ٩ الصباح إلى ٩ بالليل، والجمعة إجازة.']);
  const result = await handleInbound(clinic, inbound('وش دوامكم؟'));
  assert.equal(result.status, 'replied');
  assert.ok(result.reply?.includes('دوامنا'));
});

test('a model reply containing medical advice never reaches the patient', async () => {
  stubModel(['اللي عندك التهاب لثة، خذ مضاد حيوي وبيروح خلال يومين.']);
  const result = await handleInbound(clinic, inbound('عندي انتفاخ باللثة'));

  assert.equal(result.status, 'escalated');
  assert.equal(result.reply, kb.agent.holding_reply_ar, 'the patient must get the holding reply, not the advice');
  assert.ok(!result.reply?.includes('مضاد حيوي'));

  const transcript = await messages.listForConversation(clinic.id, result.conversationId!);
  assert.equal(
    transcript.some((message) => message.body.includes('مضاد حيوي')),
    false,
    'the blocked draft must not be stored in the transcript either',
  );
});

test('a model reply quoting an unpublished price is blocked and escalated', async () => {
  stubModel(['أسوي لك التبييض بـ ١٢٥٠ ريال خصم خاص.']);
  const result = await handleInbound(clinic, inbound('فيه خصم على التبييض؟'));

  assert.equal(result.status, 'escalated');
  assert.equal(result.escalationReason, 'unpublished_price');
  assert.equal(result.reply, kb.agent.holding_reply_ar);
});

test('a model reply promising an outcome is blocked', async () => {
  stubModel(['نضمن لك نتيجة ١٠٠٪ والشعر يختفي نهائيًا.']);
  const result = await handleInbound(clinic, inbound('الليزر ينفع؟'));
  assert.equal(result.status, 'escalated');
  assert.equal(result.escalationReason, 'outcome_promise');
});

test('published prices pass through untouched', async () => {
  stubModel(['التبييض بالليزر ١٨٠٠ ريال والتنظيف ٣٥٠ ريال 🌿']);
  const result = await handleInbound(clinic, inbound('كم التبييض والتنظيف؟'));
  assert.equal(result.status, 'replied');
  assert.ok(result.reply?.includes('١٨٠٠'));
});

test('once a human takes over, the agent stops answering that thread', async () => {
  stubModel(['رد آلي ما المفروض ينرسل']);
  const first = await handleInbound(clinic, inbound('هلا', 'web_takeover_thread'));
  const conversationId = first.conversationId!;

  await sendStaffReply(clinic.id, conversationId, 'هلا والله، معك هند من العيادة.', 'hind');

  let modelCalled = false;
  setAnthropicClient({
    messages: {
      create: async () => {
        modelCalled = true;
        throw new Error('the agent must stay silent on a human-owned thread');
      },
    },
  } as unknown as Anthropic);

  const second = await handleInbound(clinic, inbound('طيب متى الموعد؟', 'web_takeover_thread'));
  assert.equal(second.status, 'handed_over');
  assert.equal(modelCalled, false);

  const conversation = await conversations.byId(clinic.id, conversationId);
  assert.equal(conversation?.owner, 'human');
  assert.equal(conversation?.taken_over_by, 'hind');
});

test('a webhook redelivery of the same message is ignored', async () => {
  stubModel(['تمام، أبشر.', 'رد ثاني ما المفروض يصير']);
  const message = inbound('أبي أحجز موعد', 'web_dupe_thread');

  const first = await handleInbound(clinic, message);
  const second = await handleInbound(clinic, message);

  assert.equal(first.status, 'replied');
  assert.equal(second.status, 'ignored');

  const transcript = await messages.listForConversation(clinic.id, first.conversationId!);
  assert.equal(transcript.filter((entry) => entry.author === 'patient').length, 1);
});

test('a model failure produces the holding reply rather than silence', async () => {
  setAnthropicClient({
    messages: { create: async () => { throw new Error('upstream 500'); } },
  } as unknown as Anthropic);

  const result = await handleInbound(clinic, inbound('وين موقعكم؟'));
  assert.equal(result.status, 'escalated');
  assert.equal(result.escalationReason, 'agent_error');
  assert.equal(result.reply, kb.agent.holding_reply_ar);
});

test('an English patient gets the English holding reply', async () => {
  stubModel(['You should take an antibiotic for that infection.']);
  const result = await handleInbound(clinic, inbound('I have an infection, what should I take?'));
  assert.equal(result.status, 'escalated');
  assert.equal(result.reply, kb.agent.holding_reply_en);
});

test('symptom language flags the thread even when the reply is safe', async () => {
  stubModel(['أقدر أحجز لك موعد كشف مع الدكتور، متى يناسبك؟']);
  const result = await handleInbound(clinic, inbound('عندي ألم بسيط في ضرسي وودي أعرف وش السبب'));

  assert.equal(result.status, 'escalated', 'reply is safe but the thread must still reach a human');
  assert.ok(result.reply?.includes('موعد'));

  const rows = await escalations.forConversation(clinic.id, result.conversationId!);
  assert.equal(rows.some((row) => row.reason === 'symptom_description'), true);
});
