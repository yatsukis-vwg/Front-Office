/**
 * @front-office/core — everything the API server and the dashboard share.
 */

export * from './types.js';
export {
  getConfig,
  assertProductionSafety,
  ConfigurationError,
  resetConfigCache,
  type AppConfig,
  type StoreDriver,
} from './config.js';
export { logger } from './logger.js';

export * from './crypto/encryption.js';

export { getStore, setStore, FileStore, SupabaseStore } from './db/index.js';
export { eq, gt, gte, isIn, lt, lte, applyQuery, type Filter, type QueryOptions, type Store } from './db/store.js';
export { appointments, audit, clinics, conversations, escalations, kbOverrides, messages, patients, reminders } from './db/repos.js';

export * from './kb/schema.js';
export {
  clinicFilePath,
  doctorsForService,
  findDoctor,
  findService,
  formatPrice,
  instructionsForService,
  invalidateKnowledgeBaseCache,
  listClinicSlugs,
  loadKnowledgeBase,
  loadKnowledgeBaseFile,
  publishedPriceValues,
  resolveClinicsDir,
} from './kb/loader.js';

export { detectConversationLocale, detectLocale, normalizeArabic, normalizeForMatching, westerniseDigits } from './safety/language.js';
export { scanInbound, tripwireRuleLabels, type TripwireHit, type TripwireResult } from './safety/tripwires.js';
export {
  checkOutgoing,
  checkToolFreeText,
  emergencyDirective,
  extractMoneyFigures,
  holdingReply,
  publishedPriceSet,
  type PreSendResult,
  type Violation,
  type ViolationCode,
} from './safety/presend.js';

export {
  conflicts,
  describeHours,
  findAvailableSlots,
  isHoliday,
  isWithinWorkingHours,
  type Slot,
} from './scheduling/availability.js';
export {
  bookAppointment,
  bookingErrorBody,
  cancelAppointment,
  getAvailability,
  isBookingFailure,
  rescheduleAppointment,
  scheduleReminders,
  type AvailabilityResult,
  type AvailabilitySuccess,
  type BookingErrorBody,
  type BookingFailure,
  type BookingResult,
  type BookingSuccess,
  type CancelResult,
  type CancelSuccess,
  type SlotSummary,
} from './scheduling/booking.js';

export { runAgent, setAnthropicClient, type AgentRequest, type AgentResponse } from './agent/runner.js';
export { AGENT_TOOLS, executeTool, type ToolContext } from './agent/tools.js';
export { dynamicSystemPrompt, staticSystemPrompt } from './agent/prompt.js';

export * from './messaging/types.js';
export { credentialsForClinic, getChannel, registerChannel, registeredChannels, tryGetChannel } from './messaging/registry.js';
export { TelegramChannel, setTelegramWebhook } from './messaging/channels/telegram.js';
export { WebChatChannel, drainWebchatBuffer } from './messaging/channels/webchat.js';
export { WhatsAppChannel } from './messaging/channels/whatsapp.js';
export { deliver, handleInbound, sendStaffReply, type HandleResult } from './messaging/pipeline.js';

export { closeOutPastAppointments, runDueReminders, type ReminderRunSummary } from './jobs/reminders.js';
export { deletePatientRecord, exportPatientRecord, purgeAllClinics, purgeExpiredData, type PurgeSummary } from './jobs/retention.js';

export { computeMetrics, formatDuration, windowForDays, type ClinicMetrics, type MetricsWindow } from './metrics/metrics.js';

export * from './util/time.js';
