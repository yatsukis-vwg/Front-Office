/**
 * Shared domain types.
 *
 * Every persisted row carries `clinic_id`. Per-clinic isolation is enforced in
 * three places: the repository layer always scopes queries by clinic, the
 * Postgres RLS policies in supabase/migrations, and the admin API which derives
 * the clinic from the authenticated session rather than from request input.
 */

export type ChannelId = 'telegram' | 'webchat' | 'whatsapp';

export type Locale = 'ar' | 'en';

export type MessageDirection = 'inbound' | 'outbound';

/** Who produced a message. `staff` means a human took over the thread. */
export type MessageAuthor = 'patient' | 'agent' | 'staff' | 'system';

export type ConversationStatus = 'open' | 'escalated' | 'closed';

/** Who is currently answering a thread. `human` pauses the agent entirely. */
export type ConversationOwner = 'agent' | 'human';

export type AppointmentStatus = 'booked' | 'cancelled' | 'completed' | 'no_show';

export type AppointmentSource = 'agent' | 'staff' | 'seed';

export type ReminderKind = 'confirmation' | 'reminder_24h' | 'reminder_2h';

export type ReminderStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

export type EscalationStatus = 'open' | 'resolved';

/**
 * Reason codes are stable identifiers — the dashboard groups on them and the
 * safety tests assert on them. Never repurpose a code; add a new one.
 */
export type EscalationReason =
  | 'emergency_language'
  | 'medical_advice'
  | 'unpublished_price'
  | 'treatment_suitability'
  | 'outcome_promise'
  | 'symptom_description'
  | 'agent_requested'
  | 'agent_error'
  | 'staff_flagged';

export interface Clinic {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  /** Used by the metrics page to turn bookings into an estimated revenue figure. */
  avg_ticket_sar: number;
  /** PDPL retention window; the purge job deletes patient data older than this. */
  retention_days: number;
  /** Telegram bot binding, webchat origins, notification settings. */
  settings: ClinicSettings;
  created_at: string;
}

export interface ClinicSettings {
  telegram_bot_token?: string;
  /** Shared secret Telegram echoes back in X-Telegram-Bot-Api-Secret-Token. */
  telegram_webhook_secret?: string;
  webchat_allowed_origins?: string[];
  /** Staff Telegram chat ids notified when a conversation escalates. */
  escalation_notify_chat_ids?: string[];
}

export interface Patient {
  id: string;
  clinic_id: string;
  /** AES-256-GCM ciphertext. Never read directly — go through PatientRepo. */
  name_enc: string | null;
  phone_enc: string | null;
  /** Deterministic HMAC of the E.164 phone, so we can look a patient up without decrypting. */
  phone_hash: string | null;
  locale: Locale;
  created_at: string;
  last_seen_at: string;
  /** Set by the PDPL erasure endpoint; the row is kept only as a tombstone. */
  deleted_at: string | null;
}

/** Decrypted view, produced only inside the API/agent process. */
export interface PatientView {
  id: string;
  clinic_id: string;
  name: string | null;
  phone: string | null;
  locale: Locale;
  created_at: string;
  last_seen_at: string;
  deleted_at: string | null;
}

export interface Conversation {
  id: string;
  clinic_id: string;
  patient_id: string;
  channel: ChannelId;
  /** Channel-native thread identifier (Telegram chat id, webchat session id, ...). */
  channel_thread_id: string;
  status: ConversationStatus;
  owner: ConversationOwner;
  /** Set while a staff member holds the thread; the agent stays silent. */
  taken_over_by: string | null;
  taken_over_at: string | null;
  last_message_at: string;
  message_count: number;
  created_at: string;
  closed_at: string | null;
}

export interface Message {
  id: string;
  clinic_id: string;
  conversation_id: string;
  direction: MessageDirection;
  author: MessageAuthor;
  /** AES-256-GCM ciphertext of the message body. Plaintext never touches disk logs. */
  body_enc: string;
  /** Milliseconds between the triggering inbound message and this outbound reply. */
  response_ms: number | null;
  /** True when the safety layer replaced or blocked this message. */
  flagged: boolean;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface MessageView extends Omit<Message, 'body_enc'> {
  body: string;
}

export interface Appointment {
  id: string;
  clinic_id: string;
  /** Human-facing booking reference, e.g. NR-7QK4M2. */
  reference: string;
  patient_id: string;
  conversation_id: string | null;
  /** Service and doctor ids come from the clinic knowledge base file, not a DB table. */
  service_id: string;
  doctor_id: string;
  starts_at: string;
  ends_at: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  notes_enc: string | null;
  /**
   * True when the booking was *created* outside the clinic's working hours.
   * This is the headline metric on the dashboard — bookings that a human
   * receptionist would have missed.
   */
  created_outside_hours: boolean;
  created_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

export interface Reminder {
  id: string;
  clinic_id: string;
  appointment_id: string;
  kind: ReminderKind;
  send_at: string;
  status: ReminderStatus;
  sent_at: string | null;
  error: string | null;
  created_at: string;
}

export interface Escalation {
  id: string;
  clinic_id: string;
  conversation_id: string;
  message_id: string | null;
  reason: EscalationReason;
  /** Short, non-clinical description. Message bodies are not copied in here. */
  detail: string;
  status: EscalationStatus;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

export interface AuditEntry {
  id: string;
  clinic_id: string;
  actor_type: 'staff' | 'agent' | 'system' | 'patient';
  actor_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

/** Dashboard edits to the knowledge base, layered on top of the YAML file. */
export interface KbOverride {
  id: string;
  clinic_id: string;
  kb: Record<string, unknown>;
  updated_at: string;
  updated_by: string | null;
}

export interface Tables {
  clinics: Clinic;
  patients: Patient;
  conversations: Conversation;
  messages: Message;
  appointments: Appointment;
  reminders: Reminder;
  escalations: Escalation;
  audit_log: AuditEntry;
  kb_overrides: KbOverride;
}

export type TableName = keyof Tables;
