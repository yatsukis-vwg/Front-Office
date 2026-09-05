import { NextResponse } from 'next/server';
import { sessionValue } from '@/lib/api';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { password?: string; staff?: string };
  const expected = process.env.DASHBOARD_PASSWORD ?? 'demo';

  if (!body.password || body.password !== expected) {
    // Uniform delay so the endpoint cannot be used to probe the password.
    await new Promise((resolve) => setTimeout(resolve, 400));
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  const secure = process.env.NODE_ENV === 'production';
  response.cookies.set('fo_session', sessionValue(), { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 60 * 60 * 12 });
  response.cookies.set('fo_staff', (body.staff || 'dashboard').slice(0, 40), { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 60 * 60 * 12 });
  return response;
}
