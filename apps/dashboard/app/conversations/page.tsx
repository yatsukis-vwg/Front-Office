import Link from 'next/link';
import Shell from '@/components/Shell';
import { adminFetch } from '@/lib/api';
import type { ConversationSummary } from '@/lib/types';

export const dynamic = 'force-dynamic';

const CHANNEL_ICON: Record<string, string> = { telegram: '✈️', webchat: '💬', whatsapp: '🟢' };

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; owner?: string; channel?: string }>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.status) query.set('status', params.status);
  if (params.owner) query.set('owner', params.owner);
  if (params.channel) query.set('channel', params.channel);
  query.set('limit', '80');

  const { conversations } = await adminFetch<{ conversations: ConversationSummary[] }>(`/conversations?${query}`);

  return (
    <Shell active="/conversations">
      <div className="page-head">
        <div>
          <h1>Conversations</h1>
          <p>{conversations.length} threads · newest activity first. Open one to read the transcript or take over.</p>
        </div>
      </div>

      <form className="panel panel-pad" method="get" style={{ marginBottom: 14 }}>
        <div className="row">
          <input
            name="q"
            defaultValue={params.q ?? ''}
            placeholder="Search transcripts, patient names and numbers…"
            style={{ flex: 2, minWidth: 240 }}
          />
          <select name="status" defaultValue={params.status ?? ''} style={{ width: 150 }}>
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="escalated">Escalated</option>
            <option value="closed">Closed</option>
          </select>
          <select name="owner" defaultValue={params.owner ?? ''} style={{ width: 150 }}>
            <option value="">Agent or human</option>
            <option value="agent">Agent handling</option>
            <option value="human">Human took over</option>
          </select>
          <select name="channel" defaultValue={params.channel ?? ''} style={{ width: 150 }}>
            <option value="">All channels</option>
            <option value="telegram">Telegram</option>
            <option value="webchat">Web widget</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
          <button className="btn primary">Search</button>
          {params.q || params.status || params.owner || params.channel ? (
            <Link className="btn" href="/conversations">
              Clear
            </Link>
          ) : null}
        </div>
      </form>

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th style={{ width: 40 }} />
              <th>Patient</th>
              <th style={{ width: '38%' }}>Last message</th>
              <th>Status</th>
              <th>Handled by</th>
              <th className="nowrap">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {conversations.map((conversation) => (
              <tr key={conversation.id}>
                <td title={conversation.channel}>{CHANNEL_ICON[conversation.channel] ?? '•'}</td>
                <td>
                  <Link href={`/conversations/${conversation.id}`} style={{ fontWeight: 600 }}>
                    {conversation.patient_name ?? 'Unknown patient'}
                  </Link>
                  <div className="muted mono">{conversation.patient_phone ?? '—'}</div>
                </td>
                <td className={conversation.last_message && /[؀-ۿ]/.test(conversation.last_message.body) ? 'rtl' : ''}>
                  {conversation.last_message ? (
                    <>
                      <span className="muted" style={{ fontSize: 11.5 }}>
                        {conversation.last_message.author}:{' '}
                      </span>
                      {conversation.last_message.body}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <StatusTag conversation={conversation} />
                </td>
                <td>
                  {conversation.owner === 'human' ? (
                    <span className="tag amber">{conversation.taken_over_by ?? 'staff'}</span>
                  ) : (
                    <span className="tag teal">agent</span>
                  )}
                </td>
                <td className="nowrap muted">{relative(conversation.last_message_at)}</td>
              </tr>
            ))}
            {conversations.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  No conversations match those filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}

function StatusTag({ conversation }: { conversation: ConversationSummary }) {
  if (conversation.open_escalations > 0) {
    const emergency = conversation.escalation_reasons.includes('emergency_language');
    return <span className={`tag ${emergency ? 'red' : 'amber'}`}>{emergency ? 'emergency' : 'escalated'}</span>;
  }
  if (conversation.status === 'closed') return <span className="tag gray">closed</span>;
  return <span className="tag green">open</span>;
}

export function relative(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}
