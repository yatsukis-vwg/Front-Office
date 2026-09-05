import type { Appointment } from '../types.js';
import type { Doctor, KnowledgeBase, Service, WorkingHours } from '../kb/schema.js';
import { doctorsForService } from '../kb/loader.js';
import { addDays, formatClock, parseClock, parseDateKey, toZonedParts, zonedDateKey, zonedToUtc } from '../util/time.js';

/**
 * Availability engine.
 *
 * Slots are derived from the knowledge base (clinic hours, per-doctor hours,
 * breaks, days off, holidays) minus the appointments already in the database.
 * Nothing about a clinic's schedule lives in code — it all comes from the YAML.
 */

export interface Slot {
  startsAt: Date;
  endsAt: Date;
  doctorId: string;
  doctorNameAr: string;
  doctorNameEn: string;
  serviceId: string;
}

export interface AvailabilityRequest {
  kb: KnowledgeBase;
  service: Service;
  /** Inclusive, `YYYY-MM-DD` in clinic time. */
  fromDate: string;
  /** Inclusive, `YYYY-MM-DD` in clinic time. */
  toDate: string;
  doctorId?: string;
  /** Appointments already booked in the window, for conflict subtraction. */
  existing: Appointment[];
  now?: Date;
  limit?: number;
}

interface Interval {
  start: number;
  end: number;
}

/** Working windows for a doctor on a given weekday, in minutes from midnight. */
function windowsForDay(kb: KnowledgeBase, doctor: Doctor, weekday: number): Interval[] {
  const clinicWindows = kb.clinic.hours.filter((w) => w.days.includes(weekday));
  if (clinicWindows.length === 0) return [];

  const doctorWindows: WorkingHours[] =
    doctor.working_hours.length > 0 ? doctor.working_hours.filter((w) => w.days.includes(weekday)) : clinicWindows;
  if (doctorWindows.length === 0) return [];

  const out: Interval[] = [];
  for (const doctorWindow of doctorWindows) {
    for (const clinicWindow of clinicWindows) {
      // A doctor can only work while the clinic is open.
      const start = Math.max(parseClock(doctorWindow.open), parseClock(clinicWindow.open));
      const end = Math.min(parseClock(doctorWindow.close), parseClock(clinicWindow.close));
      if (end <= start) continue;
      let pieces: Interval[] = [{ start, end }];
      const breaks = [...clinicWindow.breaks, ...doctorWindow.breaks];
      for (const brk of breaks) {
        pieces = pieces.flatMap((piece) => subtract(piece, { start: parseClock(brk.start), end: parseClock(brk.end) }));
      }
      out.push(...pieces);
    }
  }
  return mergeIntervals(out);
}

function subtract(base: Interval, cut: Interval): Interval[] {
  if (cut.end <= base.start || cut.start >= base.end) return [base];
  const out: Interval[] = [];
  if (cut.start > base.start) out.push({ start: base.start, end: cut.start });
  if (cut.end < base.end) out.push({ start: cut.end, end: base.end });
  return out;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const interval of sorted) {
    const last = out[out.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else out.push({ ...interval });
  }
  return out;
}

export function isHoliday(kb: KnowledgeBase, dateKey: string): boolean {
  return kb.clinic.holidays.includes(dateKey);
}

/** True when the clinic itself is open at that instant (used by the metrics page). */
export function isWithinWorkingHours(kb: KnowledgeBase, at: Date): boolean {
  const tz = kb.clinic.timezone;
  const dateKey = zonedDateKey(at, tz);
  if (isHoliday(kb, dateKey)) return false;
  const parts = toZonedParts(at, tz);
  const minutes = parts.hour * 60 + parts.minute;
  for (const window of kb.clinic.hours) {
    if (!window.days.includes(parts.weekday)) continue;
    if (minutes < parseClock(window.open) || minutes >= parseClock(window.close)) continue;
    const inBreak = window.breaks.some((b) => minutes >= parseClock(b.start) && minutes < parseClock(b.end));
    if (!inBreak) return true;
  }
  return false;
}

/**
 * Generates bookable slots.
 *
 * A slot is offered only when the whole appointment *plus its buffer* fits
 * inside one working window and does not overlap an existing booking for the
 * same doctor. Buffers are applied on both sides of an existing appointment, so
 * back-to-back bookings always leave the clinic its turnaround time.
 */
