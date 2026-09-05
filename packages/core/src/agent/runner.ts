import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { KnowledgeBase } from '../kb/schema.js';
import type { EscalationReason, Locale, MessageView } from '../types.js';
import { AGENT_TOOLS, executeTool, type ToolContext } from './tools.js';
import { dynamicSystemPrompt, staticSystemPrompt } from './prompt.js';

/**
 * The agent loop.
 *
 * A manual tool-use loop rather than the SDK tool runner, because we need to
 * inspect every tool call as it happens: `escalate_to_human` changes what the
 * pipeline does with the final reply, and booking results feed numbers into the
 * price guard's allow-list.
 */

let client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!client) {
    const config = getConfig();
    client = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : new Anthropic();
  }
  return client;
}

export interface AgentRequest {
  kb: KnowledgeBase;
  clinicId: string;
  conversationId: string;
  patientId: string;
  locale: Locale;
  /** Oldest first. Only patient/agent/staff turns; system notes are excluded. */
  history: MessageView[];
  clinicalFlag: boolean;
  patientName?: string | null;
  patientPhone?: string | null;
  openBookings?: { reference: string; label: string; service: string }[];
  now?: Date;
  maxIterations?: number;
}

export interface AgentResponse {
  /** The draft reply. Still has to clear the pre-send safety check. */
  text: string;
  escalation: { reason: EscalationReason; detail: string } | null;
  toolCalls: { name: string; ok: boolean }[];
  bookingReference: string | null;
  /** Numbers the agent learned from tool results — allowed past the price guard. */
  allowedNumbers: number[];
  usage: { input_tokens: number; output_tokens: number } | null;
}

const MAX_HISTORY_TURNS = 24;

export async function runAgent(request: AgentRequest): Promise<AgentResponse> {
  const config = getConfig();
  const now = request.now ?? new Date();

  const context: ToolContext = {
    kb: request.kb,
    clinicId: request.clinicId,
    conversationId: request.conversationId,
    patientId: request.patientId,
    locale: request.locale,
    now,
    escalated: null,
    allowedNumbers: new Set<number>(),
    lastBookingReference: null,
  };

  const messages: Anthropic.MessageParam[] = toMessageParams(request.history);
  if (messages.length === 0) {
    // Nothing to answer — the caller should send the greeting instead.
    return { text: '', escalation: null, toolCalls: [], bookingReference: null, allowedNumbers: [], usage: null };
  }

  const system: Anthropic.TextBlockParam[] = [
    // Byte-identical per clinic → cached across every message of every thread.
    { type: 'text', text: staticSystemPrompt(request.kb), cache_control: { type: 'ephemeral' } },
    {
      type: 'text',
      text: dynamicSystemPrompt({
        kb: request.kb,
        locale: request.locale,
        now,
        clinicalFlag: request.clinicalFlag,
        patientName: request.patientName ?? null,
        patientPhone: request.patientPhone ?? null,
        openBookings: request.openBookings ?? [],
      }),
    },
  ];

  const toolCalls: AgentResponse['toolCalls'] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  const usageSnapshot = (): AgentResponse['usage'] =>
    sawUsage ? { input_tokens: inputTokens, output_tokens: outputTokens } : null;
  const maxIterations = request.maxIterations ?? 6;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const response = await getClient().messages.create({
      model: config.anthropicModel,
      max_tokens: config.anthropicMaxTokens,
      system,
      tools: AGENT_TOOLS,
      output_config: { effort: config.anthropicEffort },
      messages,
    });

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    sawUsage = true;

    if (response.stop_reason === 'refusal') {
      logger.warn('agent.refusal', { clinic_id: request.clinicId, conversation_id: request.conversationId });
      return {
        text: '',
        escalation: { reason: 'agent_error', detail: 'Model declined to answer' },
        toolCalls,
        bookingReference: context.lastBookingReference,
        allowedNumbers: [...context.allowedNumbers],
        usage: usageSnapshot(),
      };
    }

    // A server-side tool paused the turn: append and continue.
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }

    const toolUses = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');

    if (toolUses.length === 0) {
      return {
        text: extractText(response.content),
        escalation: context.escalated,
        toolCalls,
        bookingReference: context.lastBookingReference,
        allowedNumbers: [...context.allowedNumbers],
        usage: usageSnapshot(),
      };
    }

    messages.push({ role: 'assistant', content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const result = await executeTool(toolUse.name, toolUse.input, context);
      toolCalls.push({ name: toolUse.name, ok: result.ok === true });
      collectAllowedNumbers(result, context);
      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
        is_error: result.ok === false && result.error === 'tool_failed',
      });
    }
    messages.push({ role: 'user', content: results });
  }

  // The loop ran out of turns — do not send a half-finished reply.
  logger.warn('agent.max_iterations', { clinic_id: request.clinicId, conversation_id: request.conversationId });
  return {
    text: '',
    escalation: { reason: 'agent_error', detail: 'Agent exceeded its tool-use budget' },
    toolCalls,
    bookingReference: context.lastBookingReference,
    allowedNumbers: [...context.allowedNumbers],
    usage: usageSnapshot(),
  };
}

/**
 * Any number the agent got back from a tool is a fact, not an invention, so the
 * price guard lets it through. In practice this covers confirmed times and
 * durations; prices still have to match the published list.
 */
function collectAllowedNumbers(result: Record<string, unknown>, context: ToolContext): void {
  const walk = (value: unknown, depth: number): void => {
    if (depth > 3) return;
    if (typeof value === 'number' && Number.isFinite(value)) context.allowedNumbers.add(value);
    else if (Array.isArray(value)) value.slice(0, 30).forEach((v) => walk(v, depth + 1));
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => walk(v, depth + 1));
  };
  walk(result, 0);
}

function toMessageParams(history: MessageView[]): Anthropic.MessageParam[] {
  const relevant = history.filter((message) => message.author !== 'system' && message.body.trim().length > 0);
  const trimmed = relevant.slice(-MAX_HISTORY_TURNS);
  const params: Anthropic.MessageParam[] = [];
  for (const message of trimmed) {
    // Staff replies are folded in as assistant turns: from the patient's side
    // they are the same voice, and the agent must not contradict them.
    const role: 'user' | 'assistant' = message.author === 'patient' ? 'user' : 'assistant';
    const last = params[params.length - 1];
    if (last && last.role === role) {
      last.content = `${last.content as string}\n${message.body}`;
    } else {
      params.push({ role, content: message.body });
    }
  }
  // The API requires the first turn to be from the user.
  while (params.length > 0 && params[0]!.role !== 'user') params.shift();
  return params;
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** Test seam — lets the pipeline tests run without an API key. */
export function setAnthropicClient(next: Anthropic | undefined): void {
  client = next;
}
