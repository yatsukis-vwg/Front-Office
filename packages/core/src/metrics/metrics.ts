import { getStore } from '../db/index.js';
import { eq, gte, lte } from '../db/store.js';
import { isWithinWorkingHours } from '../scheduling/availability.js';
import type { KnowledgeBase } from '../kb/schema.js';
import type { Appointment, Clinic } from '../types.js';

/**
 * Metrics — the sales page.
 *
 * The headline number is `bookingsOutsideHours`: appointments the receptionist
 * captured while the clinic was closed. That is the revenue a clinic is losing
 * today, and it is the single most persuasive figure in the demo.
 */

export interface MetricsWindow {
  from: string;
  to: string;
  label: string;
}

export interface ClinicMetrics {
  window: MetricsWindow;
  messagesHandled: number;
  inboundMessages: number;
  agentReplies: number;
  conversations: number;
  bookingsCaptured: number;
  /** HEADLINE: bookings created while the clinic was closed. */
  bookingsOutsideHours: number;
  outsideHoursShare: number;
  cancellations: number;
  reschedules: number;
  averageResponseMs: number | null;
  medianResponseMs: number | null;
  escalations: number;
  escalationRate: number;
  /** bookings × the clinic's configured average ticket. */
  estimatedRevenueSar: number;
  estimatedRevenueOutsideHoursSar: number;
  avgTicketSar: number;
  byChannel: { channel: string; conversations: number; bookings: number }[];
  byDay: { date: string; messages: number; bookings: number; bookingsOutsideHours: number }[];
  topServices: { service_id: string; name: string; bookings: number }[];
  escalationsByReason: { reason: string; count: number }[];
  /** Hour-of-day histogram of when bookings arrive; drives the demo chart. */
  bookingsByHour: { hour: number; bookings: number; outsideHours: number }[];
}

export function windowForDays(days: number, now: Date = new Date()): MetricsWindow {
  const to = now;
  const from = new Date(now.getTime() - days * 86400_000);
  return { from: from.toISOString(), to: to.toISOString(), label: `Last ${days} days` };
}