export function findAvailableSlots(request: AvailabilityRequest): Slot[] {
  const { kb, service, existing } = request;
  const tz = kb.clinic.timezone;
  const now = request.now ?? new Date();
  const granularity = kb.scheduling.slot_granularity_min;
  const limit = request.limit ?? kb.scheduling.max_slots_offered;
  const earliest = new Date(now.getTime() + kb.scheduling.min_notice_hours * 3600_000);
  const latest = addDays(now, kb.scheduling.max_advance_days);

  const doctors = doctorsForService(kb, service).filter((d) => !request.doctorId || d.id === request.doctorId);
  if (doctors.length === 0) return [];

  const from = parseDateKey(request.fromDate);
  const to = parseDateKey(request.toDate);
  const cursorStart = zonedToUtc(tz, from.year, from.month, from.day, 0, 0);
  const cursorEnd = zonedToUtc(tz, to.year, to.month, to.day, 23, 59);

  const slots: Slot[] = [];
  const totalMinutes = service.duration_min + service.buffer_min;

  for (let day = 0; day < kb.scheduling.max_advance_days + 1; day++) {
    const dayStart = addDays(cursorStart, day);
    if (dayStart.getTime() > cursorEnd.getTime()) break;
    const dateKey = zonedDateKey(dayStart, tz);
    if (isHoliday(kb, dateKey)) continue;
    const { year, month, day: dayOfMonth } = parseDateKey(dateKey);
    const weekday = toZonedParts(dayStart, tz).weekday;

    for (const doctor of doctors) {
      if (doctor.days_off.includes(dateKey)) continue;
      for (const window of windowsForDay(kb, doctor, weekday)) {
        for (let minute = window.start; minute + totalMinutes <= window.end; minute += granularity) {
          const startsAt = zonedToUtc(tz, year, month, dayOfMonth, 0, 0);
          const slotStart = new Date(startsAt.getTime() + minute * 60000);
          const slotEnd = new Date(slotStart.getTime() + service.duration_min * 60000);
          if (slotStart.getTime() < earliest.getTime()) continue;
          if (slotStart.getTime() > latest.getTime()) continue;
          if (conflicts(slotStart, slotEnd, doctor.id, existing, service.buffer_min, kb)) continue;
          slots.push({
            startsAt: slotStart,
            endsAt: slotEnd,
            doctorId: doctor.id,
            doctorNameAr: doctor.name_ar,
            doctorNameEn: doctor.name_en,
            serviceId: service.id,
          });
        }
      }
    }
  }

  slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return spreadAcrossDays(slots, limit, tz);
}

/**
 * True when [start,end) collides with an existing booking for `doctorId`,
 * taking each side's buffer into account.
 */
export function conflicts(
  start: Date,
  end: Date,
  doctorId: string,
  existing: Appointment[],
  bufferMin: number,
  kb: KnowledgeBase,
): boolean {
  const startMs = start.getTime();
  const endMs = end.getTime();
  for (const appointment of existing) {
    if (appointment.status !== 'booked') continue;
    if (appointment.doctor_id !== doctorId) continue;
    const otherBuffer = kb.services.find((s) => s.id === appointment.service_id)?.buffer_min ?? 0;
    const pad = Math.max(bufferMin, otherBuffer) * 60000;
    const otherStart = Date.parse(appointment.starts_at);
    const otherEnd = Date.parse(appointment.ends_at) + pad;
    if (startMs < otherEnd && endMs + pad > otherStart) return true;
  }
  return false;
}

/**
 * Offering six consecutive 15-minute slots on one afternoon is useless to a
 * patient. When the caller wants a short list, spread the offer across days and
 * across each day's window; when it wants everything (the booking pre-check
 * asks for the full set), return everything.
 */
function spreadAcrossDays(slots: Slot[], limit: number, timeZone: string): Slot[] {
  if (slots.length <= limit) return slots;

  const byDay = new Map<string, Slot[]>();
  for (const slot of slots) {
    const key = zonedDateKey(slot.startsAt, timeZone);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(slot);
    else byDay.set(key, [slot]);
  }

  const dayCount = byDay.size;
  const perDay = Math.max(1, Math.ceil(limit / dayCount));
  const picked: Slot[] = [];
  const queues: Slot[][] = [];

  for (const bucket of byDay.values()) {
    // Step through each day so the offered times are spaced out, not adjacent.
    const stride = Math.max(1, Math.floor(bucket.length / perDay));
    const daySlots: Slot[] = [];
    for (let i = 0; i < bucket.length && daySlots.length < perDay; i += stride) {
      daySlots.push(bucket[i]!);
    }
    queues.push(daySlots);
  }

  // Round-robin across days so the first offers are on different dates.
  for (let round = 0; picked.length < limit; round++) {
    let advanced = false;
    for (const queue of queues) {
      const slot = queue[round];
      if (!slot) continue;
      picked.push(slot);
      advanced = true;
      if (picked.length >= limit) break;
    }
    if (!advanced) break;
  }

  return picked.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** Human-readable clinic hours, used in prompts and the dashboard. */
export function describeHours(kb: KnowledgeBase, locale: 'ar' | 'en'): string {
  const dayNamesAr = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const dayNamesEn = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const names = locale === 'ar' ? dayNamesAr : dayNamesEn;
  const lines = kb.clinic.hours.map((window) => {
    const days = window.days.map((d) => names[d]).join('، ');
    const breaks = window.breaks.map((b) => `${formatClock(parseClock(b.start))}–${formatClock(parseClock(b.end))}`).join(', ');
    const suffix = breaks ? (locale === 'ar' ? ` (استراحة ${breaks})` : ` (break ${breaks})`) : '';
    return `${days}: ${window.open}–${window.close}${suffix}`;
  });
  const openDays = new Set(kb.clinic.hours.flatMap((w) => w.days));
  const closed = [0, 1, 2, 3, 4, 5, 6].filter((d) => !openDays.has(d)).map((d) => names[d]);
  if (closed.length > 0) lines.push(locale === 'ar' ? `مغلق: ${closed.join('، ')}` : `Closed: ${closed.join(', ')}`);
  return lines.join('\n');
}
