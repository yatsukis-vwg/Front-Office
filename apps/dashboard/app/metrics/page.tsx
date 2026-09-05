import Shell from '@/components/Shell';
import { adminFetch } from '@/lib/api';
import type { Metrics } from '@/lib/types';

export const dynamic = 'force-dynamic';

const SAR = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)} min`;
}

const CHANNEL_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  webchat: 'Web widget',
  whatsapp: 'WhatsApp',
  manual: 'Phone / walk-in',
};

export default async function MetricsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const params = await searchParams;
  const days = Number(params.days ?? 30);
  const { metrics } = await adminFetch<{ metrics: Metrics }>(`/metrics?days=${days}`);

  const maxHour = Math.max(1, ...metrics.bookingsByHour.map((h) => h.bookings));
  const maxDay = Math.max(1, ...metrics.byDay.map((d) => d.messages));

  return (
    <Shell active="/metrics">
      <div className="page-head">
        <div>
          <h1>Performance</h1>
          <p>{metrics.window.label} · every figure below is computed from live conversation and booking data.</p>
        </div>
        <div className="row">
          {[7, 30, 90].map((option) => (
            <a key={option} className={`btn sm${days === option ? ' primary' : ''}`} href={`/metrics?days=${option}`}>
              {option}d
            </a>
          ))}
        </div>
      </div>

      {/* The headline. This is the number the whole product is sold on. */}
      <div className="headline">
        <div className="label">Bookings captured outside working hours</div>
        <div className="value">{metrics.bookingsOutsideHours}</div>
        <div className="sub">
          {Math.round(metrics.outsideHoursShare * 100)}% of all bookings arrived while the clinic was closed — evenings,
          the afternoon break, Fridays and after 9 PM. Without an always-on receptionist these are the enquiries that go
          to whoever answers first.
        </div>
        <div className="kicker">
          ≈ SAR {SAR.format(metrics.estimatedRevenueOutsideHoursSar)} in captured revenue at an average ticket of SAR{' '}
          {SAR.format(metrics.avgTicketSar)}
        </div>
      </div>

      <div className="grid cols-4" style={{ marginTop: 16 }}>
        <Stat label="Messages handled" value={String(metrics.messagesHandled)} sub={`${metrics.inboundMessages} from patients`} />
        <Stat label="Bookings captured" value={String(metrics.bookingsCaptured)} sub={`${metrics.reschedules} reschedules, ${metrics.cancellations} cancellations`} />
        <Stat label="Average response time" value={formatMs(metrics.averageResponseMs)} sub={`median ${formatMs(metrics.medianResponseMs)}`} />
        <Stat
          label="Escalation rate"
          value={`${Math.round(metrics.escalationRate * 100)}%`}
          sub={`${metrics.escalations} conversations flagged for a human`}
        />
      </div>

      <div className="grid cols-4" style={{ marginTop: 14 }}>
        <Stat label="Conversations" value={String(metrics.conversations)} sub="unique patient threads" />
        <Stat label="Agent replies" value={String(metrics.agentReplies)} sub="sent automatically" />
        <Stat
          label="Estimated revenue captured"
          value={`SAR ${SAR.format(metrics.estimatedRevenueSar)}`}
          sub={`${metrics.bookingsCaptured} bookings × SAR ${SAR.format(metrics.avgTicketSar)}`}
        />
        <Stat
          label="Out-of-hours share"
          value={`${Math.round(metrics.outsideHoursShare * 100)}%`}
          sub="of bookings, clinic closed"
        />
      </div>

      <div className="grid cols-2" style={{ marginTop: 18 }}>
        <div className="panel panel-pad">
          <h2>When bookings actually arrive</h2>
          <p className="muted" style={{ marginTop: -6, fontSize: 12.5 }}>
            Hour of day, clinic local time. Teal bars are bookings taken while the clinic was closed.
          </p>
          <div className="hours-chart">
            {metrics.bookingsByHour.map((bucket) => {
              const openCount = bucket.bookings - bucket.outsideHours;
              return (
                <div className="col" key={bucket.hour} title={`${bucket.hour}:00 — ${bucket.bookings} booking(s), ${bucket.outsideHours} out of hours`}>
                  <div className="seg closed" style={{ height: `${(bucket.outsideHours / maxHour) * 100}px` }} />
                  <div className="seg open" style={{ height: `${(openCount / maxHour) * 100}px` }} />
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 3 }}>
            {metrics.bookingsByHour.map((bucket) => (
              <div className="tick" key={bucket.hour} style={{ flex: 1 }}>
                {bucket.hour % 6 === 0 ? bucket.hour : ''}
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 10, fontSize: 12 }}>
            <span className="tag teal">Clinic closed</span>
            <span className="tag gray">Clinic open</span>
          </div>
        </div>

        <div className="panel panel-pad">
          <h2>Daily volume</h2>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Messages</th>
                <th>Bookings</th>
                <th className="nowrap">Out of hours</th>
                <th style={{ width: '32%' }} />
              </tr>
            </thead>
            <tbody>
              {metrics.byDay.slice(-10).reverse().map((day) => (
                <tr key={day.date}>
                  <td className="mono nowrap">{day.date}</td>
                  <td>{day.messages}</td>
                  <td>{day.bookings}</td>
                  <td>{day.bookingsOutsideHours > 0 ? <span className="tag teal">{day.bookingsOutsideHours}</span> : <span className="muted">0</span>}</td>
                  <td>
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${(day.messages / maxDay) * 100}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
              {metrics.byDay.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty">
                    No activity in this window.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid cols-3" style={{ marginTop: 14 }}>
        <div className="panel panel-pad">
          <h3>By channel</h3>
          <table>
            <tbody>
              {metrics.byChannel.map((row) => (
                <tr key={row.channel}>
                  <td>{CHANNEL_LABEL[row.channel] ?? row.channel}</td>
                  <td className="nowrap muted">{row.conversations} threads</td>
                  <td className="nowrap"><strong>{row.bookings}</strong> bookings</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel panel-pad">
          <h3>Most requested</h3>
          <table>
            <tbody>
              {metrics.topServices.map((service) => (
                <tr key={service.service_id}>
                  <td className="rtl">{service.name}</td>
                  <td className="nowrap" style={{ textAlign: 'right' }}>
                    <strong>{service.bookings}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel panel-pad">
          <h3>Why conversations escalate</h3>
          <table>
            <tbody>
              {metrics.escalationsByReason.map((row) => (
                <tr key={row.reason}>
                  <td>
                    <span className={`tag ${row.reason === 'emergency_language' ? 'red' : 'amber'}`}>{row.reason.replace(/_/g, ' ')}</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <strong>{row.count}</strong>
                  </td>
                </tr>
              ))}
              {metrics.escalationsByReason.length === 0 ? (
                <tr>
                  <td className="empty">Nothing escalated in this window.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </Shell>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}
