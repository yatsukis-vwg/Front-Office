'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { KnowledgeBaseDoc } from '@/lib/types';

interface Faq {
  id: string;
  q_ar: string;
  a_ar: string;
  q_en?: string;
  a_en?: string;
  tags: string[];
}

/**
 * Knowledge base editor.
 *
 * FAQs are edited as a structured list — that is the part clinic staff actually
 * change week to week, and they should never have to open a file. Prices,
 * doctors and hours are shown read-only with a raw-JSON escape hatch, because
 * changing those has scheduling consequences and belongs in the YAML under
 * version control.
 *
 * Every save is validated by the API against the same schema the agent loads,
 * so a bad edit is rejected rather than breaking the receptionist.
 */
export default function KbEditor({ initial, source }: { initial: KnowledgeBaseDoc; source: string }) {
  const router = useRouter();
  const [faqs, setFaqs] = useState<Faq[]>(initial.faqs as Faq[]);
  const [tab, setTab] = useState<'faqs' | 'voice' | 'raw'>('faqs');
  const [raw, setRaw] = useState(() => JSON.stringify(initial, null, 2));
  const [agent, setAgent] = useState(initial.agent as Record<string, string>);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string; issues?: { path: string; message: string }[] } | null>(null);

  async function save(document: unknown) {
    setBusy(true);
    setMessage(null);
    const response = await fetch('/api/proxy/kb', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kb: document }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      setMessage({ tone: 'ok', text: 'Saved. The receptionist is using the new content from the next message.' });
      router.refresh();
    } else {
      setMessage({ tone: 'error', text: data.error === 'invalid_kb' ? 'Rejected — the knowledge base failed validation.' : (data.message ?? 'Save failed.'), issues: data.issues });
    }
    setBusy(false);
  }

  async function revert() {
    setBusy(true);
    const response = await fetch('/api/proxy/kb/revert', { method: 'POST' });
    const data = await response.json();
    if (response.ok) {
      setFaqs(data.kb.faqs);
      setAgent(data.kb.agent);
      setRaw(JSON.stringify(data.kb, null, 2));
      setMessage({ tone: 'ok', text: 'Reverted to the clinic file on disk.' });
      router.refresh();
    }
    setBusy(false);
  }

  function updateFaq(index: number, patch: Partial<Faq>) {
    setFaqs((current) => current.map((faq, i) => (i === index ? { ...faq, ...patch } : faq)));
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        {(['faqs', 'voice', 'raw'] as const).map((option) => (
          <button key={option} className={`btn sm${tab === option ? ' primary' : ''}`} onClick={() => setTab(option)}>
            {option === 'faqs' ? `FAQs (${faqs.length})` : option === 'voice' ? 'Agent voice' : 'Raw document'}
          </button>
        ))}
        <div className="spacer" />
        <span className="tag gray">source: {source}</span>
        {source === 'dashboard' ? (
          <button className="btn sm" onClick={revert} disabled={busy}>
            Revert to file
          </button>
        ) : null}
      </div>

      {message ? (
        <div className={message.tone === 'ok' ? 'ok-banner' : 'error-banner'}>
          {message.text}
          {message.issues ? (
            <ul style={{ margin: '8px 0 0', paddingInlineStart: 18 }}>
              {message.issues.map((issue, i) => (
                <li key={i} className="mono">
                  {issue.path}: {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {tab === 'faqs' ? (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {faqs.map((faq, index) => (
              <div className="panel panel-pad" key={faq.id}>
                <div className="row" style={{ marginBottom: 8 }}>
                  <span className="mono muted">{faq.id}</span>
                  <div className="spacer" />
                  {faq.tags.map((tag) => (
                    <span className="tag gray" key={tag}>
                      {tag}
                    </span>
                  ))}
                  <button
                    className="btn sm danger"
                    onClick={() => setFaqs((current) => current.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </div>
                <label className="field">
                  <span>Question (Arabic)</span>
                  <input className="rtl" value={faq.q_ar} onChange={(event) => updateFaq(index, { q_ar: event.target.value })} />
                </label>
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>Answer (Arabic) — the receptionist says this almost verbatim</span>
                  <textarea className="rtl" rows={3} value={faq.a_ar} onChange={(event) => updateFaq(index, { a_ar: event.target.value })} />
                </label>
              </div>
            ))}
          </div>

          <div className="row" style={{ marginTop: 14 }}>
            <button
              className="btn"
              onClick={() =>
                setFaqs((current) => [
                  ...current,
                  { id: `faq_new_${Date.now().toString(36)}`, q_ar: '', a_ar: '', tags: [] },
                ])
              }
            >
              + Add FAQ
            </button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => save({ ...initial, faqs: faqs.filter((faq) => faq.q_ar.trim() && faq.a_ar.trim()) })}
            >
              {busy ? 'Saving…' : 'Save FAQs'}
            </button>
            <span className="muted" style={{ fontSize: 12.5 }}>
              Empty questions or answers are dropped on save.
            </span>
          </div>
        </>
      ) : null}

      {tab === 'voice' ? (
        <div className="panel panel-pad">
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            These strings are sent verbatim — the greeting, the warm holding reply used whenever a message is blocked, and
            the emergency directive. <span className="mono">{'{{ambulance}}'}</span>,{' '}
            <span className="mono">{'{{urgent_line}}'}</span> and <span className="mono">{'{{nearest_er}}'}</span> are
            filled in from the clinic&apos;s contact details.
          </p>
          {(
            [
              ['greeting_ar', 'Greeting (Arabic)'],
              ['greeting_en', 'Greeting (English)'],
              ['holding_reply_ar', 'Holding reply when a message is blocked (Arabic)'],
              ['holding_reply_en', 'Holding reply (English)'],
              ['emergency_reply_ar', 'Emergency directive (Arabic)'],
              ['emergency_reply_en', 'Emergency directive (English)'],
            ] as const
          ).map(([key, label]) => (
            <label className="field" key={key}>
              <span>{label}</span>
              <textarea
                rows={2}
                className={key.endsWith('_ar') ? 'rtl' : ''}
                value={agent[key] ?? ''}
                onChange={(event) => setAgent((current) => ({ ...current, [key]: event.target.value }))}
              />
            </label>
          ))}
          <button className="btn primary" disabled={busy} onClick={() => save({ ...initial, faqs, agent })}>
            {busy ? 'Saving…' : 'Save voice'}
          </button>
        </div>
      ) : null}

      {tab === 'raw' ? (
        <div className="panel panel-pad">
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            The whole knowledge base as JSON — services, prices, doctors, hours, insurance, instructions. Validated on
            save; anything invalid is rejected and the receptionist keeps running on the previous version.
          </p>
          <textarea
            className="mono"
            rows={26}
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            spellCheck={false}
            style={{ direction: 'ltr' }}
          />
          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => {
                try {
                  save(JSON.parse(raw));
                } catch (error) {
                  setMessage({ tone: 'error', text: `Not valid JSON: ${(error as Error).message}` });
                }
              }}
            >
              {busy ? 'Saving…' : 'Save document'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
