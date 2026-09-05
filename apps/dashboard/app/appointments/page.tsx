import Shell from '@/components/Shell';
import ManualBooking from '@/components/ManualBooking';
import { adminFetch } from '@/lib/api';
import type { AppointmentRow, KnowledgeBaseDoc } from '@/lib/types';

export const dynamic = 'force-dynamic';

const TZ = 'Asia/Riyadh';

function dayKey(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function timeLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

export default async function AppointmentsPage({ searchParams }: { searchParams: Promise<{ weeks?: string }> }) {
  const params = await searchParams;
  const weeks = Number(params.weeks ?? 2);
  const from = new Date(Date.now() - 7 * 86400000).toISOString();
  const to = new Date(Date.now() + weeks * 7 * 86400000).toISOString();

  const [{ appointments }, { kb }] = await Promise.all([
    adminFetch<{ appointments: AppointmentRow[] }>(`/appointments?from=${from}&to=${to}`),
    adminFetch<{ kb: KnowledgeBaseDoc }>('/kb'),
  ]);

  const serviceNames = new Map(kb.services.map((service) => [service.id, service.name_ar]));
  const doctorNames = new Map(kb.doctors.map((doctor) => [doctor.id, doctor.name_ar]));

  const byDay = new Map<string, AppointmentRow[]>();
  for (const appointment of appointments) {
    const key = dayKey(appointment.starts_at);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(appointment);
    else byDay.set(key, [appointment]);
  }
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const todayKey = dayKey(new Date().toISOString());

  const upcoming = appointments.filter((a) => a.status === 'booked' && Date.parse(a.starts_at) > Date.now()).length;
  const outsideHours = appointments.filter((a) => a.created_outside_hours).length;

  return (
    <Shell active="/appointments">
      <div className="page-head">
        <div>
          <h1>Appointments</h1>
          <p>
            {appointments.length} in this window · {upcoming} upcoming · {outsideHours} were booked while the clinic was
            closed.
          </p>
        </div>
        <div className="row">
          {[1, 2, 4].map((option) => (
            <a key={option} className={`btn sm${weeks === option ? ' primary' : ''}`} href={`/appointments?weeks=${option}`}>
              {option}w
            </a>
          ))}
          <ManualBooking services={kb.services} />
        </div>
      </div>

      {days.length === 0 ? (
        <div className="panel">
          <div className="empty">No appointments in this window.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {days.map(([day, rows]) => {
            const label = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(
              new Date(`${day}T12:00:00Z`),
            );
            const isToday = day === todayKey;
            const isPast = day < todayKey;
            return (
              <div className="panel" key={day} style={isToday ? { borderColor: 'var(--accent)' } : undefined}>
                <div
                  className="row"
                  style={{
                    padding: '12px 16px',
                    borderBottom: '1px solid var(--line)',
                    background: isToday ? 'var(--accent-soft)' : '#fafbfc',
                    borderRadius: '12px 12px 0 0',
                  }}
                >
                  <strong>{label}</strong>
                  {isToday ? <span className="tag teal">today</span> : null}
                  <div className="spacer" />
                  <span className="muted">{rows.filter((row) => row.status === 'booked').length} booked</span>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 70 }}>Time</th>
                      <th>Patient</th>
                      <th>Service</th>
                      <th>Doctor</th>
                      <th>Ref</th>
                      <th>Booked</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody style={isPast ? { opacity: 0.65 } : undefined}>
                    {rows
                      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
                      .map((row) => (
                        <tr key={row.id}>
                          <td className="mono nowrap">{timeLabel(row.starts_at)}</td>
                          <td>
                            <div className="rtl">{row.patient_name ?? '—'}</div>
                            <div className="muted mono">{row.patient_phone ?? ''}</div>
                          </td>
                          <td className="rtl">{serviceNames.get(row.service_id) ?? row.service_id}</td>
                          <td className="rtl">{doctorNames.get(row.doctor_id) ?? row.doctor_id}</td>
                          <td className="mono nowrap">{row.reference}</td>
                          <td className="nowrap">
                            {row.created_outside_hours ? (
                              <span className="tag teal" title="Captured while the clinic was closed">
                                after hours
                              </span>
                            ) : (
                              <span className="muted" style={{ fontSize: 12 }}>
                                {row.source}
                              </span>
                            )}
                          </td>
                          <td>
                            <span
                              className={`tag ${
                                row.status === 'booked'
                                  ? 'green'
                                  : row.status === 'cancelled' || row.status === 'no_show'
                                    ? 'red'
                                    : 'gray'
                              }`}
                            >
                              {row.status.replace('_', ' ')}
                            </span>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}
    </Shell>
  );
}
