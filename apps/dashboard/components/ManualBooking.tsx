'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

interface Slot {
  starts_at: string;
  doctor_id: string;
  doctor_name: string;
  label: string;
}

/**
 * Manual entry — reception taking a booking on the phone or at the desk.
 *
 * It uses the same availability and booking service as the agent, so a manual
 * entry cannot double-book either. `force` lets reception override the notice
 * window when a patient is standing in front of them.
 */
export default function ManualBooking({
  services,
}: {
  services: { id: string; name_ar: string; name_en: string; duration_min: number }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [serviceId, setServiceId] = useState(services[0]?.id ?? '');
  const [date, setDate] = useState(new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slot, setSlot] = useState<string>('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!open || !serviceId || !date) return;
    let cancelled = false;
    setSlots([]);
    setSlot('');
    fetch(`/api/proxy/availability?service_id=${encodeURIComponent(serviceId)}&from=${date}&to=${date}&limit=60`)
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setSlots(data.slots ?? []);
      })
      .catch(() => {
        if (!cancelled) setSlots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, serviceId, date]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const chosen = slots.find((option) => option.starts_at === slot);
    const response = await fetch('/api/proxy/appointments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service_id: serviceId,
        starts_at: slot,
        doctor_id: chosen?.doctor_id,
        patient_name: name,
        patient_phone: phone,
        force,
      }),
    });
    const data = await response.json();
    if (response.ok) {
      setMessage({ tone: 'ok', text: `Booked — reference ${data.reference}, ${data.when}` });
      setName('');
      setPhone('');
      setSlot('');
      router.refresh();
    } else {
      setMessage({ tone: 'error', text: data.message ?? data.error ?? 'Could not book that slot.' });
    }
    setBusy(false);
  }

  if (!open) {
    return (
      <button className="btn primary" onClick={() => setOpen(true)}>
        + Add appointment
      </button>
    );
  }

  return (
    <div className="panel panel-pad" style={{ marginBottom: 14 }}>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Manual booking</h2>
        <div className="spacer" />
        <button className="btn sm" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>

      {message ? <div className={message.tone === 'ok' ? 'ok-banner' : 'error-banner'}>{message.text}</div> : null}

      <form onSubmit={submit}>
        <div className="grid cols-3">
          <label className="field">
            <span>Service</span>
            <select value={serviceId} onChange={(event) => setServiceId(event.target.value)}>
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name_en} · {service.duration_min}m
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Date</span>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <label className="field">
            <span>Time ({slots.length} free)</span>
            <select value={slot} onChange={(event) => setSlot(event.target.value)} required>
              <option value="">Choose a slot…</option>
              {slots.map((option) => (
                <option key={`${option.starts_at}-${option.doctor_id}`} value={option.starts_at}>
                  {new Date(option.starts_at).toLocaleTimeString('en-GB', {
                    timeZone: 'Asia/Riyadh',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}{' '}
                  — {option.doctor_name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid cols-2">
          <label className="field">
            <span>Patient name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} required placeholder="عبدالله السبيعي" />
          </label>
          <label className="field">
            <span>Mobile</span>
            <input value={phone} onChange={(event) => setPhone(event.target.value)} required placeholder="0551234567" />
          </label>
        </div>

        <div className="row">
          <button className="btn primary" disabled={busy || !slot}>
            {busy ? 'Booking…' : 'Book appointment'}
          </button>
          <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
            <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} style={{ width: 'auto' }} />
            Override notice window (walk-in)
          </label>
        </div>
      </form>
    </div>
  );
}
