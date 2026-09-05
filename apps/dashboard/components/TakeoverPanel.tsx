'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Human takeover.
 *
 * Taking over sets the conversation owner to `human`, which makes the ingest
 * pipeline stop calling the agent for that thread entirely — staff replies go
 * out on whatever channel the patient is using.
 */
export default function TakeoverPanel({
  conversationId,
  owner,
  takenOverBy,
}: {
  conversationId: string;
  owner: 'agent' | 'human';
  takenOverBy: string | null;
}) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function call(path: string, body?: unknown) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/proxy/conversations/${conversationId}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message ?? 'Request failed');
      router.refresh();
      return true;
    } catch (caught) {
      setError((caught as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!body) return;
    // Replying implicitly takes the thread over — the API does that server-side
    // so staff never send a message while the agent is still answering.
    if (await call('reply', { text: body })) setText('');
  }

  return (
    <div className="panel panel-pad">
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Reply as staff</h2>
        <div className="spacer" />
        {owner === 'human' ? (
          <>
            <span className="tag amber">Agent paused · {takenOverBy ?? 'staff'} handling</span>
            <button className="btn sm" disabled={busy} onClick={() => call('release')}>
              Hand back to agent
            </button>
          </>
        ) : (
          <>
            <span className="tag teal">Agent is handling this thread</span>
            <button className="btn sm" disabled={busy} onClick={() => call('takeover')}>
              Take over
            </button>
          </>
        )}
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <form onSubmit={send}>
        <textarea
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="اكتب ردك للمريض… (sending takes the thread over automatically)"
          className={/[؀-ۿ]/.test(text) ? 'rtl' : ''}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" disabled={busy || !text.trim()}>
            {busy ? 'Sending…' : 'Send to patient'}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            Goes out on the patient&apos;s own channel. Staff messages skip the AI entirely.
          </span>
        </div>
      </form>
    </div>
  );
}
