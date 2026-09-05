import Link from 'next/link';
import { notFound } from 'next/navigation';
import Shell from '@/components/Shell';
import TakeoverPanel from '@/components/TakeoverPanel';
import { adminFetch, ApiError } from '@/lib/api';
import type { TranscriptMessage } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface DetailResponse {
  conversation: {
    id: string;
    channel: string;
    status: string;
    owner: 'agent' | 'human';
    taken_over_by: string | null;
    created_at: string;
    message_count: number;
    channel_thread_id: string;
    patient_id: string;
  };
  patient: { id: string; name: string | null; phone: string | null; locale: string } | null;
  escalations: { id: string; reason: string; detail: string; status: string; created_at: string }[];
  appointments: { reference: string; service_id: string; starts_at: string; status: string }[];
  messages: TranscriptMessage[];
}

export default async function ConversationDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let data: DetailResponse;
  try {
    data = await adminFetch<DetailResponse>(`/conversations/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const { conversation, patient, escalations, appointments, messages } = data;

  return (
    <Shell active="/conversations">
      <div className="page-head">
        <div>
          <h1>{patient?.name ?? 'Unknown patient'}</h1>
          <p>
            <span className="mono">{patient?.phone ?? 'no number on file'}</span> · {conversation.channel} · thread{' '}
            <span className="mono">{conversation.channel_thread_id}</span> · {conversation.message_count} messages
          </p>
        </div>
        <Link className="btn" href="/conversations">
          ← All conversations
        </Link>
      </div>

      {escalations.some((escalation) => escalation.status === 'open') ? (
        <div className="error-banner">
          <strong>Flagged for human review.</strong>{' '}
          {escalations
            .filter((escalation) => escalation.status === 'open')
            .map((escalation) => `${escalation.reason.replace(/_/g, ' ')} — ${escalation.detail}`)
            .join(' · ')}
        </div>
      ) : null}

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="panel panel-pad">
            <h2>Transcript</h2>
            <div className="transcript">
              {messages.map((message) => (
                <div key={message.id} className={`bubble ${message.author}`}>
                  <div className="who">
                    {message.author}
                    {message.flagged ? ' · safety hold' : ''}
                    {message.response_ms !== null ? ` · ${(message.response_ms / 1000).toFixed(1)}s` : ''}
                  </div>
                  <div className={/[؀-ۿ]/.test(message.body) ? 'rtl' : ''}>{message.body}</div>
                  <div className="time">{new Date(message.created_at).toLocaleString('en-GB', { timeZone: 'Asia/Riyadh' })}</div>
                </div>
              ))}
              {messages.length === 0 ? <div className="empty">No messages yet.</div> : null}
            </div>
          </div>

          <TakeoverPanel conversationId={conversation.id} owner={conversation.owner} takenOverBy={conversation.taken_over_by} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="panel panel-pad">
            <h3>Patient</h3>
            <table>
              <tbody>
                <tr>
                  <td className="muted">Name</td>
                  <td className="rtl">{patient?.name ?? '—'}</td>
                </tr>
                <tr>
                  <td className="muted">Mobile</td>
                  <td className="mono">{patient?.phone ?? '—'}</td>
                </tr>
                <tr>
                  <td className="muted">Language</td>
                  <td>{patient?.locale === 'en' ? 'English' : 'Arabic'}</td>
                </tr>
                <tr>
                  <td className="muted">First seen</td>
                  <td className="nowrap">{new Date(conversation.created_at).toISOString().slice(0, 10)}</td>
                </tr>
              </tbody>
            </table>
            {patient ? (
              <div className="row" style={{ marginTop: 12 }}>
                <a className="btn sm" href={`/api/proxy/patients/${patient.id}/export`} target="_blank" rel="noreferrer">
                  Export record (PDPL)
                </a>
              </div>
            ) : null}
          </div>

          <div className="panel panel-pad">
            <h3>Appointments</h3>
            <table>
              <tbody>
                {appointments.map((appointment) => (
                  <tr key={appointment.reference}>
                    <td className="mono nowrap">{appointment.reference}</td>
                    <td className="muted">{appointment.service_id}</td>
                    <td className="nowrap">
                      {new Date(appointment.starts_at).toLocaleString('en-GB', {
                        timeZone: 'Asia/Riyadh',
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td>
                      <span className={`tag ${appointment.status === 'booked' ? 'green' : appointment.status === 'cancelled' ? 'red' : 'gray'}`}>
                        {appointment.status}
                      </span>
                    </td>
                  </tr>
                ))}
                {appointments.length === 0 ? (
                  <tr>
                    <td className="empty">No appointments.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          {escalations.length > 0 ? (
            <div className="panel panel-pad">
              <h3>Escalation history</h3>
              <table>
                <tbody>
                  {escalations.map((escalation) => (
                    <tr key={escalation.id}>
                      <td>
                        <span className={`tag ${escalation.status === 'open' ? 'amber' : 'gray'}`}>{escalation.reason.replace(/_/g, ' ')}</span>
                        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                          {escalation.detail}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>
    </Shell>
  );
}
