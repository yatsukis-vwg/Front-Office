import Link from 'next/link';
import { adminFetch, CLINIC_SLUG } from '@/lib/api';
import type { EscalationRow } from '@/lib/types';

const NAV = [
  { href: '/metrics', label: 'Metrics', hint: 'The sales page' },
  { href: '/conversations', label: 'Conversations' },
  { href: '/escalations', label: 'Escalations', badgeKey: 'escalations' },
  { href: '/appointments', label: 'Appointments' },
  { href: '/knowledge', label: 'Knowledge base' },
];

/**
 * App shell. Server-rendered so the open-escalation badge is always current —
 * it is the number staff are meant to be watching.
 */
export default async function Shell({ active, children }: { active: string; children: React.ReactNode }) {
  let openEscalations = 0;
  try {
    const data = await adminFetch<{ escalations: EscalationRow[] }>('/escalations?status=open');
    openEscalations = data.escalations.length;
  } catch {
    // The badge is informational; a dead API must not blank the whole console.
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="mark">ن</div>
          <div>
            <strong>Front Office</strong>
            <span>{CLINIC_SLUG}</span>
          </div>
        </div>
        <nav>
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className={`nav${active === item.href ? ' active' : ''}`}>
              <span>{item.label}</span>
              {item.badgeKey === 'escalations' && openEscalations > 0 ? <span className="badge">{openEscalations}</span> : null}
            </Link>
          ))}
        </nav>
        <div className="foot">
          AI receptionist · Arabic-first
          <br />
          Telegram + web chat
          <br />
          <Link href="/api/logout" style={{ color: '#94a3b8', textDecoration: 'underline' }}>
            Sign out
          </Link>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
