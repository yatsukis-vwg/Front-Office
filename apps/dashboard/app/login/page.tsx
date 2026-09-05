'use client';

import { useState } from 'react';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [staff, setStaff] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password, staff }),
    });
    if (response.ok) {
      const next = new URLSearchParams(window.location.search).get('next') ?? '/metrics';
      window.location.href = next;
    } else {
      setError('Wrong password.');
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>Front Office console</h1>
        <p>Clinic staff sign-in</p>
        {error ? <div className="error-banner">{error}</div> : null}
        <label className="field">
          <span>Your name (for the audit log)</span>
          <input value={staff} onChange={(e) => setStaff(e.target.value)} placeholder="hind" autoComplete="username" />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