export async function computeMetrics(clinic: Clinic, kb: KnowledgeBase, window: MetricsWindow): Promise<ClinicMetrics> {
  const store = getStore();
  const scope = eq('clinic_id', clinic.id);

  const [allMessages, allAppointments, allEscalations, allConversations] = await Promise.all([
    store.findMany('messages', { filters: [scope, gte('created_at', window.from), lte('created_at', window.to)], limit: 100000 }),
    store.findMany('appointments', { filters: [scope, gte('created_at', window.from), lte('created_at', window.to)], limit: 100000 }),
    store.findMany('escalations', { filters: [scope, gte('created_at', window.from), lte('created_at', window.to)], limit: 100000 }),
    store.findMany('conversations', { filters: [scope, gte('created_at', window.from), lte('created_at', window.to)], limit: 100000 }),
  ]);

  const inbound = allMessages.filter((m) => m.direction === 'inbound');
  const outbound = allMessages.filter((m) => m.direction === 'outbound');
  const agentReplies = outbound.filter((m) => m.author === 'agent');

  const bookingsCaptured = allAppointments.filter((a) => !isRescheduleArtifact(a)).length;
  const outsideHours = allAppointments.filter((a) => !isRescheduleArtifact(a) && a.created_outside_hours).length;

  const responseTimes = outbound
    .map((m) => m.response_ms)
    .filter((value): value is number => typeof value === 'number' && value >= 0 && value < 30 * 60_000)
    .sort((a, b) => a - b);

  const conversationCount = allConversations.length || new Set(allMessages.map((m) => m.conversation_id)).size;
  const escalatedConversations = new Set(allEscalations.map((e) => e.conversation_id)).size;

  const byDayMap = new Map<string, { messages: number; bookings: number; bookingsOutsideHours: number }>();
  for (const message of allMessages) {
    const key = message.created_at.slice(0, 10);
    const entry = byDayMap.get(key) ?? { messages: 0, bookings: 0, bookingsOutsideHours: 0 };
    entry.messages++;
    byDayMap.set(key, entry);
  }
  for (const appointment of allAppointments) {
    if (isRescheduleArtifact(appointment)) continue;
    const key = appointment.created_at.slice(0, 10);
    const entry = byDayMap.get(key) ?? { messages: 0, bookings: 0, bookingsOutsideHours: 0 };
    entry.bookings++;
    if (appointment.created_outside_hours) entry.bookingsOutsideHours++;
    byDayMap.set(key, entry);
  }

  const serviceCounts = new Map<string, number>();
  for (const appointment of allAppointments) {
    if (isRescheduleArtifact(appointment)) continue;
    serviceCounts.set(appointment.service_id, (serviceCounts.get(appointment.service_id) ?? 0) + 1);
  }

  const reasonCounts = new Map<string, number>();
  for (const escalation of allEscalations) {
    reasonCounts.set(escalation.reason, (reasonCounts.get(escalation.reason) ?? 0) + 1);
  }

  const channelMap = new Map<string, { conversations: number; bookings: number }>();
  for (const conversation of allConversations) {
    const entry = channelMap.get(conversation.channel) ?? { conversations: 0, bookings: 0 };
    entry.conversations++;
    channelMap.set(conversation.channel, entry);
  }
  const conversationChannel = new Map(allConversations.map((c) => [c.id, c.channel]));
  for (const appointment of allAppointments) {
    if (isRescheduleArtifact(appointment)) continue;
    const channel = appointment.conversation_id ? conversationChannel.get(appointment.conversation_id) : undefined;
    const key = channel ?? 'manual';
    const entry = channelMap.get(key) ?? { conversations: 0, bookings: 0 };
    entry.bookings++;
    channelMap.set(key, entry);
  }

  const hourBuckets = Array.from({ length: 24 }, (_, hour) => ({ hour, bookings: 0, outsideHours: 0 }));
  for (const appointment of allAppointments) {
    if (isRescheduleArtifact(appointment)) continue;
    const createdAt = new Date(appointment.created_at);
    const hour = localHour(createdAt, kb.clinic.timezone);
    const bucket = hourBuckets[hour]!;
    bucket.bookings++;
    if (appointment.created_outside_hours || !isWithinWorkingHours(kb, createdAt)) bucket.outsideHours++;
  }

  const avgTicket = clinic.avg_ticket_sar ?? kb.clinic.avg_ticket_sar;

  return {
    window,
    messagesHandled: allMessages.length,
    inboundMessages: inbound.length,
    agentReplies: agentReplies.length,
    conversations: conversationCount,
    bookingsCaptured,
    bookingsOutsideHours: outsideHours,
    outsideHoursShare: bookingsCaptured > 0 ? outsideHours / bookingsCaptured : 0,
    cancellations: allAppointments.filter((a) => a.status === 'cancelled' && !isRescheduleArtifact(a)).length,
    reschedules: allAppointments.filter((a) => isRescheduleArtifact(a)).length,
    averageResponseMs: responseTimes.length > 0 ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) : null,
    medianResponseMs: responseTimes.length > 0 ? responseTimes[Math.floor(responseTimes.length / 2)]! : null,
    escalations: allEscalations.length,
    escalationRate: conversationCount > 0 ? escalatedConversations / conversationCount : 0,
    estimatedRevenueSar: Math.round(bookingsCaptured * avgTicket),
    estimatedRevenueOutsideHoursSar: Math.round(outsideHours * avgTicket),
    avgTicketSar: avgTicket,
    byChannel: [...channelMap.entries()].map(([channel, value]) => ({ channel, ...value })),
    byDay: [...byDayMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, ...value })),
    topServices: [...serviceCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([serviceId, count]) => ({
        service_id: serviceId,
        name: kb.services.find((s) => s.id === serviceId)?.name_ar ?? serviceId,
        bookings: count,
      })),
    escalationsByReason: [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
    bookingsByHour: hourBuckets,
  };
}

/**
 * A reschedule creates a new appointment and cancels the old one. Counting both
 * would inflate "bookings captured", so the cancelled half is excluded.
 */
function isRescheduleArtifact(appointment: Appointment): boolean {
  return appointment.status === 'cancelled' && (appointment.cancel_reason ?? '').startsWith('rescheduled to');
}

function localHour(date: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hour12: false }).format(date);
  return Number(formatted) % 24;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}
