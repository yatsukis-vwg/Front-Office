/** Response shapes from the admin API, mirrored for the dashboard's use. */

export interface ConversationSummary {
  id: string;
  channel: 'telegram' | 'webchat' | 'whatsapp';
  status: 'open' | 'escalated' | 'closed';
  owner: 'agent' | 'human';
  taken_over_by: string | null;
  last_message_at: string;
  message_count: number;
  created_at: string;
  patient_name: string | null;
  patient_phone: string | null;
  last_message: { author: string; body: string; created_at: string } | null;
  open_escalations: number;
  escalation_reasons: string[];
}

export interface TranscriptMessage {
  id: string;
  author: 'patient' | 'agent' | 'staff' | 'system';
  direction: 'inbound' | 'outbound';
  body: string;
  flagged: boolean;
  response_ms: number | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface EscalationRow {
  id: string;
  conversation_id: string;
  reason: string;
  detail: string;
  status: 'open' | 'resolved';
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  channel: string | null;
  owner: string | null;
  patient_name: string | null;
  last_patient_message: string | null;
}

export interface AppointmentRow {
  id: string;
  reference: string;
  service_id: string;
  doctor_id: string;
  starts_at: string;
  ends_at: string;
  status: 'booked' | 'cancelled' | 'completed' | 'no_show';
  source: 'agent' | 'staff' | 'seed';
  created_outside_hours: boolean;
  created_at: string;
  patient_name: string | null;
  patient_phone: string | null;
}

export interface Metrics {
  window: { from: string; to: string; label: string };
  messagesHandled: number;
  inboundMessages: number;
  agentReplies: number;
  conversations: number;
  bookingsCaptured: number;
  bookingsOutsideHours: number;
  outsideHoursShare: number;
  cancellations: number;
  reschedules: number;
  averageResponseMs: number | null;
  medianResponseMs: number | null;
  escalations: number;
  escalationRate: number;
  estimatedRevenueSar: number;
  estimatedRevenueOutsideHoursSar: number;
  avgTicketSar: number;
  byChannel: { channel: string; conversations: number; bookings: number }[];
  byDay: { date: string; messages: number; bookings: number; bookingsOutsideHours: number }[];
  topServices: { service_id: string; name: string; bookings: number }[];
  escalationsByReason: { reason: string; count: number }[];
  bookingsByHour: { hour: number; bookings: number; outsideHours: number }[];
}

export interface KnowledgeBaseDoc {
  version: 1;
  clinic: Record<string, unknown> & {
    slug: string;
    name_ar: string;
    name_en: string;
    timezone: string;
    avg_ticket_sar: number;
    retention_days: number;
  };
  services: { id: string; name_ar: string; name_en: string; duration_min: number; price: { type: string; amount: number; max_amount?: number } | null; doctor_ids: string[] }[];
  doctors: { id: string; name_ar: string; name_en: string; speciality_ar: string }[];
  faqs: { id: string; q_ar: string; a_ar: string; q_en?: string; a_en?: string; tags: string[] }[];
  [key: string]: unknown;
}
