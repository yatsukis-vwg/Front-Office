import Shell from '@/components/Shell';
import KbEditor from '@/components/KbEditor';
import { adminFetch, CLINIC_SLUG } from '@/lib/api';
import type { KnowledgeBaseDoc } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function KnowledgePage() {
  const { kb, source, updated_at } = await adminFetch<{ kb: KnowledgeBaseDoc; source: string; updated_at: string | null }>('/kb');

  return (
    <Shell active="/knowledge">
      <div className="page-head">
        <div>
          <h1>Knowledge base</h1>
          <p>
            Everything the receptionist knows about {kb.clinic.name_en}. Edits here take effect on the next message — no
            deploy. The file on disk is <span className="mono">clinics/{CLINIC_SLUG}.yaml</span>
            {updated_at ? ` · last dashboard edit ${new Date(updated_at).toISOString().slice(0, 16).replace('T', ' ')}` : ''}.
          </p>
        </div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="Services" value={String(kb.services.length)} />
        <Stat label="Doctors" value={String(kb.doctors.length)} />
        <Stat label="FAQ answers" value={String(kb.faqs.length)} />
        <Stat label="Average ticket" value={`SAR ${kb.clinic.avg_ticket_sar}`} />
      </div>

      <div className="panel panel-pad" style={{ marginBottom: 16 }}>
        <h3>Published price list — the only figures the agent may quote</h3>
        <table>
          <thead>
            <tr>
              <th>Service</th>
              <th>Price</th>
              <th>Duration</th>
              <th>Doctors</th>
            </tr>
          </thead>
          <tbody>
            {kb.services.map((service) => (
              <tr key={service.id}>
                <td>
                  <div className="rtl">{service.name_ar}</div>
                  <div className="muted mono">{service.id}</div>
                </td>
                <td className="nowrap">
                  {service.price
                    ? service.price.type === 'range'
                      ? `SAR ${service.price.amount}–${service.price.max_amount}`
                      : `${service.price.type === 'from' ? 'from ' : ''}SAR ${service.price.amount}`
                    : <span className="muted">on assessment</span>}
                </td>
                <td className="nowrap">{service.duration_min} min</td>
                <td className="muted mono">{service.doctor_ids.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <KbEditor initial={kb} source={source} />
    </Shell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
