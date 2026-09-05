'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function ResolveButton({ escalationId }: { escalationId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      className="btn sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch(`/api/proxy/escalations/${escalationId}/resolve`, { method: 'POST' });
        router.refresh();
        setBusy(false);
      }}
    >
      {busy ? 'Resolving…' : 'Mark resolved'}
    </button>
  );
}
