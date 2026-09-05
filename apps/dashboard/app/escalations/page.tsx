import Link from 'next/link';
import Shell from '@/components/Shell';
import ResolveButton from '@/components/ResolveButton';
import { adminFetch } from '@/lib/api';
import type { EscalationRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Escalation queue — everything the safety layer or the agent flagged.
 *
 * The reason codes map one-to-one to the rules enforced in
 * packages/core/src/safety, so a member of staff can see exactly which
 * guardrail stopped the agent.
 */

const REASON_COPY: Record<string, { label: string; tone: string; note: string }> = {
  emergency_language: { label: 'Emergency language', tone: 'red', note: 'Patient described an emergency. They were told to call 997 / the urgent line immediately.' },
  medical_advice: { label: 'Medical advice', tone: 'amber', note: 'The agent was about to give clinical guidance. The message was blocked.' },
  symptom_description: { label: 'Symptoms described', tone: 'amber', note: 'Patient described symptoms — the agent did not interpret them.' },
  unpublished_price: { label: 'Price outside the list', tone: 'amber', note: 'A figure was quoted that is not in the published price list. Blocked.' },
  treatment_suitability: { label: 'Individual suitability', tone: 'amber', note: 'The agent was about to say whether a treatment suits this person. Blocked.' },
  outcome_promise: { label: 'Promised outcome', tone: 'amber', note: 'The agent was about to guarantee a result. Blocked.' },
  agent_requested: { label: 'Handover requested', tone: 'gray', note: 'The agent or the patient asked for a human.' },
  agent_error: { label: 'Agent failure', tone: 'gray', note: 'The agent could not produce a safe reply; the holding message was sent.' },
  staff_flagged: { label: 'Flagged by staff', tone: 'gray', note: '' },
};

export default async function EscalationsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const params = await searchParams;
  const status = params.status === 'resolved' ? 'resolved' : 'open';
  const { escalations } = await adminFetch<{ escalations: EscalationRow[] }>(`/escalations?status=${status}`);

  return (
    <Shell active="/escalations">
      <div className="page-head">
        <div>
          <h1>Escalation queue</h1>
          <p>
            Conversations the AI refused to answer on its own. Every one was stopped by an explicit rule in code, not by a
            prompt.
          </p>
        </div>
        <div className="row">
          <Link className={`btn sm${status === 'open' ? ' primary' : ''}`} href="/escalations?status=open">
            Open
          </Link>
          <Link className={`btn sm${status === 'resolved' ? ' primary' : ''}`} href="/escalations?status=resolved">
            Resolved
          </Link>
        </div>
      </div>

      {escalations.length === 0 ? (
        <div className="panel">
          <div className="empty">
            {status === 'open' ? 'Nothing waiting. The agent is handling everything on its own right now.' : 'No resolved escalations yet.'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {escalations.map((escalation) => {
            const copy = REASON_COPY[escalation.reason] ?? { label: escalation.reason, tone: 'gray', note: '' };
            return (
              <div className="panel panel-pad" key={escalation.id}>
                <div className="row">
                  <span className={`tag ${copy.tone}`}>{copy.label}</span>
                  <strong>{escalation.patient_name ?? 'Unknown patient'}</strong>
                  <span className="muted">· {escalation.channel ?? 'unknown channel'}</span>
                  {escalation.owner === 'human' ? <span className="tag amber">human handling</span> : null}
                  <div className="spacer" />
                  <span className="muted nowrap">{new Date(escalation.created_at).toLocaleString('en-GB', { timeZone: 'Asia/Riyadh' })}</span>
                </div>

                {escalation.last_patient_message ? (
                  <div
                    className={`${/[؀-ۿ]/.test(escalation.last_patient_message) ? 'rtl ' : ''}`}
                    style={{ background: '#f8fafc', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px', margin: '12px 0' }}
                  >
                    {escalation.last_patient_message}
                  </div>
                ) : null}

                <div className="muted" style={{ fontSize: 12.5 }}>
                  {copy.note}
                </div>
                <div className="muted mono" style={{ fontSize: 11.5, marginTop: 4 }}>
                  {escalation.detail}
                </div>

                <div className="row" style={{ marginTop: 12 }}>
                  <Link className="btn sm primary" href={`/conversations/${escalation.conversation_id}`}>
                    Open conversation
                  </Link>
                  {escalation.status === 'open' ? <ResolveButton escalationId={escalation.id} /> : null}
                  {escalation.resolved_by ? <span className="muted">Resolved by {escalation.resolved_by}</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Shell>
  );
}
